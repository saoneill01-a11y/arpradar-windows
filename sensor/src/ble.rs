//! The sensor's Bluetooth service (Linux, BlueZ): advertises "ARPradar Sensor" and speaks the protocol in link.rs.
//! Runs as root from systemd (`arpradar-sensor serve`), since joining Wi-Fi needs it.

use crate::link::{self, Command, Info};
use crate::{range, scan};
use bluer::adv::Advertisement;
use bluer::gatt::local::{
    characteristic_control, Application, Characteristic, CharacteristicControlEvent, CharacteristicNotify, CharacteristicNotifyMethod,
    CharacteristicRead, CharacteristicWrite, CharacteristicWriteMethod, Service,
};
use futures::{FutureExt, StreamExt};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use std::sync::Mutex;
use tokio::sync::mpsc;

const CODE_FILE: &str = "/var/lib/arpradar-sensor/setup-code";

/// The setup code on the label: read from disk, made on first run.
pub fn setup_code() -> std::io::Result<String> {
    if let Ok(c) = std::fs::read_to_string(CODE_FILE) {
        if link::normalize_code(&c).len() == 12 {
            return Ok(c.trim().to_string());
        }
    }
    let c = link::new_setup_code();
    std::fs::create_dir_all("/var/lib/arpradar-sensor")?;
    std::fs::write(CODE_FILE, format!("{c}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(CODE_FILE, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(c)
}

struct State {
    code: String,
    nonce: [u8; 16],
    /// Key of the last accepted command: events are sealed with it.
    key: Option<[u8; 32]>,
    busy: bool,
    cancel: Arc<AtomicBool>,
}

fn uuid(s: &str) -> bluer::Uuid {
    s.parse().expect("uuid")
}

pub fn serve() -> Result<(), String> {
    let code = setup_code().map_err(|e| format!("Couldn\u{2019}t read or save the setup code: {e} (run as root)"))?;
    let _ = std::process::Command::new("rfkill").args(["unblock", "bluetooth"]).status();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(run(code)).map_err(|e| e.to_string())
}

async fn run(code: String) -> bluer::Result<()> {
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

    let state = Arc::new(Mutex::new(State { code, nonce: link::new_nonce(), key: None, busy: false, cancel: Arc::new(AtomicBool::new(false)) }));
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
                        fun: Box::new(move |_req| {
                            let st = info_state.clone();
                            async move {
                                let s = st.lock().unwrap();
                                let info = Info {
                                    v: 1,
                                    name: crate::sys::computer_name(),
                                    version: env!("CARGO_PKG_VERSION").into(),
                                    nonce: link::hex(&s.nonce),
                                    busy: s.busy,
                                };
                                Ok(serde_json::to_vec(&info).unwrap_or_default())
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
                            async move {
                                let mut s = st.lock().unwrap();
                                let cmd = match link::read_command(&s.code, &s.nonce, &value) {
                                    Ok(c) => c,
                                    Err(why) => {
                                        eprintln!("refused a command: {why}");
                                        return Err(bluer::gatt::local::ReqError::NotAuthorized);
                                    }
                                };
                                s.key = Some(link::key(&s.code, &s.nonce));
                                s.nonce = link::new_nonce();
                                handle(cmd, &mut s, &st, tx);
                                Ok(())
                            }
                            .boxed()
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

fn send(tx: &mpsc::Sender<serde_json::Value>, v: serde_json::Value) {
    let _ = tx.try_send(v);
}

/// Acts on an accepted command. Long work (Wi-Fi, scans) runs on its own thread and reports through `tx`.
fn handle(cmd: Command, s: &mut State, shared: &Arc<Mutex<State>>, tx: mpsc::Sender<serde_json::Value>) {
    match cmd {
        Command::Status => send(&tx, status(s.busy)),
        Command::Cancel => s.cancel.store(true, Ordering::Relaxed),
        Command::Forget => {
            let n = crate::wifi::forget();
            send(&tx, json!({"type": "forgot", "count": n}));
        }
        Command::Wifi { ssid, password } => {
            tokio::task::spawn_blocking(move || {
                let r = crate::wifi::join(&ssid, &password);
                let (now_ssid, ip) = crate::wifi::current();
                send(&tx, match r {
                    Ok(()) => json!({"type": "wifi", "ok": true, "ssid": now_ssid, "ip": ip}),
                    Err(e) => json!({"type": "wifi", "ok": false, "error": e, "ssid": now_ssid, "ip": ip}),
                });
            });
        }
        Command::Scan { range: r, quiet, community } => {
            if s.busy {
                return send(&tx, json!({"type": "error", "text": "A scan is already running."}));
            }
            let text = r.or_else(crate::default_range).unwrap_or_default();
            let targets = match range::parse(&text) {
                Ok(t) => t,
                Err(e) => return send(&tx, json!({"type": "error", "text": e})),
            };
            s.busy = true;
            s.cancel = Arc::new(AtomicBool::new(false));
            let cancel = s.cancel.clone();
            let opts = scan::Options {
                name_server: None,
                snmp_community: community.clone().unwrap_or_else(|| "public".into()),
                quiet,
                snmp_in_quiet: community.is_some(),
            };
            send(&tx, json!({"type": "progress", "fraction": 0.0, "text": format!("Scanning {text}\u{2026}")}));
            let started = std::time::Instant::now();
            let busy_tx = tx.clone();
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || {
                let rows = crate::scan_rows(targets, opts, cancel.clone(), |f, t| send(&busy_tx, json!({"type": "progress", "fraction": f, "text": t})));
                send(&tx, json!({"type": "devices", "range": text, "quiet": quiet, "devices": rows,
                                  "seconds": (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                                  "cancelled": cancel.load(Ordering::Relaxed)}));
                shared.lock().unwrap().busy = false;
                send(&tx, json!({"type": "done"}));
            });
        }
    }
}

fn status(busy: bool) -> serde_json::Value {
    let (ssid, ip) = crate::wifi::current();
    json!({"type": "status", "ssid": ssid, "ip": ip, "busy": busy, "version": env!("CARGO_PKG_VERSION")})
}
