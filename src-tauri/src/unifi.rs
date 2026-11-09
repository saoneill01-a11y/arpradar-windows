//! Ubiquiti devices and UniFi controllers (same as the Mac's UniFiDiscovery.swift and UniFiController.swift).
//!
//! - Ubiquiti discovery (UDP 10001, no login): consoles, Protect cameras and airMAX gear say their name, model and
//!   firmware. Adopted UniFi switches and access points stop answering, so the map needs the controller for those.
//! - The controller is read with a read-only API key over HTTPS (GET only). The key is kept in Windows Credential
//!   Manager ("ARPradar UniFi"), never in ARPradar's files; the page only ever sends it once, when it's saved or tested.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// MARK: Ubiquiti discovery

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct UbiquitiInfo {
    pub name: String,
    pub model: String,
    pub firmware: String,
    pub mac: String,
}

const REQUEST: [u8; 4] = [0x01, 0x00, 0x00, 0x00];

/// Broadcasts and asks every target directly (that also reaches them over a VPN). Replies from targets only.
pub fn discover(targets: &[u32], timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, UbiquitiInfo> {
    let mut out = HashMap::new();
    if targets.is_empty() {
        return out;
    }
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return out };
    let _ = sock.set_broadcast(true);
    let mut broadcasts: HashSet<u32> = HashSet::from([0xFFFF_FFFF]);
    for t in targets {
        broadcasts.insert(t | 0xFF); // the /24 each target is in: covers the usual home and office subnets
    }
    for b in broadcasts {
        let _ = sock.send_to(&REQUEST, SocketAddrV4::new(Ipv4Addr::from(b), 10001));
    }
    for (i, &t) in targets.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return out;
        }
        let _ = sock.send_to(&REQUEST, SocketAddrV4::new(Ipv4Addr::from(t), 10001));
        if i % 64 == 63 {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let wanted: HashSet<u32> = targets.iter().copied().collect();
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 4096];
    while !cancel.load(Ordering::Relaxed) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let _ = sock.set_read_timeout(Some(left.max(Duration::from_millis(5))));
        match sock.recv_from(&mut buf) {
            Ok((n, SocketAddr::V4(from))) => {
                let ip = u32::from(*from.ip());
                if wanted.contains(&ip) {
                    if let Some(info) = parse(&buf[..n]) {
                        out.insert(ip, info);
                    }
                }
            }
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(_) => {}
        }
    }
    out
}

/// Reply: version 1, command 0, 2-byte length, then type (1 byte) / length (2 bytes) / value entries.
pub fn parse(b: &[u8]) -> Option<UbiquitiInfo> {
    if b.len() < 4 || b[0] != 1 || b[1] != 0 {
        return None;
    }
    let mut fields: HashMap<u8, &[u8]> = HashMap::new();
    let mut i = 4;
    while i + 3 <= b.len() {
        let (t, len) = (b[i], (b[i + 1] as usize) << 8 | b[i + 2] as usize);
        if i + 3 + len > b.len() {
            break;
        }
        fields.entry(t).or_insert(&b[i + 3..i + 3 + len]);
        i += 3 + len;
    }
    let text = |t: u8| {
        fields.get(&t).map(|v| String::from_utf8_lossy(v).trim_matches(|c: char| c.is_whitespace() || c.is_control()).to_string()).unwrap_or_default()
    };
    let mut info = UbiquitiInfo::default();
    if let Some(m) = fields.get(&0x01).filter(|m| m.len() == 6) {
        info.mac = m.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":");
    }
    info.name = text(0x0B);
    let (long, short) = (text(0x14), text(0x0C));
    info.model = if !long.is_empty() { long } else { model_name(&short).map(str::to_string).unwrap_or(short) };
    info.firmware = short_firmware(&text(0x03));
    if info.name.is_empty() && info.model.is_empty() && info.mac.is_empty() {
        return None;
    }
    Some(info)
}

/// "UVC.SAV532q.v4.75.62.67.e71c6e5.250411.1517" -> "4.75.62.67"; "6.0.11" stays.
pub fn short_firmware(s: &str) -> String {
    if let Some(at) = s.find(".v") {
        let rest = &s[at + 2..];
        let parts: Vec<&str> = rest.split('.').take_while(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).take(4).collect();
        if parts.len() >= 2 {
            return parts.join(".");
        }
    }
    if s.chars().count() > 24 {
        format!("{}\u{2026}", s.chars().take(24).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Short model codes some devices send instead of a name.
fn model_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "UCKP" => "Cloud Key Gen2 Plus",
        "UCKG2" => "Cloud Key Gen2",
        "UCK" => "Cloud Key",
        "UDM" => "Dream Machine",
        "UDMPRO" => "Dream Machine Pro",
        "UDMPROSE" => "Dream Machine Pro SE",
        "UDR" => "Dream Router",
        "UCGULTRA" => "Cloud Gateway Ultra",
        "UCGMAX" => "Cloud Gateway Max",
        "UNVR" => "Network Video Recorder",
        "UNVRPRO" => "Network Video Recorder Pro",
        _ => return None,
    })
}

// MARK: Reading the controller (GET only)

#[derive(Serialize)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    /// SHA-256 of the certificate the controller showed ("AA:BB:…"), so the page can remember it on first use.
    pub fingerprint: String,
}

pub const CERT_CHANGED: &str = "The controller\u{2019}s certificate changed. If you replaced the controller or its certificate, open UniFi Controller\u{2026} and choose Forget Certificate; otherwise someone may be intercepting the connection.";

/// "https://host[:port]": http:// becomes https:// (the API key must not travel in the clear) and anything after the
/// host and port (a path like /network, a trailing slash) is dropped. Same as the Mac's UniFiClient.normalized.
pub fn normalized(address: &str) -> String {
    let mut a = address.trim().to_string();
    if a.is_empty() {
        return a;
    }
    if a.len() >= 7 && a.is_char_boundary(7) && a[..7].eq_ignore_ascii_case("http://") {
        a = format!("https://{}", &a[7..]);
    }
    if !a.contains("://") {
        a = format!("https://{a}");
    }
    let rest = &a[a.find("://").map(|i| i + 3).unwrap_or(0)..];
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    let hostport = hostport.rsplit_once('@').map(|(_, h)| h).unwrap_or(hostport);
    if hostport.is_empty() {
        return a;
    }
    format!("https://{hostport}")
}

/// SHA-256 of a DER certificate as "AA:BB:…".
pub fn fingerprint(der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// GET `path` on the controller with the API key. Accepts the controller's own (usually self-signed) certificate,
/// for the address that was typed in only: any certificate the first time (`expected` = None), and only that same one
/// afterwards, so a changed certificate stops the connection before the key is sent.
pub fn get(address: &str, path: &str, key: &str, expected: Option<&str>) -> Result<Reply, String> {
    let base = normalized(address);
    let Some(hostport) = base.strip_prefix("https://") else {
        return Err("Enter the controller's address, e.g. https://10.0.0.5".into());
    };
    let hostport = hostport.to_string();
    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        let (h, after) = v6.split_once(']').unwrap_or((v6, ""));
        let p = after.strip_prefix(':').map(|p| p.parse::<u16>()).transpose().map_err(|_| "That address has a bad port number.".to_string())?;
        (h.to_string(), p.unwrap_or(443))
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h.to_string(), p.parse::<u16>().map_err(|_| "That address has a bad port number.".to_string())?),
            _ => (hostport.clone(), 443),
        }
    };
    if host.is_empty() {
        return Err("Enter the controller's address, e.g. https://10.0.0.5".into());
    }
    let timeout = Duration::from_secs(12);
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Couldn't find {host}: {e}"))?
        .find(|a| a.is_ipv4())
        .ok_or_else(|| format!("Couldn't find {host}"))?;
    let tcp = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("Couldn't reach {host}: {e}"))?;
    let _ = tcp.set_read_timeout(Some(timeout));
    let _ = tcp.set_write_timeout(Some(timeout));
    let c = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;
    let mut s = c.connect(&host, tcp).map_err(|e| format!("Couldn't reach {host}: {e}"))?;
    // The certificate is checked before anything (the key) is sent.
    let seen = s.peer_certificate().ok().flatten().and_then(|c| c.to_der().ok()).map(|d| fingerprint(&d)).unwrap_or_default();
    if let Some(want) = expected.filter(|e| !e.is_empty()) {
        if !seen.eq_ignore_ascii_case(want) {
            return Err(CERT_CHANGED.into());
        }
    }
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {hostport}\r\nUser-Agent: ARPradar\r\nAccept: application/json\r\nX-API-KEY: {key}\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| format!("Couldn't reach {host}: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut data = Vec::new();
    let mut buf = [0u8; 16384];
    while data.len() < 64 * 1024 * 1024 && Instant::now() < deadline {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    let page = crate::identify::parse_response(&data).ok_or_else(|| format!("Couldn't reach {host}: no answer"))?;
    let chunked = page.headers.iter().any(|(k, v)| k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked { dechunk(&page.body) } else { page.body };
    Ok(Reply { status: page.status, body: String::from_utf8_lossy(&body).into_owned(), fingerprint: seen })
}

pub fn dechunk(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let Some(end) = b[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let size_text = String::from_utf8_lossy(&b[i..i + end]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16) else { break };
        i += end + 2;
        if size == 0 || i + size > b.len() {
            if size > 0 {
                out.extend_from_slice(&b[i..]);
            }
            break;
        }
        out.extend_from_slice(&b[i..i + size]);
        i += size + 2;
    }
    out
}

// MARK: The API key (Windows Credential Manager; the macOS Keychain when testing on the Mac)

const SERVICE: &str = "ARPradar UniFi";

pub fn key_set(id: &str, key: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, id).and_then(|e| e.set_password(key)).map_err(|e| format!("Couldn't save the API key: {e}"))
}
pub fn key_get(id: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, id).ok()?.get_password().ok()
}
pub fn key_delete(id: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, id) {
        let _ = e.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_reply() {
        let mut b = vec![1, 0, 0, 0];
        let mut add = |t: u8, v: &[u8]| {
            b.push(t);
            b.extend([(v.len() >> 8) as u8, v.len() as u8]);
            b.extend_from_slice(v);
        };
        add(0x01, &[0x74, 0xAC, 0xB9, 0x01, 0x02, 0x03]);
        add(0x0B, b"front-door");
        add(0x0C, b"UCKP");
        add(0x03, b"UVC.SAV532q.v4.75.62.67.e71c6e5.250411.1517");
        let i = parse(&b).unwrap();
        assert_eq!(i.mac, "74:AC:B9:01:02:03");
        assert_eq!(i.name, "front-door");
        assert_eq!(i.model, "Cloud Key Gen2 Plus");
        assert_eq!(i.firmware, "4.75.62.67");
        assert_eq!(short_firmware("6.0.11"), "6.0.11");
        assert!(parse(&[2, 0, 0, 0]).is_none());
    }

    #[test]
    fn addresses_and_chunks() {
        assert_eq!(normalized(" 10.0.0.5/ "), "https://10.0.0.5");
        assert_eq!(normalized("http://10.0.0.5:8080"), "https://10.0.0.5:8080");
        assert_eq!(normalized("https://unifi.example.test/network/default"), "https://unifi.example.test");
        assert_eq!(normalized("HTTP://[fd00::5]:8443/"), "https://[fd00::5]:8443");
        assert_eq!(fingerprint(b"abc").len(), 32 * 3 - 1);
        assert_eq!(dechunk(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
    }
}
