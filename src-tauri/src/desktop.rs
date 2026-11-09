//! Step 5 pieces: Wake Remote PC (Wake-on-LAN over a VPN), the tray icon (the Mac app's menu bar item), and
//! notifications about NEW devices.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

// MARK: Wake Remote PC

/// Accepts any common MAC format (colons, dashes, dots, none) and returns the 6 bytes.
pub fn mac_bytes(text: &str) -> Option<[u8; 6]> {
    let hex: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 || text.chars().any(|c| c.is_ascii_alphabetic() && !c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Sends the magic packet 3 times (150 ms apart) to every destination. The packets are ordinary UDP, so Windows
/// routes them through whichever VPN reaches that address.
pub fn remote_wake(mac: &str, destinations: &[String], port: u16) -> Result<(), String> {
    let mac = mac_bytes(mac).ok_or("The MAC address isn\u{2019}t valid. Paste it in any format, like 3C-52-82-1A-7E-09 or 3c52821a7e09.")?;
    if destinations.is_empty() {
        return Err("Tick at least one \u{201c}Send to\u{201d} option.".into());
    }
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend(mac);
    }
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    for round in 0..3 {
        for d in destinations {
            let ip: Ipv4Addr = d.parse().map_err(|_| format!("\u{201c}{d}\u{201d} isn\u{2019}t a valid IP address."))?;
            sock.send_to(&packet, SocketAddrV4::new(ip, port))
                .map_err(|e| format!("Couldn\u{2019}t send to {d}: {e}. Is the VPN to that site connected?"))?;
        }
        if round < 2 {
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    Ok(())
}

/// Ports a woken Windows/Mac/Linux PC usually has open. Windows blocks ping by default, so an open port also
/// counts as awake. Only open ports count: a refused connection can come from a firewall on the way.
const AWAKE_PORTS: [u16; 6] = [3389, 445, 135, 22, 5900, 80];

pub fn is_awake(ip: Ipv4Addr) -> bool {
    if crate::sys::ping(u32::from(ip), 1500).is_some() {
        return true;
    }
    let never = AtomicBool::new(false);
    !crate::scan::par_map(&AWAKE_PORTS, 6, &never, |&p| {
        TcpStream::connect_timeout(&SocketAddr::V4(SocketAddrV4::new(ip, p)), Duration::from_millis(1500)).ok().map(|_| p)
    })
    .is_empty()
}

// MARK: Tray icon

/// Whether the tray icon is on, and whether closing the main window only hides it.
pub static TRAY_ON: AtomicBool = AtomicBool::new(false);
pub static KEEP_RUNNING: AtomicBool = AtomicBool::new(false);
const TRAY_ID: &str = "arpradar";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle, status: &str, scanning: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let header = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", if scanning { "Stop Scan" } else { "Scan Now" }, true, None::<&str>)?;
    let ping = MenuItem::with_id(app, "ping", "Ping\u{2026}", true, None::<&str>)?;
    let speed = MenuItem::with_id(app, "speed", "Speed Test", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open ARPradar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ARPradar", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    Menu::with_items(app, &[&header, &sep()?, &scan, &ping, &speed, &sep()?, &open, &quit])
}

/// Turns the tray icon on or off (Settings › General).
pub fn set_tray(app: &AppHandle, on: bool, keep_running: bool) -> Result<(), String> {
    TRAY_ON.store(on, Ordering::Relaxed);
    KEEP_RUNNING.store(on && keep_running, Ordering::Relaxed);
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        return t.set_visible(on).map_err(|e| e.to_string());
    }
    if !on {
        return Ok(());
    }
    let menu = build_menu(app, "ARPradar", false).map_err(|e| e.to_string())?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("ARPradar").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, e| match e.id().as_ref() {
        "scan" => {
            show_main(app);
            let _ = app.emit_to("main", "tray-scan", ());
        }
        "ping" => {
            let _ = crate::open_tool_window(app, "ping", None);
        }
        "speed" => {
            let _ = crate::open_tool_window(app, "speed", None);
        }
        "open" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_main(tray.app_handle());
        }
    })
    .build(app)
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The first line of the tray menu and its tooltip: the network and how many devices are online / new.
pub fn tray_status(app: &AppHandle, text: &str, scanning: bool) -> Result<(), String> {
    let Some(t) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    let _ = t.set_tooltip(Some(format!("ARPradar \u{00b7} {text}")));
    let menu = build_menu(app, text, scanning).map_err(|e| e.to_string())?;
    t.set_menu(Some(menu)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn macs() {
        let want = Some([0x3C, 0x52, 0x82, 0x1A, 0x7E, 0x09]);
        assert_eq!(super::mac_bytes("3C-52-82-1A-7E-09"), want);
        assert_eq!(super::mac_bytes("3c52.821a.7e09"), want);
        assert_eq!(super::mac_bytes("3c52821a7e09"), want);
        assert_eq!(super::mac_bytes("3c52821a7e0"), None);
        assert_eq!(super::mac_bytes("zz52821a7e09"), None);
    }
}
