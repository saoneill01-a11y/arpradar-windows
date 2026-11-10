//! The sensor's Bluetooth service (Linux, BlueZ): advertises "ARPradar Sensor" and speaks the protocol in link.rs.
//! Runs as root from systemd (`arpradar-sensor serve`), since joining Wi-Fi needs it.
//!
//! Nothing about a client is kept: a Wi-Fi network given for a scan is joined for that scan only and deleted after,
//! and results only go to the app. The one thing on disk is the owner secret.

use crate::link::{self, Command, Info, Secret};
use crate::{range, scan};
use bluer::adv::Advertisement;
use bluer::gatt::local::{
    characteristic_control, Application, Characteristic, CharacteristicControlEvent, CharacteristicNotify, CharacteristicNotifyMethod,
    CharacteristicRead, CharacteristicWrite, CharacteristicWriteMethod, ReqError, Service,
};
use futures::{FutureExt, StreamExt};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const DIR: &str = "/var/lib/arpradar-sensor";
const OWNER_FILE: &str = "/var/lib/arpradar-sensor/owner";
/// Put an empty file named `reset` (or reset.txt) on the SD card's boot partition to clear the owner.
const BOOT_DIRS: [&str; 2] = ["/boot/firmware", "/boot"];

pub fn load_owner() -> Option<Secret> {
    link::unhex::<32>(std::fs::read_to_string(OWNER_FILE).ok()?.trim())
}

fn save_owner(s: &Secret) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(DIR)?;
    std::fs::write(OWNER_FILE, link::hex(s))?;
    std::fs::set_permissions(OWNER_FILE, std::fs::Permissions::from_mode(0o600))
}

/// Forgets the owner (Release, the SD card reset file, or `arpradar-sensor release`).
pub fn clear_owner() {
    let _ = std::fs::remove_file(OWNER_FILE);
}

/// A `reset` file on the boot partition clears the owner once, then is deleted.
fn reset_from_sd_card() -> bool {
    for dir in BOOT_DIRS {
        let Ok(list) = std::fs::read_dir(dir) else { continue };
        for e in list.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name == "reset" || name == "reset.txt" {
                let _ = std::fs::remove_file(e.path());
                clear_owner();
                return true;
            }
        }
    }
    false
}

fn sensor_id() -> String {
    std::fs::read_to_string("/etc/machine-id").map(|s| s.trim().chars().take(12).collect()).unwrap_or_else(|_| "sensor".into())
}

struct State {
    owner: Option<Secret>,
    /// While not owned: the private half of the key shown in INFO.
    claim: Option<x25519_dalek::StaticSecret>,
    claim_pub: [u8; 32],
    nonce: [u8; 16],
    /// Key of the last accepted command: events are sealed with it.
    key: Option<Secret>,
    busy: bool,
    cancel: Arc<AtomicBool>,
}

impl State {
    fn new_claim_key(&mut self) {
        let (private, public) = link::keypair();
        self.claim = Some(private);
        self.claim_pub = public;
    }
}

fn uuid(s: &str) -> bluer::Uuid {
    s.parse().expect("uuid")
}

pub fn serve() -> Result<(), String> {
    if reset_from_sd_card() {
        eprintln!("Found the reset file on the SD card: no owner now.");
    }
    // Wi-Fi from a scan that was cut short (power pulled): never kept.
    let n = crate::wifi::forget();
    if n > 0 {
        eprintln!("Deleted {n} leftover Wi-Fi network(s).");
    }
    let _ = std::process::Command::new("rfkill").args(["unblock", "bluetooth"]).status();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(run()).map_err(|e| e.to_string())
}

async fn run() -> bluer::Result<()> {
    let session = bluer::Session::new().await?;
    let adapter = session.default_adapter().await?;
    // Right after rfkill unblock, BlueZ can answer "Busy" for a moment while the chip powers up.
    for attempt in 1..=10 {
        match adapter.set_powered(true).await {
            Ok(()) => break,
            Err(e) if attempt < 10 => {
                eprintln!("Bluetooth not ready ({e}); trying again");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => return Err(e),
        }
    }
    adapter.set_alias("ARPradar Sensor".into()).await.ok();
    let _adv = adapter
        .advertise(Advertisement {
            service_uuids: vec![uuid(link::SERVICE)].into_iter().collect(),
            discoverable: Some(true),
            local_name: Some("ARPradar Sensor".into()),
            ..Default::default()
        })
        .await?;

    let owner = load_owner();
    let mut st = State { owner, claim: None, claim_pub: [0; 32], nonce: link::random(), key: None, busy: false, cancel: Arc::new(AtomicBool::new(false)) };
    if st.owner.is_none() {
        st.new_claim_key();
    }
    eprintln!("{}", if st.owner.is_some() { "Owned: only the owner's app can use it." } else { "No owner yet: the first app to connect becomes the owner." });
    let state = Arc::new(Mutex::new(st));
    let id = sensor_id();
    // Plain event JSON goes in here; the events task seals, frames and notifies it.
    let (tx, mut rx) = mpsc::channel::<serde_json::Value>(64);

    let info_state = state.clone();
    let cmd_state = state.clone();
    let cmd_tx = tx.clone();
    let (events_control, events_handle) = characteristic_control();
    let app = Application {
        services: vec![Service {
            uuid: uuid(link::SERVICE),
            primary: true,
            characteristics: vec![
                Characteristic {
                    uuid: uuid(link::INFO),
                    read: Some(CharacteristicRead {
                        read: true,
                        fun: Box::new(move |req| {
                            let st = info_state.clone();
                            let id = id.clone();
                            async move {
                                // A long value is read in pieces: each request asks from `offset` on.
                                let offset = req.offset as usize;
                                let s = st.lock().unwrap();
                                let info = Info {
                                    v: 2,
                                    name: crate::sys::computer_name(),
                                    version: env!("CARGO_PKG_VERSION").into(),
                                    id,
                                    owned: s.owner.is_some(),
                                    claim_pub: s.owner.is_none().then(|| link::hex(&s.claim_pub)),
                                    nonce: link::hex(&s.nonce),
                                    busy: s.busy,
                                };
                                let bytes = serde_json::to_vec(&info).unwrap_or_default();
                                Ok(bytes.get(offset..).map(<[u8]>::to_vec).unwrap_or_default())
                            }
                            .boxed()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                Characteristic {
                    uuid: uuid(link::COMMAND),
                    write: Some(CharacteristicWrite {
                        write: true,
                        method: CharacteristicWriteMethod::Fun(Box::new(move |value, _req| {
                            let st = cmd_state.clone();
                            let tx = cmd_tx.clone();
                            async move { on_write(&st, &value, tx) }.boxed()
                        })),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                Characteristic {
                    uuid: uuid(link::EVENTS),
                    notify: Some(CharacteristicNotify { notify: true, method: CharacteristicNotifyMethod::Io, ..Default::default() }),
                    control_handle: events_handle,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    let _app = adapter.serve_gatt_application(app).await?;
    eprintln!("ARPradar Sensor is advertising on {} ({})", adapter.name(), adapter.address().await?);

    futures::pin_mut!(events_control);
    let mut writer: Option<bluer::gatt::CharacteristicWriter> = None;
    loop {
        tokio::select! {
            ev = events_control.next() => match ev {
                Some(CharacteristicControlEvent::Notify(w)) => { eprintln!("app subscribed (MTU {})", w.mtu()); writer = Some(w); }
                Some(_) => {}
                None => break,
            },
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                let Some(key) = state.lock().unwrap().key else { continue };
                let Some(w) = writer.as_mut() else { continue };
                let sealed = link::seal(&key, &serde_json::to_vec(&msg).unwrap_or_default());
                let mut ok = true;
                for f in link::frames(&sealed, w.mtu().saturating_sub(3).max(20)) {
                    if w.write_all(&f).await.is_err() { ok = false; break; }
                }
                if !ok { eprintln!("app went away"); writer = None; }
            }
        }
    }
    Ok(())
}

/// A write to COMMAND: a claim (no owner yet) or an owner's sealed command.
fn on_write(st: &Arc<Mutex<State>>, value: &[u8], tx: mpsc::Sender<serde_json::Value>) -> Result<(), ReqError> {
    let mut s = st.lock().unwrap();
    if let Some(app_pub) = link::as_claim(value) {
        let Some(private) = s.claim.take().filter(|_| s.owner.is_none()) else {
            eprintln!("refused a claim: already owned");
            return Err(ReqError::NotAuthorized);
        };
        let owner = link::owner_secret(&private, &app_pub);
        if save_owner(&owner).is_err() {
            s.claim = Some(private);
            return Err(ReqError::Failed);
        }
        s.owner = Some(owner);
        s.key = Some(link::key(&owner, &s.nonce));
        s.nonce = link::random();
        eprintln!("claimed: this app is now the owner");
        send(&tx, json!({"type": "claimed"}));
        return Ok(());
    }
    let Some(owner) = s.owner else { return Err(ReqError::NotAuthorized) };
    let cmd = match link::read_command(&owner, &s.nonce, value) {
        Ok(c) => c,
        Err(why) => {
            eprintln!("refused a command: {why}");
            return Err(ReqError::NotAuthorized);
        }
    };
    s.key = Some(link::key(&owner, &s.nonce));
    s.nonce = link::random();
    handle(cmd, &mut s, st, tx);
    Ok(())
}

fn send(tx: &mpsc::Sender<serde_json::Value>, v: serde_json::Value) {
    let _ = tx.try_send(v);
}

/// Acts on an accepted command. Long work runs on its own thread and reports through `tx`.
fn handle(cmd: Command, s: &mut State, shared: &Arc<Mutex<State>>, tx: mpsc::Sender<serde_json::Value>) {
    match cmd {
        Command::Status => {
            let busy = s.busy;
            tokio::task::spawn_blocking(move || {
                let (ssid, ip) = crate::wifi::current();
                send(&tx, json!({"type": "status", "ssid": ssid, "ip": ip, "busy": busy, "version": env!("CARGO_PKG_VERSION")}));
            });
        }
        Command::Networks => {
            tokio::task::spawn_blocking(move || send(&tx, json!({"type": "networks", "networks": crate::wifi::nearby()})));
        }
        Command::Cancel => s.cancel.store(true, Ordering::Relaxed),
        Command::Release => {
            clear_owner();
            s.owner = None;
            s.new_claim_key();
            eprintln!("released: the next app to connect becomes the owner");
            send(&tx, json!({"type": "released"}));
        }
        Command::Scan { range: r, quiet, community, ssid, password } => {
            if s.busy {
                return send(&tx, json!({"type": "error", "text": "A scan is already running."}));
            }
            s.busy = true;
            s.cancel = Arc::new(AtomicBool::new(false));
            let cancel = s.cancel.clone();
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || {
                run_scan(r, quiet, community, ssid, password, cancel, &tx);
                shared.lock().unwrap().busy = false;
                send(&tx, json!({"type": "done"}));
            });
        }
    }
}

/// The one-step scan: join the given Wi-Fi (if any), scan, report, then leave that Wi-Fi and delete it.
fn run_scan(r: Option<String>, quiet: bool, community: Option<String>, ssid: Option<String>, password: Option<String>, cancel: Arc<AtomicBool>, tx: &mpsc::Sender<serde_json::Value>) {
    let progress = |f: f64, t: &str| send(tx, json!({"type": "progress", "fraction": f, "text": t}));
    let joined = ssid.as_deref().filter(|s| !s.trim().is_empty()).map(|s| s.to_string());
    if let Some(ssid) = &joined {
        progress(0.0, &format!("Joining {ssid}\u{2026}"));
        let pw = password.unwrap_or_default();
        if let Err(e) = crate::wifi::join_for_scan(ssid, &pw) {
            crate::wifi::leave_scan_network();
            return send(tx, json!({"type": "error", "text": format!("Couldn\u{2019}t join {ssid}: {e}")}));
        }
    }
    let text = r.filter(|t| !t.trim().is_empty()).or_else(|| if joined.is_some() { crate::wifi::wlan_range() } else { None }).or_else(crate::default_range);
    let result = match text.as_deref().map(range::parse) {
        Some(Ok(targets)) => {
            let text = text.clone().unwrap_or_default();
            progress(0.02, &format!("Scanning {text}\u{2026}"));
            let started = std::time::Instant::now();
            let opts = scan::Options {
                name_server: None,
                snmp_community: community.clone().unwrap_or_else(|| "public".into()),
                quiet,
                snmp_in_quiet: community.is_some(),
            };
            let rows = crate::scan_rows(targets, opts, cancel.clone(), progress);
            Ok(json!({"type": "devices", "range": text, "quiet": quiet, "ssid": joined, "devices": rows,
                      "seconds": (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                      "cancelled": cancel.load(Ordering::Relaxed)}))
        }
        Some(Err(e)) => Err(e),
        None => Err("The sensor isn\u{2019}t on a network. Give it a Wi-Fi network to join.".into()),
    };
    if joined.is_some() {
        crate::wifi::leave_scan_network();
    }
    match result {
        Ok(v) => send(tx, v),
        Err(e) => send(tx, json!({"type": "error", "text": e})),
    }
}
