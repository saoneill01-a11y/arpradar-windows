// Parts of the shared engine files are only used by the Windows window.
#![allow(dead_code)]

//! arpradar-sensor: ARPradar's scan engine with no window, for a Raspberry Pi (or any Linux box) on a client's
//! network. The phone or computer that controls it comes later (Bluetooth for setup, then Wi-Fi); for now it runs
//! from a terminal, which is how it's tested over SSH:
//!
//!   arpradar-sensor scan                 scan this box's own network
//!   arpradar-sensor scan 10.0.0.1-254    scan a range
//!   arpradar-sensor scan --quiet         a Quiet scan (fewer probes)
//!   arpradar-sensor scan --json          one JSON event per line, for programs
//!   arpradar-sensor adapters             this box's network connections
//!
//! The engine files are the Windows app's own (../src-tauri/src), so a fix there fixes the sensor too.

#[path = "../../src-tauri/src/extra.rs"]
mod extra;
#[path = "../../src-tauri/src/identify.rs"]
mod identify;
#[path = "../../src-tauri/src/names.rs"]
mod names;
#[path = "../../src-tauri/src/oui.rs"]
mod oui;
#[path = "../../src-tauri/src/range.rs"]
mod range;
#[path = "../../src-tauri/src/scan.rs"]
mod scan;
#[path = "../../src-tauri/src/sys.rs"]
mod sys;
#[path = "../../src-tauri/src/unifi.rs"]
mod unifi;

mod link;
#[cfg(target_os = "linux")]
mod ble;
#[cfg(target_os = "linux")]
mod wifi;

use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

const HELP: &str = "arpradar-sensor (ARPradar, GNU GPL v3)
  scan [RANGE] [--quiet] [--json] [--community NAME] [--name-server IP]
  serve      (Linux, as root) the Bluetooth service the apps talk to
  release    (Linux, as root) forget the owner app
  adapters
  version";

/// One device as the summary table (and the Bluetooth results) show it.
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub ip: String,
    pub name: String,
    pub mac: String,
    pub vendor: String,
    pub ports: Vec<u16>,
    pub ms: Option<f64>,
    /// The first useful model text (for the terminal table).
    pub model: String,
    /// The same details the apps keep separately.
    pub web: String,
    pub upnp: String,
    pub snmp: String,
    pub snmp_name: String,
    pub ubnt: String,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("scan") => run_scan(&args[1..]),
        Some("adapters") => {
            for a in sys::adapters() {
                println!("{:<16} {:<18} {:<18} {}", a.id.split('|').next().unwrap_or(""), a.address, a.mac, a.suggested_range);
            }
        }
        #[cfg(target_os = "linux")]
        Some("serve") => {
            if let Err(e) = ble::serve() {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        #[cfg(target_os = "linux")]
        Some("release") => {
            ble::clear_owner();
            println!("No owner now: the next app to connect becomes the owner (restart the service: sudo systemctl restart arpradar-sensor).");
        }
        Some("version") | Some("--version") => println!("arpradar-sensor {}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("{HELP}");
            std::process::exit(2);
        }
    }
}

fn value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn run_scan(args: &[String]) {
    let quiet = args.iter().any(|a| a == "--quiet");
    let json = args.iter().any(|a| a == "--json");
    let flags_with_values = ["--community", "--name-server"];
    let range_text = args
        .iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with("--") && !(*i > 0 && flags_with_values.contains(&args[i - 1].as_str())))
        .map(|(_, a)| a.clone())
        .or_else(|| sys::adapters().into_iter().find(|a| !a.address.starts_with("127.")).map(|a| a.suggested_range));
    let Some(range_text) = range_text else {
        eprintln!("No network connection found. Give a range, e.g. arpradar-sensor scan 192.168.1.1-254");
        std::process::exit(1);
    };
    let targets = match range::parse(&range_text) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let community = value(args, "--community");
    let name_server = value(args, "--name-server").and_then(|s| range::ip(&s));
    let opts = scan::Options {
        name_server,
        snmp_community: community.clone().unwrap_or_else(|| "public".into()),
        quiet,
        snmp_in_quiet: community.is_some(),
    };
    if !json {
        eprintln!("Scanning {range_text} ({} addresses){}…", targets.len(), if quiet { ", Quiet" } else { "" });
    }
    let started = std::time::Instant::now();
    let rows: Mutex<BTreeMap<u32, Row>> = Mutex::new(BTreeMap::new());
    let cancel = Arc::new(AtomicBool::new(false));
    scan::run(targets, opts, cancel, |e| {
        if json {
            println!("{}", serde_json::to_string(&e).unwrap_or_default());
            return;
        }
        collect(&rows, e);
    });
    if json {
        return;
    }
    let rows = rows.into_inner().unwrap();
    println!("{:<15}  {:<17}  {:<26}  {:<24}  {:>6}  {}", "IP", "MAC", "Name", "Vendor", "ms", "Ports / model");
    for (ip, r) in &rows {
        let ports = r.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(",");
        let extra = [ports, r.model.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("  ");
        println!(
            "{:<15}  {:<17}  {:<26}  {:<24}  {:>6}  {}",
            range::text(*ip),
            r.mac,
            cut(&r.name, 26),
            cut(&r.vendor, 24),
            r.ms.map(|m| format!("{m:.1}")).unwrap_or_default(),
            extra
        );
    }
    eprintln!("{} devices in {:.1} s", rows.len(), started.elapsed().as_secs_f64());
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n - 1).collect::<String>() + "\u{2026}" }
}

/// Folds the engine's events into one row per device (the same events the Windows window gets).
fn collect(rows: &Mutex<BTreeMap<u32, Row>>, e: scan::ScanEvent) {
    use scan::ScanEvent as E;
    let mut rows = rows.lock().unwrap();
    let mut each = |ip: &str, f: &mut dyn FnMut(&mut Row)| {
        if let Some(k) = range::ip(ip) {
            f(rows.entry(k).or_insert_with(|| Row { ip: ip.to_string(), ..Default::default() }));
        }
    };
    let model = |r: &mut Row, t: &str| {
        let t = t.lines().next().unwrap_or("").trim();
        if r.model.is_empty() && !t.is_empty() {
            r.model = cut(t, 40);
        }
    };
    match e {
        E::Found { devices } => {
            for d in devices {
                each(&d.ip, &mut |r| {
                    if let Some(n) = &d.name { r.name = n.clone(); }
                    if let Some(m) = &d.mac { r.mac = m.clone(); }
                });
            }
        }
        E::Macs { macs } => {
            for (ip, m) in macs {
                each(&ip, &mut |r| { r.mac = m.mac.clone(); r.vendor = m.vendor.clone(); });
            }
        }
        E::Response { ms } => {
            for (ip, v) in ms { each(&ip, &mut |r| r.ms = Some(v)); }
        }
        E::Ports { ports } => {
            for (ip, p) in ports { each(&ip, &mut |r| r.ports = p.clone()); }
        }
        E::Names { names, .. } => {
            for (ip, n) in names { each(&ip, &mut |r| if r.name.is_empty() { r.name = n.clone(); }); }
        }
        E::Upnp { info } => {
            for (ip, i) in info { each(&ip, &mut |r| { r.upnp = i.model.clone(); model(r, &i.model) }); }
        }
        E::Snmp { info } => {
            for (ip, i) in info { each(&ip, &mut |r| { r.snmp = i.descr.clone(); r.snmp_name = i.name.clone(); model(r, &i.descr) }); }
        }
        E::Ubiquiti { info } => {
            for (ip, i) in info { each(&ip, &mut |r| { r.ubnt = i.model.clone(); model(r, &i.model) }); }
        }
        E::WebTitles { titles } => {
            for (ip, t) in titles { each(&ip, &mut |r| { r.web = t.clone(); model(r, &t) }); }
        }
        _ => {}
    }
}

/// This box's own network (the first non-loopback adapter's suggested range).
pub fn default_range() -> Option<String> {
    sys::adapters().into_iter().find(|a| !a.address.starts_with("127.")).map(|a| a.suggested_range)
}

/// Runs a scan and returns one row per device; `progress` gets the engine's progress text as it goes.
pub fn scan_rows(targets: Vec<u32>, opts: scan::Options, cancel: Arc<AtomicBool>, progress: impl Fn(f64, &str) + Sync) -> Vec<Row> {
    let rows: Mutex<BTreeMap<u32, Row>> = Mutex::new(BTreeMap::new());
    scan::run(targets, opts, cancel, |e| {
        if let scan::ScanEvent::Progress { fraction, text } = &e {
            progress(*fraction, text);
        }
        collect(&rows, e);
    });
    rows.into_inner().unwrap().into_values().collect()
}
