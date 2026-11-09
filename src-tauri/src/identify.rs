//! What a device is: its web page title, UPnP model, SNMP description, and what answers on each
//! open port (service banners). Ported from the Mac app's Identify.swift.

use crate::scan::par_map;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// MARK: A small web client (reads pages on devices; accepts their self-signed certificates)

pub struct Page {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

fn connect(ip: u32, port: u16, timeout: Duration) -> Option<TcpStream> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(ip), port));
    let s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    Some(s)
}

/// One GET (or HEAD) over HTTP/1.0. Follows up to 3 redirects on the same device.
pub fn get(ip: u32, port: u16, tls: bool, path: &str, timeout: Duration) -> Option<Page> {
    let (mut port, mut tls, mut path) = (port, tls, path.to_string());
    for _ in 0..4 {
        let page = get_once(ip, port, tls, &path, timeout)?;
        if !(300..400).contains(&page.status) {
            return Some(page);
        }
        let loc = page.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone())?;
        if let Some(rest) = loc.strip_prefix("http://").or_else(|| loc.strip_prefix("https://")) {
            let (hostport, p) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
            let (host, newport) = match hostport.rsplit_once(':') {
                Some((h, pt)) => (h, pt.parse().ok()?),
                None => (hostport, if loc.starts_with("https") { 443 } else { 80 }),
            };
            if host != crate::range::text(ip) {
                return Some(page); // only ever read pages on the device itself
            }
            tls = loc.starts_with("https");
            port = newport;
            path = p;
        } else if loc.starts_with('/') {
            path = loc;
        } else {
            return Some(page);
        }
    }
    None
}

fn get_once(ip: u32, port: u16, tls: bool, path: &str, timeout: Duration) -> Option<Page> {
    let tcp = connect(ip, port, timeout)?;
    let mut s: Box<dyn Stream> = if tls {
        let c = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .ok()?;
        Box::new(c.connect(&crate::range::text(ip), tcp).ok()?)
    } else {
        Box::new(tcp)
    };
    let host = crate::range::text(ip);
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nUser-Agent: ARPradar\r\nAccept: */*\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let deadline = Instant::now() + timeout;
    let mut data = Vec::new();
    let mut buf = [0u8; 8192];
    while data.len() < 256 * 1024 && Instant::now() < deadline {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    parse_response(&data)
}

pub fn parse_response(data: &[u8]) -> Option<Page> {
    let end = data.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&data[..end]);
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    Some(Page { status, headers, body: data[end + 4..].to_vec() })
}

/// The address to read for a device's home page, from its open ports: (port, https?).
pub fn home(ports: &[u16]) -> Option<(u16, bool)> {
    [(443, true), (80, false), (8443, true), (8080, false)].into_iter().find(|(p, _)| ports.contains(p))
}

/// Page titles for devices with a web port open.
pub fn web_titles(ports: &HashMap<u32, Vec<u16>>, cancel: &AtomicBool) -> HashMap<u32, String> {
    let jobs: Vec<(u32, u16, bool)> = ports.iter().filter_map(|(&ip, p)| home(p).map(|(port, tls)| (ip, port, tls))).collect();
    par_map(&jobs, 64, cancel, |&(ip, port, tls)| {
        let page = get(ip, port, tls, "/", Duration::from_secs(3))?;
        if page.status >= 400 {
            return None;
        }
        title(&String::from_utf8_lossy(&page.body)).map(|t| (ip, t))
    })
    .into_iter()
    .collect()
}

/// The text of the first <title>, tidied up.
pub fn title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title>")?;
    let t = decode_entities(&html[start..end]).split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return None;
    }
    Some(if t.chars().count() > 100 { t.chars().take(100).collect::<String>() + "\u{2026}" } else { t })
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest[..rest.len().min(10)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "ndash" => Some('\u{2013}'),
            "mdash" => Some('\u{2014}'),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// MARK: UPnP / SSDP

/// Text that came off the network (a NetBIOS name, Bonjour label, web page title, UPnP model, SNMP string), made
/// safe to show, copy and export: control characters (tabs and line breaks too) and the invisible zero-width and
/// direction-changing characters are dropped, the ends are trimmed, and it's cut to `max` characters (with "…").
/// Same as the Mac's String.cleanedNetworkText.
pub fn clean_text(s: &str, max: usize) -> String {
    let kept: String = s
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !(u <= 0x1F || (0x7F..=0x9F).contains(&u) || (0x200B..=0x200F).contains(&u) || (0x202A..=0x202E).contains(&u)
                || (0x2066..=0x2069).contains(&u) || u == 0xFEFF)
        })
        .collect();
    let t = kept.trim();
    if t.chars().count() > max {
        format!("{}\u{2026}", t.chars().take(max).collect::<String>())
    } else {
        t.to_string()
    }
}

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpnpInfo {
    pub friendly_name: String,
    pub model: String,
}

/// Asks "who's out there?" over SSDP (multicast 239.255.255.250:1900). TVs, speakers, routers, NAS boxes and
/// printers answer with a link to an XML file naming their model.
pub fn upnp(wanted: &HashSet<u32>, timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, UpnpInfo> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return HashMap::new() };
    let _ = sock.set_multicast_ttl_v4(2);
    let group = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
    let search = |st: &str| {
        format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\nUSER-AGENT: Windows UPnP/1.1 ARPradar/1.0\r\n\r\n")
    };
    for round in 0..2 {
        let _ = sock.send_to(search("upnp:rootdevice").as_bytes(), group);
        let _ = sock.send_to(search("ssdp:all").as_bytes(), group);
        if round == 0 {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    let mut locations: HashMap<u32, (u16, String)> = HashMap::new();
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
                if !wanted.contains(&ip) || locations.contains_key(&ip) {
                    continue;
                }
                if let Some(loc) = header(&String::from_utf8_lossy(&buf[..n]), "location") {
                    // Only read files on the device itself, over plain http.
                    if let Some(rest) = loc.strip_prefix("http://") {
                        let (hostport, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
                        let (host, port) = hostport.rsplit_once(':').map(|(h, p)| (h, p.parse().unwrap_or(80))).unwrap_or((hostport, 80));
                        if host == crate::range::text(ip) {
                            locations.insert(ip, (port, path));
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(_) => {}
        }
    }
    let jobs: Vec<(u32, u16, String)> = locations.into_iter().map(|(ip, (p, path))| (ip, p, path)).collect();
    par_map(&jobs, 32, cancel, |(ip, port, path)| {
        let page = get(*ip, *port, false, path, Duration::from_secs(3))?;
        upnp_description(&String::from_utf8_lossy(&page.body)).map(|i| (*ip, i))
    })
    .into_iter()
    .collect()
}

pub fn header(reply: &str, name: &str) -> Option<String> {
    reply.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(name)).then(|| v.trim().to_string())
    })
}

pub fn upnp_description(xml: &str) -> Option<UpnpInfo> {
    let lower = xml.to_lowercase();
    let tag = |name: &str| -> String {
        let (o, c) = (format!("<{}>", name.to_lowercase()), format!("</{}>", name.to_lowercase()));
        let Some(a) = lower.find(&o) else { return String::new() };
        let start = a + o.len();
        let Some(b) = lower[start..].find(&c) else { return String::new() };
        decode_entities(&xml[start..start + b]).trim().to_string()
    };
    let (maker, model_name, number) = (tag("manufacturer"), tag("modelName"), tag("modelNumber"));
    let mut model = model_name.clone();
    if !number.is_empty() && !model_name.to_lowercase().contains(&number.to_lowercase()) {
        model = format!("{model} {number}").trim().to_string();
    }
    let first = maker.split(' ').next().unwrap_or("").to_lowercase();
    if !maker.is_empty() && !model.to_lowercase().contains(&first) {
        model = format!("{maker} {model}").trim().to_string();
    }
    let info = UpnpInfo { friendly_name: tag("friendlyName"), model };
    (!info.friendly_name.is_empty() || !info.model.is_empty()).then_some(info)
}

// MARK: SNMP v2c: sysDescr, sysName, sysLocation (UDP 161)

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct SnmpInfo {
    pub name: String,
    pub descr: String,
    pub location: String,
}

const SYS_DESCR: [u32; 9] = [1, 3, 6, 1, 2, 1, 1, 1, 0];
const SYS_NAME: [u32; 9] = [1, 3, 6, 1, 2, 1, 1, 5, 0];
const SYS_LOCATION: [u32; 9] = [1, 3, 6, 1, 2, 1, 1, 6, 0];

pub fn snmp(targets: &[u32], community: &str, timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, SnmpInfo> {
    let mut out = HashMap::new();
    if targets.is_empty() || community.is_empty() {
        return out;
    }
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return out };
    let packet = snmp_request(community, 0x4152);
    for (i, &t) in targets.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return out;
        }
        let _ = sock.send_to(&packet, SocketAddrV4::new(Ipv4Addr::from(t), 161));
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
                    if let Some(info) = snmp_response(&buf[..n]) {
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

pub(crate) fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let n = content.len();
    let mut v = vec![tag];
    if n < 128 {
        v.push(n as u8);
    } else if n < 256 {
        v.extend([0x81, n as u8]);
    } else {
        v.extend([0x82, (n >> 8) as u8, n as u8]);
    }
    v.extend_from_slice(content);
    v
}

pub(crate) fn integer(v: i32) -> Vec<u8> {
    let mut b = v.to_be_bytes().to_vec();
    while b.len() > 1 && ((b[0] == 0 && b[1] & 0x80 == 0) || (b[0] == 0xFF && b[1] & 0x80 != 0)) {
        b.remove(0);
    }
    tlv(0x02, &b)
}

pub(crate) fn oid(parts: &[u32]) -> Vec<u8> {
    let mut out = vec![(parts[0] * 40 + parts[1]) as u8];
    for &p in &parts[2..] {
        let mut chunk = vec![(p & 0x7F) as u8];
        let mut q = p >> 7;
        while q > 0 {
            chunk.insert(0, (q & 0x7F) as u8 | 0x80);
            q >>= 7;
        }
        out.extend(chunk);
    }
    tlv(0x06, &out)
}

pub fn snmp_request(community: &str, id: i32) -> Vec<u8> {
    let binds: Vec<u8> = [SYS_DESCR, SYS_NAME, SYS_LOCATION]
        .iter()
        .flat_map(|o| tlv(0x30, &[oid(o), vec![0x05, 0x00]].concat()))
        .collect();
    let pdu = tlv(0xA0, &[integer(id), integer(0), integer(0), tlv(0x30, &binds)].concat());
    tlv(0x30, &[integer(1), tlv(0x04, community.as_bytes()), pdu].concat()) // version 1 = v2c
}

/// One tag-length-value at `o`: the tag and where its content is; moves `o` past it.
pub(crate) fn read_tlv(b: &[u8], o: &mut usize) -> Option<(u8, std::ops::Range<usize>)> {
    if *o + 2 > b.len() {
        return None;
    }
    let tag = b[*o];
    let mut len = b[*o + 1] as usize;
    let mut p = *o + 2;
    if len & 0x80 != 0 {
        let n = len & 0x7F;
        if !(1..=3).contains(&n) || p + n > b.len() {
            return None;
        }
        len = b[p..p + n].iter().fold(0, |a, &x| a << 8 | x as usize);
        p += n;
    }
    if p + len > b.len() {
        return None;
    }
    *o = p + len;
    Some((tag, p..p + len))
}

pub(crate) fn decode_oid(b: &[u8]) -> Vec<u32> {
    let Some(&first) = b.first() else { return vec![] };
    let mut out = vec![first as u32 / 40, first as u32 % 40];
    let mut v = 0u32;
    for &x in &b[1..] {
        v = v << 7 | (x & 0x7F) as u32;
        if x & 0x80 == 0 {
            out.push(v);
            v = 0;
        }
    }
    out
}

pub fn snmp_response(b: &[u8]) -> Option<SnmpInfo> {
    let mut o = 0;
    let (t, body) = read_tlv(b, &mut o)?;
    if t != 0x30 {
        return None;
    }
    o = body.start;
    if read_tlv(b, &mut o)?.0 != 0x02 || read_tlv(b, &mut o)?.0 != 0x04 {
        return None;
    }
    let (t, pdu) = read_tlv(b, &mut o)?;
    if t != 0xA2 {
        return None;
    }
    o = pdu.start;
    read_tlv(b, &mut o)?;
    let (_, err) = read_tlv(b, &mut o)?;
    read_tlv(b, &mut o)?;
    let (t, list) = read_tlv(b, &mut o)?;
    if t != 0x30 || b[err].iter().any(|&x| x != 0) {
        return None;
    }
    let mut info = SnmpInfo::default();
    let mut p = list.start;
    while p < list.end {
        let Some((t, bind)) = read_tlv(b, &mut p) else { break };
        if t != 0x30 {
            break;
        }
        let mut q = bind.start;
        let (Some((0x06, name)), Some((0x04, value))) = (read_tlv(b, &mut q), read_tlv(b, &mut q)) else { continue };
        let text: String = String::from_utf8_lossy(&b[value]).chars().filter(|c| *c == '\n' || !c.is_control()).collect();
        let text = text.trim().to_string();
        match decode_oid(&b[name]).as_slice() {
            o if o == SYS_DESCR => info.descr = text,
            o if o == SYS_NAME => info.name = text,
            o if o == SYS_LOCATION => info.location = text,
            _ => {}
        }
    }
    (!info.name.is_empty() || !info.descr.is_empty() || !info.location.is_empty()).then_some(info)
}

// MARK: Service banners

const TLS_PORTS: [u16; 16] = [443, 465, 636, 853, 993, 995, 4443, 5001, 5061, 5986, 6443, 7443, 8443, 8843, 8883, 9443];
const HTTP_PORTS: [u16; 21] = [80, 81, 3000, 5000, 7000, 8000, 8008, 8060, 8080, 8081, 8088, 8123, 8200, 8880, 8888, 9000, 9090, 9091, 9100, 10000, 32400];

/// What answers on each port: the web server's name, or the greeting an SSH/FTP/SMTP server sends.
pub fn banners(ip: u32, ports: &[u16], timeout: Duration) -> HashMap<u16, String> {
    let list: Vec<u16> = ports.iter().copied().filter(|p| !TLS_PORTS.contains(p)).take(200).collect();
    let never = AtomicBool::new(false);
    par_map(&list, 64, &never, |&port| grab(ip, port, timeout).map(|b| (port, b))).into_iter().collect()
}

fn grab(ip: u32, port: u16, timeout: Duration) -> Option<String> {
    let mut s = connect(ip, port, timeout)?;
    let http = HTTP_PORTS.contains(&port);
    if http {
        let host = crate::range::text(ip);
        s.write_all(format!("HEAD / HTTP/1.0\r\nHost: {host}\r\nUser-Agent: ARPradar\r\n\r\n").as_bytes()).ok()?;
    }
    let deadline = Instant::now() + timeout;
    let mut data = Vec::new();
    let mut buf = [0u8; 2048];
    while Instant::now() < deadline && data.len() < 4096 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
        }
        if !http && data.contains(&b'\n') {
            break;
        }
        if http && data.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = if http { http_server(&String::from_utf8_lossy(&data)) } else { first_line(&data) }?;
    Some(clean_text(&text, 120)).filter(|t| !t.is_empty())
}

/// "Server: nginx/1.24" -> "nginx/1.24". A web server with no Server header -> "Web server".
pub fn http_server(reply: &str) -> Option<String> {
    if !reply.starts_with("HTTP/") {
        return None;
    }
    match header(reply, "server").filter(|v| !v.is_empty()) {
        Some(v) => Some(v.chars().take(80).collect()),
        None => Some("Web server".into()),
    }
}

/// The first line a service sends, if it's readable text ("SSH-2.0-OpenSSH_9.6" -> "OpenSSH 9.6").
pub fn first_line(data: &[u8]) -> Option<String> {
    let line: Vec<u8> = data.iter().copied().take_while(|&c| c != b'\n' && c != b'\r').collect();
    if line.is_empty() || !line.iter().all(|&c| (0x20..=0x7E).contains(&c) || c == b'\t') {
        return None;
    }
    let mut s = String::from_utf8_lossy(&line).trim().to_string();
    if s.starts_with("SSH-") {
        let parts: Vec<&str> = s.splitn(3, '-').collect();
        if parts.len() == 3 {
            s = parts[2].replace('_', " ");
        }
    } else if s.len() > 4 && s[..3].bytes().all(|c| c.is_ascii_digit()) && matches!(s.as_bytes()[3], b' ' | b'-') {
        s = s[4..].to_string(); // "220 printer FTP ready" -> "printer FTP ready"
    }
    (!s.is_empty()).then(|| s.chars().take(80).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleaned_text() {
        assert_eq!(clean_text("  Lobby\tprinter\r\n\u{202E}gpj.exe\u{200B} ", 120), "Lobbyprintergpj.exe");
        assert_eq!(clean_text("abcdef", 3), "abc\u{2026}");
    }

    #[test]
    fn titles() {
        assert_eq!(title("<html><head><TITLE lang=en>\n My  Router &amp; Co &#8211; Login</title>"), Some("My Router & Co \u{2013} Login".into()));
        assert_eq!(title("<title></title>"), None);
        assert_eq!(title("no title"), None);
    }

    #[test]
    fn banner_lines() {
        assert_eq!(first_line(b"SSH-2.0-OpenSSH_9.6p1 Ubuntu-3\r\n"), Some("OpenSSH 9.6p1 Ubuntu-3".into()));
        assert_eq!(first_line(b"220 printer FTP ready\r\n"), Some("printer FTP ready".into()));
        assert_eq!(first_line(&[0x16, 0x03]), None);
        assert_eq!(http_server("HTTP/1.1 200 OK\r\nServer: nginx/1.24\r\n\r\n"), Some("nginx/1.24".into()));
        assert_eq!(http_server("HTTP/1.1 200 OK\r\n\r\n"), Some("Web server".into()));
    }

    #[test]
    fn upnp_xml() {
        let xml = "<root><device><friendlyName>Living Room</friendlyName><manufacturer>Example Corp</manufacturer><modelName>Box</modelName><modelNumber>X2</modelNumber></device></root>";
        assert_eq!(upnp_description(xml), Some(UpnpInfo { friendly_name: "Living Room".into(), model: "Example Corp Box X2".into() }));
    }

    #[test]
    fn snmp_round_trip() {
        // Build a made-up GetResponse with the same encoder and read it back.
        let binds: Vec<u8> = [(SYS_DESCR, "Sample switch 24-port"), (SYS_NAME, "sw-lab"), (SYS_LOCATION, "Closet")]
            .iter()
            .flat_map(|(o, v)| tlv(0x30, &[oid(o), tlv(0x04, v.as_bytes())].concat()))
            .collect();
        let pdu = tlv(0xA2, &[integer(1), integer(0), integer(0), tlv(0x30, &binds)].concat());
        let msg = tlv(0x30, &[integer(1), tlv(0x04, b"public"), pdu].concat());
        assert_eq!(snmp_response(&msg), Some(SnmpInfo { name: "sw-lab".into(), descr: "Sample switch 24-port".into(), location: "Closet".into() }));
        assert_eq!(snmp_request("public", 1)[0], 0x30);
    }

    #[test]
    fn responses() {
        let p = parse_response(b"HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\nx").unwrap();
        assert_eq!((p.status, header("Location: /login", "location")), (302, Some("/login".into())));
        assert_eq!(home(&[22, 80, 443]), Some((443, true)));
    }
}
