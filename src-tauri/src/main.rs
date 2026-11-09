// Hide the black console window behind the app in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod dns;
mod web;
mod extra;
mod identify;
mod names;
mod netinfo;
mod oui;
mod portscan;
mod range;
mod scan;
mod snmpwalk;
mod sys;
mod tools;
mod unifi;
mod wifi;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
struct AppInfo {
    version: String,
    os: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION").to_string(), os: std::env::consts::OS.to_string() }
}

#[tauri::command]
fn list_adapters() -> Vec<sys::Adapter> {
    sys::adapters()
}

/// The address spans in an IP range, for the window to tell which addresses a scan covered.
#[tauri::command]
fn parse_range(text: String) -> Result<Vec<(u32, u32)>, String> {
    range::spans(&text)
}

/// The scan that's running, if any: its Stop switch.
#[derive(Default)]
struct Running(Mutex<Option<Arc<AtomicBool>>>);

/// Starts a scan in the background; progress arrives as "scan" events. Returns the number of addresses.
#[tauri::command]
fn start_scan(app: tauri::AppHandle, state: tauri::State<Running>, range: String, name_server: Option<String>, snmp_community: Option<String>, quiet: Option<bool>, snmp_in_quiet: Option<bool>, token: Option<u64>) -> Result<usize, String> {
    let targets = range::parse(&range)?;
    let server = match name_server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(range::ip(s).ok_or_else(|| format!("\u{201c}{s}\u{201d} isn\u{2019}t a valid name server address."))?),
        None => None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.0.lock().unwrap();
        if let Some(old) = running.take() {
            old.store(true, Ordering::Relaxed);
        }
        *running = Some(cancel.clone());
    }
    let count = targets.len();
    std::thread::spawn(move || {
        // Every event carries the window's scan number, so a stopped scan's last events can't land in the next one.
        let token = token.unwrap_or(0);
        scan::run(targets, scan::Options {
            name_server: server,
            snmp_community: snmp_community.unwrap_or_else(|| "public".into()),
            quiet: quiet.unwrap_or(false),
            snmp_in_quiet: snmp_in_quiet.unwrap_or(false),
        }, cancel, |e| {
            let mut v = serde_json::to_value(&e).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("token".into(), token.into());
            }
            let _ = app.emit("scan", v);
        });
    });
    Ok(count)
}

// MARK: UniFi controller (Map tab)

/// GET one path on a UniFi controller. The key is the one saved for `id` (Credential Manager), or `key` while testing.
#[tauri::command]
async fn unifi_get(address: String, path: String, id: Option<String>, key: Option<String>, fingerprint: Option<String>) -> Result<unifi::Reply, String> {
    let key = match key.filter(|k| !k.trim().is_empty()) {
        Some(k) => k.trim().to_string(),
        None => id.as_deref().and_then(unifi::key_get).ok_or_else(|| "The API key isn\u{2019}t saved on this PC. Open UniFi Controller\u{2026} and enter it again.".to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || unifi::get(&address, &path, &key, fingerprint.as_deref())).await.map_err(|e| e.to_string())?
}
/// A scan device that answered SNMP, to read as a possible managed switch for the map.
#[derive(serde::Deserialize)]
struct SnmpCandidate {
    ip: String,
    #[serde(default)]
    mac: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    descr: String,
}

#[derive(serde::Serialize)]
struct SnmpSwitches {
    switches: Vec<snmpwalk::SwitchData>,
    /// One line per device, for the map's Details.
    log: Vec<String>,
}

/// The map's SNMP switches: reads each candidate's bridge ports, MAC table and LLDP neighbours, 6 at a time, with the
/// scan's own community. Devices that aren't switches are left out (and say so in the log).
#[tauri::command]
async fn snmp_switches(devices: Vec<SnmpCandidate>, community: String) -> SnmpSwitches {
    tauri::async_runtime::spawn_blocking(move || {
        let never = std::sync::atomic::AtomicBool::new(false);
        let found = scan::par_map(&devices, 6, &never, |d| {
            let ip = range::ip(&d.ip)?;
            let mut log = Vec::new();
            let sw = snmpwalk::read(std::net::Ipv4Addr::from(ip), &d.mac, &d.name, &d.descr, &community, 161, &mut log);
            Some((sw, log))
        });
        let mut out = SnmpSwitches { switches: Vec::new(), log: Vec::new() };
        for (sw, log) in found {
            out.switches.extend(sw);
            out.log.extend(log);
        }
        out.log.sort();
        out.switches.sort_by(|a, b| a.ip.cmp(&b.ip));
        out
    })
    .await
    .unwrap_or(SnmpSwitches { switches: Vec::new(), log: Vec::new() })
}

#[tauri::command]
fn unifi_key_save(id: String, key: String) -> Result<(), String> {
    unifi::key_set(&id, key.trim())
}
#[tauri::command]
fn unifi_key_has(id: String) -> bool {
    unifi::key_get(&id).is_some()
}
#[tauri::command]
fn unifi_key_delete(id: String) {
    unifi::key_delete(&id)
}

#[tauri::command]
fn stop_scan(state: tauri::State<Running>) {
    if let Some(c) = state.0.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

// MARK: Details panel, Scan Ports, right-click actions

fn ip_arg(ip: &str) -> Result<u32, String> {
    range::ip(ip).ok_or_else(|| format!("\u{201c}{ip}\u{201d} isn\u{2019}t an IP address."))
}

/// What answers on each open port, read when the details panel opens.
#[tauri::command]
async fn device_banners(ip: String, ports: Vec<u16>) -> Result<std::collections::HashMap<u16, String>, String> {
    let ip = ip_arg(&ip)?;
    tauri::async_runtime::spawn_blocking(move || identify::banners(ip, &ports, std::time::Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())
}

/// The device's web page title, read when the details panel opens (a quiet scan skips web pages).
#[tauri::command]
async fn device_web_title(ip: String, ports: Vec<u16>) -> Result<Option<String>, String> {
    let ip = ip_arg(&ip)?;
    tauri::async_runtime::spawn_blocking(move || {
        let map = std::collections::HashMap::from([(ip, ports)]);
        identify::web_titles(&map, &std::sync::atomic::AtomicBool::new(false)).remove(&ip).map(|t| identify::clean_text(&t, 120))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_shares(ip: String) -> Result<extra::Shares, String> {
    ip_arg(&ip)?;
    tauri::async_runtime::spawn_blocking(move || extra::shares(&ip)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn common_ports() -> Vec<(u16, &'static str)> {
    portscan::COMMON.to_vec()
}

#[derive(Default)]
struct PortScans(Mutex<std::collections::HashMap<u32, Arc<AtomicBool>>>);

/// mode: "common", "all" or "list" (with `list` like "1-1024, 8080"). Results arrive as "portscan" events.
#[tauri::command]
fn port_scan_start(app: tauri::AppHandle, state: tauri::State<PortScans>, id: u32, ip: String, mode: String, list: Option<String>) -> Result<usize, String> {
    let ip = ip_arg(&ip)?;
    let ports: Vec<u16> = match mode.as_str() {
        "all" => (1..=65535).collect(),
        "list" => portscan::parse_list(list.as_deref().unwrap_or("")).ok_or("Use port numbers 1\u{2013}65535, like 1-1024, 8080")?,
        _ => portscan::COMMON.iter().map(|p| p.0).collect(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state.0.lock().unwrap().insert(id, cancel.clone());
    let count = ports.len();
    std::thread::spawn(move || {
        portscan::run(id, ip, ports, &cancel, |e| {
            let _ = app.emit("portscan", e);
        });
        app.state::<PortScans>().0.lock().unwrap().remove(&id);
    });
    Ok(count)
}

#[tauri::command]
fn port_scan_stop(state: tauri::State<PortScans>, id: u32) {
    if let Some(c) = state.0.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

/// Opens a device in another program: kind = web, shares, share, ssh, rdp, vnc.
#[tauri::command]
fn open_device(kind: String, target: String) -> Result<(), String> {
    extra::open(&kind, &target)
}

#[tauri::command]
fn wake_on_lan(macs: Vec<String>) -> Result<usize, String> {
    extra::wake(&macs)
}

// MARK: Tools (each in its own window)

const TOOLS: &[(&str, &str, f64, f64)] = &[
    ("ping", "Ping", 760.0, 560.0),
    ("trace", "Traceroute", 720.0, 560.0),
    ("dns", "DNS Lookup", 860.0, 620.0),
    ("wifi", "Wi-Fi Signal", 640.0, 560.0),
    ("analyzer", "Wi-Fi Analyzer", 900.0, 680.0),
    ("connection", "Connection Info", 560.0, 620.0),
    ("speed", "Speed Test", 640.0, 600.0),
    ("subnet", "Subnet Calculator", 520.0, 520.0),
    ("remotewake", "Wake Remote PC", 860.0, 600.0),
    ("settings", "ARPradar Settings", 620.0, 560.0),
    ("orgs", "Organizations", 1000.0, 640.0),
    ("help", "ARPradar Help", 900.0, 620.0),
    ("ports", "Scan Ports", 760.0, 580.0),
];

/// Opens a tool's window (or brings it forward), optionally filled in with `arg` (an IP from the device list).
pub fn open_tool_window(app: &tauri::AppHandle, tool: &str, arg: Option<String>) -> Result<(), String> {
    let &(key, title, w, h) = TOOLS.iter().find(|t| t.0 == tool).ok_or("Unknown tool")?;
    // Scan Ports gets a window per device (its arg is {"ip": …, "name": …, "ports": […]}), so several can run at once.
    let ports_ip = (key == "ports")
        .then(|| arg.as_deref().and_then(|a| serde_json::from_str::<serde_json::Value>(a).ok()).and_then(|v| v["ip"].as_str().and_then(range::ip)))
        .flatten();
    let label = match ports_ip {
        Some(ip) => format!("tool-ports-{}", range::text(ip).replace('.', "-")),
        None => format!("tool-{key}"),
    };
    let title = match ports_ip {
        Some(ip) => format!("{title} \u{b7} {}", range::text(ip)),
        None => title.to_string(),
    };
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(a) = arg {
            let _ = app.emit_to(label.as_str(), "tool-arg", a);
        }
        return Ok(());
    }
    let init = format!("window.__TOOL__ = {};", serde_json::json!({ "tool": key, "arg": arg }));
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("tool.html".into()))
        .title(&title)
        .inner_size(w, h)
        .min_inner_size(420.0, 360.0)
        .initialization_script(&init)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Async on purpose: creating a window from a plain command can freeze on Windows.
#[tauri::command]
async fn open_tool(app: tauri::AppHandle, tool: String, arg: Option<String>) -> Result<(), String> {
    open_tool_window(&app, &tool, arg)
}

/// Names (or IPs) typed in Ping -> their IPv4 addresses (null when a name can't be found).
#[tauri::command]
async fn resolve_names(names: Vec<String>) -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || names.iter().map(|n| tools::resolve(n).map(|a| a.to_string())).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn ping_round(ips: Vec<String>, timeout_ms: u32) -> std::collections::HashMap<String, Option<f64>> {
    let list: Vec<u32> = ips.iter().filter_map(|i| range::ip(i)).collect();
    tauri::async_runtime::spawn_blocking(move || tools::ping_round(&list, timeout_ms)).await.unwrap_or_default()
}

#[derive(Default)]
struct Jobs(Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>);
impl Jobs {
    fn start(&self, key: &str) -> Arc<AtomicBool> {
        let c = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.0.lock().unwrap().insert(key.to_string(), c.clone()) {
            old.store(true, Ordering::Relaxed);
        }
        c
    }
    fn stop(&self, key: &str) {
        if let Some(c) = self.0.lock().unwrap().get(key) {
            c.store(true, Ordering::Relaxed);
        }
    }
}

/// Traceroute: hops arrive as "trace" events ({kind: hop|done|failed}).
#[tauri::command]
fn trace_start(app: tauri::AppHandle, jobs: tauri::State<Jobs>, target: String, run: Option<u64>) -> Result<(), String> {
    let cancel = jobs.start("trace");
    // Every event carries the run number, so the window can drop what an older (stopped or replaced) run sends.
    let run = run.unwrap_or(0);
    std::thread::spawn(move || {
        let Some(ip) = tools::resolve(&target) else {
            let _ = app.emit("trace", serde_json::json!({ "run": run, "kind": "failed", "message": format!("Couldn\u{2019}t find {target}. Is the name right?") }));
            return;
        };
        let _ = app.emit("trace", serde_json::json!({ "run": run, "kind": "resolved", "address": ip.to_string() }));
        let n = tools::trace(u32::from(ip), &cancel, |h| {
            let _ = app.emit("trace", serde_json::json!({ "run": run, "kind": "hop", "hop": h }));
        });
        let _ = app.emit("trace", serde_json::json!({ "run": run, "kind": "done", "hops": n, "cancelled": cancel.load(Ordering::Relaxed) }));
    });
    Ok(())
}

/// Traceroute run to the end, all hops returned at once (the site survey uses this; no events).
#[tauri::command]
async fn trace_collect(target: String) -> Result<Vec<tools::Hop>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ip = tools::resolve(&target).ok_or(format!("Couldn\u{2019}t find {target}."))?;
        let never = AtomicBool::new(false);
        let hops = std::sync::Mutex::new(Vec::new());
        tools::trace(u32::from(ip), &never, |h| hops.lock().unwrap().push(h));
        Ok(hops.into_inner().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn job_stop(jobs: tauri::State<Jobs>, key: String) {
    jobs.stop(&key);
}

#[tauri::command]
async fn dns_lookup(name: String, kind: String, server: String) -> Result<dns::Reply, String> {
    if !web::host_name_ok(&name) {
        return Err(web::BAD_HOST.into());
    }
    tauri::async_runtime::spawn_blocking(move || dns::lookup(&name, &kind, &server)).await.map_err(|e| e.to_string())?
}

/// DNS Lookup › Reverse Subnet: a PTR question for every address (up to 4,096), all from one UDP socket, to the
/// server given (else this PC's DNS server). Returns (ip, name) for every address, name blank when there's none.
#[tauri::command]
async fn reverse_subnet(range: String, server: String) -> Result<Vec<(String, String)>, String> {
    let ips: Vec<u32> = range::parse(&range)?.into_iter().take(4096).collect();
    let server = match server.trim() {
        "" => match dns::system_server() {
            Some(std::net::IpAddr::V4(v)) => u32::from(v),
            _ => return Err("Couldn\u{2019}t find this PC\u{2019}s DNS server. Enter one.".into()),
        },
        s => range::ip(s).ok_or_else(|| format!("\u{201c}{s}\u{201d} isn\u{2019}t a valid name server address."))?,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let never = std::sync::atomic::AtomicBool::new(false);
        let found = names::dns_ptr(&ips, server, std::time::Duration::from_secs(3), &never);
        ips.iter().map(|ip| (range::text(*ip), found.get(ip).cloned().unwrap_or_default())).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn dns_default_server() -> Option<String> {
    dns::system_server().map(|a| a.to_string())
}

#[tauri::command]
async fn connection_info(id: String) -> Option<netinfo::ConnectionInfo> {
    tauri::async_runtime::spawn_blocking(move || netinfo::read(&id)).await.ok().flatten()
}

#[tauri::command]
async fn renew_dhcp(adapter: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || netinfo::renew(&adapter)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn public_ip() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(tools::public_ip).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wifi_status() -> wifi::Status {
    tauri::async_runtime::spawn_blocking(wifi::status).await.unwrap_or_default()
}

#[tauri::command]
async fn wifi_scan() -> Result<Vec<wifi::Network>, String> {
    tauri::async_runtime::spawn_blocking(wifi::scan).await.map_err(|e| e.to_string())?
}

/// Opens Windows' Location settings (Wi-Fi names need "Let desktop apps access your location").
#[tauri::command]
fn open_location_settings() -> Result<(), String> {
    open::that_detached("ms-settings:privacy-location").map_err(|e| e.to_string())
}

/// Speed Test: progress arrives as "speed" events.
#[tauri::command]
fn speed_start(app: tauri::AppHandle, jobs: tauri::State<Jobs>, event: Option<String>) {
    // The Speed Test window listens on "speed"; the site survey uses its own channel.
    let event = event.filter(|e| e == "survey-speed").unwrap_or_else(|| "speed".into());
    let cancel = jobs.start(&event);
    std::thread::spawn(move || {
        tools::speed_test(cancel, |e| {
            let _ = app.emit(&event, e);
        });
    });
}

/// The Organizations window (and Save to Organization) asking the main window to do something:
/// "new-org", "run-survey" (org id), "open-site" (saved scan id), "new-scan-for-org" (org id), "detach-org" (org id).
#[tauri::command]
fn org_action(app: tauri::AppHandle, action: String, value: String) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("The main window is closed.")?;
    if action != "detach-org" {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    app.emit_to("main", "org-action", serde_json::json!({ "action": action, "value": value })).map_err(|e| e.to_string())
}

/// Subnet Calculator's "Scan This Range": hands the range to the main window.
#[tauri::command]
fn scan_range_in_main(app: tauri::AppHandle, range: String) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("The main window is closed.")?;
    let _ = main.unminimize();
    let _ = main.set_focus();
    app.emit_to("main", "scan-range", range).map_err(|e| e.to_string())
}

// MARK: DNS Lookup's Expiry tab and Find subdomains (they ask rdap.org / crt.sh / the hosts themselves)

#[tauri::command]
async fn rdap_lookup(domain: String) -> Result<web::Registration, String> {
    tauri::async_runtime::spawn_blocking(move || web::rdap(&domain)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn cert_check(host: String, port: u16) -> Result<web::Cert, String> {
    tauri::async_runtime::spawn_blocking(move || web::cert(&host, port)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn find_subdomains(domain: String) -> Result<(Vec<String>, String), String> {
    tauri::async_runtime::spawn_blocking(move || web::subdomains(&domain)).await.map_err(|e| e.to_string())?
}

// MARK: Remote wake, tray, notifications

#[tauri::command]
async fn remote_wake_send(mac: String, destinations: Vec<String>, port: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || desktop::remote_wake(&mac, &destinations, port)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn is_awake(ip: String) -> Result<bool, String> {
    let ip: std::net::Ipv4Addr = ip.parse().map_err(|_| "Not an IP address".to_string())?;
    tauri::async_runtime::spawn_blocking(move || desktop::is_awake(ip)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn set_tray(app: tauri::AppHandle, on: bool, keep_running: bool) -> Result<(), String> {
    desktop::set_tray(&app, on, keep_running)
}

#[tauri::command]
fn tray_status(app: tauri::AppHandle, text: String, scanning: bool) -> Result<(), String> {
    desktop::tray_status(&app, &text, scanning)
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

// MARK: Saved data (data.json in the app's folder, e.g. %APPDATA%\com.arpradar.desktop)

fn data_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    named_file(app, "data")
}

/// The app's own files: data.json (scans, favorites, history) and remote-wake.json (saved PCs to wake).
fn named_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if !["data", "remote-wake", "organizations", "unifi"].contains(&name) {
        return Err(format!("Unknown file {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
fn load_file(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(named_file(&app, &name)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Async (a worker thread), so a big file never holds up the window.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, name: String, json: String) -> Result<(), String> {
    let f = named_file(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || write_atomically(&f, &json)).await.map_err(|e| e.to_string())?
}

/// Writes to a temporary file first, so a crash mid-save never leaves half a file.
fn write_atomically(f: &std::path::Path, json: &str) -> Result<(), String> {
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, f).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let f = data_file(&app)?;
    match std::fs::read_to_string(&f) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Written on a worker thread (async command), never on the window's own thread.
#[tauri::command]
async fn save_data(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_atomically(&f, &json)).await.map_err(|e| e.to_string())?
}

/// Keeps a copy of a file the window couldn't read (data.json, or `name`.json), and returns where the copy is.
#[tauri::command]
fn keep_unreadable_data(app: tauri::AppHandle, name: Option<String>) -> Result<String, String> {
    let f = match name.as_deref() {
        Some(n) => named_file(&app, n)?,
        None => data_file(&app)?,
    };
    let copy = f.with_extension("unreadable.json");
    std::fs::copy(&f, &copy).map_err(|e| e.to_string())?;
    Ok(copy.display().to_string())
}

// MARK: Export

fn ask_where(app: &tauri::AppHandle, file_name: &str, kind: &str, ext: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_file_name(file_name)
        .add_filter(kind, &[ext])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}

/// File › Export Scans…: asks where to save, then writes the .arpradar file. Returns the path, or None if cancelled.
#[tauri::command]
async fn save_scans_file(app: tauri::AppHandle, file_name: String, content: String) -> Result<Option<String>, String> {
    let Some(path) = ask_where(&app, &file_name, "ARPradar scans", "arpradar") else { return Ok(None) };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// File › Import Scans…: asks for a .arpradar file and returns (file name, its text), or None if cancelled.
#[tauri::command]
async fn open_scans_file(app: tauri::AppHandle) -> Result<Option<(String, String)>, String> {
    let Some(path) = app.dialog().file().add_filter("ARPradar scans", &["arpradar", "json"]).blocking_pick_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 200 * 1024 * 1024 {
        return Err("That file is too big to be an ARPradar scans file.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|_| "Couldn\u{2019}t read that file.".to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some((name, text)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sheet {
    name: String,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    #[serde(default)]
    widths: Vec<f64>,
    #[serde(default)]
    number_columns: Vec<usize>,
}

/// Excel sheet names: at most 31 characters, none of []:*?/\, and unique in the workbook.
fn sheet_name(raw: &str, used: &mut std::collections::HashSet<String>) -> String {
    let clean: String = raw.chars().map(|c| if "[]:*?/\\".contains(c) { '-' } else { c }).collect();
    let base: String = clean.trim().chars().take(31).collect();
    let base = if base.is_empty() { "Sheet".to_string() } else { base };
    let mut name = base.clone();
    let mut n = 2;
    while used.contains(&name.to_lowercase()) {
        let tail = format!(" ({n})");
        name = format!("{}{tail}", base.chars().take(31 - tail.len()).collect::<String>());
        n += 1;
    }
    used.insert(name.to_lowercase());
    name
}

/// Export Organization (Excel): one workbook, a sheet per saved item, bold frozen headers with filters.
/// Number columns are written as numbers when they look like one.
#[tauri::command]
async fn export_workbook(app: tauri::AppHandle, file_name: String, sheets: Vec<Sheet>) -> Result<Option<String>, String> {
    let Some(path) = ask_where(&app, &file_name, "Excel workbook", "xlsx") else { return Ok(None) };
    let e = |e: rust_xlsxwriter::XlsxError| e.to_string();
    let mut book = rust_xlsxwriter::Workbook::new();
    let bold = rust_xlsxwriter::Format::new().set_bold();
    let wrap = rust_xlsxwriter::Format::new().set_text_wrap().set_align(rust_xlsxwriter::FormatAlign::Top);
    let mut used = std::collections::HashSet::new();
    for sh in &sheets {
        let ws = book.add_worksheet();
        ws.set_name(sheet_name(&sh.name, &mut used)).map_err(e)?;
        for (c, h) in sh.header.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, h, &bold).map_err(e)?;
        }
        for (r, row) in sh.rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                let (rr, cc) = ((r + 1) as u32, c as u16);
                match v.parse::<f64>() {
                    Ok(n) if sh.number_columns.contains(&c) => ws.write_number(rr, cc, n).map(|_| ()),
                    _ if v.contains('\n') => ws.write_string_with_format(rr, cc, v, &wrap).map(|_| ()),
                    _ => ws.write_string(rr, cc, v).map(|_| ()),
                }
                .map_err(e)?;
            }
        }
        for (c, w) in sh.widths.iter().enumerate() {
            ws.set_column_width(c as u16, *w).map_err(e)?;
        }
        if !sh.header.is_empty() {
            ws.set_freeze_panes(1, 0).map_err(e)?;
            ws.autofilter(0, 0, sh.rows.len() as u32, (sh.header.len() - 1) as u16).map_err(e)?;
        }
    }
    book.save(&path).map_err(e)?;
    Ok(Some(path.display().to_string()))
}

/// Asks where to save, then writes the CSV. Returns the path, or None if cancelled.
#[tauri::command]
async fn export_csv(app: tauri::AppHandle, file_name: String, content: String) -> Result<Option<String>, String> {
    let Some(path) = ask_where(&app, &file_name, "CSV", "csv") else { return Ok(None) };
    // A byte-order mark so Excel reads accents and symbols correctly.
    std::fs::write(&path, format!("\u{feff}{content}")).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Map › Export: asks where to save, then writes the picture (PNG, PDF or SVG) the page made.
#[tauri::command]
async fn export_bytes(app: tauri::AppHandle, file_name: String, data: Vec<u8>, kind: String) -> Result<Option<String>, String> {
    let (label, ext) = match kind.as_str() {
        "png" => ("PNG picture", "png"),
        "pdf" => ("PDF document", "pdf"),
        "svg" => ("SVG picture", "svg"),
        _ => return Err(format!("Unknown file type {kind}")),
    };
    let Some(path) = ask_where(&app, &file_name, label, ext) else { return Ok(None) };
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Asks where to save, then writes an Excel workbook: bold frozen header row and filter buttons.
#[tauri::command]
async fn export_xlsx(app: tauri::AppHandle, file_name: String, sheet: String, header: Vec<String>, rows: Vec<Vec<String>>) -> Result<Option<String>, String> {
    let Some(path) = ask_where(&app, &file_name, "Excel workbook", "xlsx") else { return Ok(None) };
    let e = |e: rust_xlsxwriter::XlsxError| e.to_string();
    let mut book = rust_xlsxwriter::Workbook::new();
    let ws = book.add_worksheet();
    ws.set_name(&sheet).map_err(e)?;
    let bold = rust_xlsxwriter::Format::new().set_bold();
    for (c, h) in header.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &bold).map_err(e)?;
    }
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            ws.write_string((r + 1) as u32, c as u16, v).map_err(e)?;
        }
    }
    ws.set_freeze_panes(1, 0).map_err(e)?;
    if !header.is_empty() {
        ws.autofilter(0, 0, rows.len() as u32, (header.len() - 1) as u16).map_err(e)?;
    }
    ws.autofit();
    book.save(&path).map_err(e)?;
    Ok(Some(path.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // With the tray icon on and "keep running" set, closing the main window only hides it.
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" && desktop::KEEP_RUNNING.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .manage(Running::default())
        .manage(PortScans::default())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_adapters,
            parse_range,
            start_scan,
            stop_scan,
            load_data,
            save_data,
            keep_unreadable_data,
            export_csv,
            export_xlsx,
            device_banners,
            device_web_title,
            list_shares,
            common_ports,
            port_scan_start,
            port_scan_stop,
            open_device,
            wake_on_lan,
            open_tool,
            resolve_names,
            ping_round,
            trace_start,
            job_stop,
            dns_lookup,
            reverse_subnet,
            dns_default_server,
            connection_info,
            renew_dhcp,
            public_ip,
            wifi_status,
            wifi_scan,
            open_location_settings,
            speed_start,
            scan_range_in_main,
            remote_wake_send,
            is_awake,
            set_tray,
            tray_status,
            notify,
            load_file,
            save_file,
            save_scans_file,
            open_scans_file,
            export_workbook,
            trace_collect,
            org_action,
            rdap_lookup,
            cert_check,
            find_subdomains,
            unifi_get,
            snmp_switches,
            unifi_key_save,
            unifi_key_has,
            unifi_key_delete,
            export_bytes
        ])
        .run(tauri::generate_context!())
        .expect("ARPradar could not start");
}
