//! Device names, from (in this order; the first name found wins):
//!  - NetBIOS (Windows PCs, NAS boxes, printers): asked directly over UDP 137.
//!  - Bonjour/mDNS (Macs, NAS boxes, printers, Home Assistant, Linux): UDP 5353.
//!  - A saved scan's own name server (e.g. a client's domain controller over VPN): UDP 53.
//!  - Reverse DNS through this PC's normal DNS.
//! Ported from the Mac app's NameLookup.swift.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

fn udp() -> Option<UdpSocket> {
    UdpSocket::bind("0.0.0.0:0").ok()
}

/// Sends `packet(i, ip)` to every target (and any extra address), then collects replies until `timeout`.
/// Targets that haven't answered after 0.6 s are asked once more: one UDP question and one answer are easily lost on
/// busy Wi-Fi (and on a Raspberry Pi, whose Wi-Fi shares its radio with Bluetooth).
fn ask_all(
    targets: &[u32],
    port: u16,
    timeout: Duration,
    cancel: &AtomicBool,
    prepare: impl Fn(&UdpSocket),
    send: impl Fn(&UdpSocket, usize, u32),
    mut on_reply: impl FnMut(u32, &[u8]),
) {
    let Some(sock) = udp() else { return };
    prepare(&sock);
    let send_to = |only: &dyn Fn(u32) -> bool| {
        for (i, &t) in targets.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            if !only(t) {
                continue;
            }
            send(&sock, i, t);
            if i % 32 == 31 {
                std::thread::sleep(Duration::from_millis(3));
            }
        }
    };
    send_to(&|_| true);
    let _ = port;
    let started = Instant::now();
    let deadline = started + timeout;
    let again_at = started + Duration::from_millis(600);
    let mut asked_again = timeout <= Duration::from_millis(900);
    let mut answered: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut buf = vec![0u8; 9000];
    while !cancel.load(Ordering::Relaxed) {
        let now = Instant::now();
        if !asked_again && now >= again_at {
            asked_again = true;
            send_to(&|t| !answered.contains(&t));
            continue;
        }
        let left = deadline.saturating_duration_since(now);
        if left.is_zero() {
            break;
        }
        let wait = if asked_again { left } else { left.min(again_at.saturating_duration_since(now)) };
        let _ = sock.set_read_timeout(Some(wait.max(Duration::from_millis(5))));
        match sock.recv_from(&mut buf) {
            Ok((n, std::net::SocketAddr::V4(from))) => {
                let ip = u32::from(*from.ip());
                answered.insert(ip);
                on_reply(ip, &buf[..n]);
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                if asked_again {
                    break;
                }
            }
            // Windows reports "connection reset" when a target sent back ICMP port unreachable: keep listening.
            Err(_) => {}
        }
    }
}

fn to(ip: u32, port: u16) -> SocketAddrV4 {
    SocketAddrV4::new(Ipv4Addr::from(ip), port)
}

// MARK: NetBIOS

pub fn netbios(targets: &[u32], timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, String> {
    // Header: id, flags 0, 1 question. Name "*" encoded, type NBSTAT (0x21), class IN.
    let mut q: Vec<u8> = vec![0x13, 0x37, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x20, 0x43, 0x4B];
    q.extend(std::iter::repeat(0x41).take(30));
    q.extend([0, 0, 0x21, 0, 1]);
    let mut names = HashMap::new();
    ask_all(
        targets,
        137,
        timeout,
        cancel,
        |_| {},
        |s, _, t| {
            let _ = s.send_to(&q, to(t, 137));
        },
        |from, b| {
            if let Some(n) = parse_node_status(b) {
                names.insert(from, n);
            }
        },
    );
    names
}

/// Picks the computer name (unique name with suffix 0x00) from a node status reply.
pub fn parse_node_status(b: &[u8]) -> Option<String> {
    if b.len() <= 57 {
        return None;
    }
    let mut o = 12;
    while o < b.len() && b[o] != 0 {
        if b[o] & 0xC0 == 0xC0 {
            o += 1;
            break;
        }
        o += b[o] as usize + 1;
    }
    o += 1 + 10;
    if o >= b.len() {
        return None;
    }
    let count = b[o] as usize;
    o += 1;
    for i in 0..count {
        let s = o + i * 18;
        if s + 18 > b.len() {
            break;
        }
        let suffix = b[s + 15];
        let flags = (b[s + 16] as u16) << 8 | b[s + 17] as u16;
        if suffix == 0 && flags & 0x8000 == 0 {
            let name: String = b[s..s + 15].iter().map(|&c| c as char).collect();
            let name = name.trim_matches(|c: char| c.is_whitespace() || c.is_control()).to_string();
            if !name.is_empty() && name.is_ascii() {
                return Some(name);
            }
        }
    }
    None
}

// MARK: DNS-style PTR questions (Bonjour and a saved scan's name server)

/// A DNS question: PTR record for d.c.b.a.in-addr.arpa.
pub fn ptr_query(ip: u32, id: u16, recursion: bool) -> Vec<u8> {
    let mut q = vec![(id >> 8) as u8, id as u8, if recursion { 1 } else { 0 }, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    let o = Ipv4Addr::from(ip).octets();
    for label in [o[3].to_string(), o[2].to_string(), o[1].to_string(), o[0].to_string(), "in-addr".into(), "arpa".into()] {
        q.push(label.len() as u8);
        q.extend(label.as_bytes());
    }
    q.extend([0, 0, 0x0C, 0, 1]);
    q
}

pub fn bonjour(targets: &[u32], timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, String> {
    let group = u32::from(Ipv4Addr::new(224, 0, 0, 251));
    let wanted: std::collections::HashSet<u32> = targets.iter().copied().collect();
    let mut names = HashMap::new();
    // Ask each device directly AND the multicast group: some devices only answer one of the two.
    ask_all(
        targets,
        5353,
        timeout,
        cancel,
        |s| {
            let _ = s.set_multicast_ttl_v4(255);
        },
        |s, i, t| {
            let q = ptr_query(t, i as u16, false);
            let _ = s.send_to(&q, to(t, 5353));
            let _ = s.send_to(&q, to(group, 5353));
        },
        |_, b| {
            for (ip, n) in parse_ptr_answers(b) {
                if wanted.contains(&ip) {
                    names.insert(ip, n);
                }
            }
        },
    );
    names
}

pub fn dns_ptr(targets: &[u32], server: u32, timeout: Duration, cancel: &AtomicBool) -> HashMap<u32, String> {
    let wanted: std::collections::HashSet<u32> = targets.iter().copied().collect();
    let mut names = HashMap::new();
    ask_all(
        targets,
        53,
        timeout,
        cancel,
        |_| {},
        |s, i, t| {
            let _ = s.send_to(&ptr_query(t, i as u16, true), to(server, 53));
        },
        |from, b| {
            if from != server {
                return;
            }
            for (ip, n) in parse_ptr_answers(b) {
                if wanted.contains(&ip) {
                    names.insert(ip, n);
                }
            }
        },
    );
    names
}

/// (IP, name) pairs from the PTR answers in a DNS reply. ".local" is dropped from names.
pub fn parse_ptr_answers(b: &[u8]) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    if b.len() < 12 || b[2] & 0x80 == 0 {
        return out;
    }
    let qd = (b[4] as usize) << 8 | b[5] as usize;
    let an = (b[6] as usize) << 8 | b[7] as usize;
    let mut o = 12;
    for _ in 0..qd {
        if read_name(b, &mut o).is_none() {
            return out;
        }
        o += 4;
    }
    for _ in 0..an {
        let Some(owner) = read_name(b, &mut o) else { break };
        if o + 10 > b.len() {
            break;
        }
        let rtype = (b[o] as usize) << 8 | b[o + 1] as usize;
        let len = (b[o + 8] as usize) << 8 | b[o + 9] as usize;
        o += 10;
        let end = o + len;
        if end > b.len() {
            break;
        }
        if rtype == 12 {
            if let Some(ip) = ip_from_reverse(&owner) {
                let mut r = o;
                if let Some(mut name) = read_name(b, &mut r) {
                    if name.to_lowercase().ends_with(".local") {
                        name.truncate(name.len() - 6);
                    }
                    if !name.is_empty() {
                        out.push((ip, name));
                    }
                }
            }
        }
        o = end;
    }
    out
}

/// Reads a (possibly compressed) DNS name starting at `o` and moves `o` past it.
pub fn read_name(b: &[u8], o: &mut usize) -> Option<String> {
    let mut labels: Vec<String> = Vec::new();
    let mut p = *o;
    let mut jumped = false;
    let mut hops = 0;
    while p < b.len() {
        let len = b[p] as usize;
        if len == 0 {
            if !jumped {
                *o = p + 1;
            }
            return Some(labels.join("."));
        }
        if len & 0xC0 == 0xC0 {
            if p + 1 >= b.len() || hops >= 20 {
                return None;
            }
            if !jumped {
                *o = p + 2;
            }
            p = (len & 0x3F) << 8 | b[p + 1] as usize;
            jumped = true;
            hops += 1;
            continue;
        }
        if p + 1 + len > b.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&b[p + 1..p + 1 + len]).into_owned());
        p += 1 + len;
    }
    None
}

/// "5.1.168.192.in-addr.arpa" -> 192.168.1.5
pub fn ip_from_reverse(name: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    let parts: Vec<&str> = lower.split('.').collect();
    if parts.len() != 6 || parts[4] != "in-addr" || parts[5] != "arpa" {
        return None;
    }
    let o: Vec<u8> = parts[0..4].iter().filter_map(|p| p.parse().ok()).collect();
    if o.len() != 4 {
        return None;
    }
    Some(u32::from(Ipv4Addr::new(o[3], o[2], o[1], o[0])))
}

pub fn is_useful(n: &str) -> bool {
    let t = n.trim().to_lowercase();
    !t.is_empty() && !["unknown", "localhost", "(none)", "none", "default", "name"].contains(&t.as_str())
}

// MARK: Reverse DNS through this PC's DNS

/// Looks names up 32 at a time and reports each as it arrives; gives up on the rest after `timeout`.
pub fn reverse_dns(targets: &[u32], timeout: Duration, cancel: Arc<AtomicBool>, mut found: impl FnMut(u32, String)) {
    let queue = Arc::new(Mutex::new(targets.to_vec()));
    let (tx, rx) = mpsc::channel::<(u32, Option<String>)>();
    for _ in 0..32.min(targets.len()) {
        let (queue, tx, cancel) = (queue.clone(), tx.clone(), cancel.clone());
        // Detached: a slow lookup can outlive the scan without holding it up.
        let _ = std::thread::Builder::new().stack_size(256 * 1024).spawn(move || loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let Some(ip) = queue.lock().unwrap().pop() else { return };
            let name = dns_lookup::lookup_addr(&std::net::IpAddr::V4(Ipv4Addr::from(ip))).ok();
            if tx.send((ip, name)).is_err() {
                return;
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + timeout;
    let mut left = targets.len();
    while left > 0 && !cancel.load(Ordering::Relaxed) {
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            break;
        }
        match rx.recv_timeout(wait) {
            Ok((ip, name)) => {
                left -= 1;
                if let Some(mut n) = name {
                    if n.ends_with('.') {
                        n.pop();
                    }
                    // Windows answers with the address itself when there's no name.
                    if !n.is_empty() && crate::range::ip(&n).is_none() {
                        found(ip, n);
                    }
                }
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_names() {
        assert_eq!(ip_from_reverse("5.1.168.192.in-addr.arpa"), crate::range::ip("192.168.1.5"));
        assert_eq!(ip_from_reverse("example.com"), None);
    }

    #[test]
    fn ptr_round_trip() {
        // A made-up reply: the question echoed, then a PTR answer pointing at "printer.local".
        let mut r = ptr_query(crate::range::ip("10.0.0.7").unwrap(), 1, false);
        r[2] = 0x84;
        r[7] = 1; // one answer
        r.extend([0xC0, 12, 0, 12, 0, 1, 0, 0, 0, 10]);
        let name: Vec<u8> = [7u8].iter().copied().chain(*b"printer").chain([5u8]).chain(*b"local").chain([0u8]).collect();
        r.extend([0, name.len() as u8]);
        r.extend(name);
        assert_eq!(parse_ptr_answers(&r), vec![(crate::range::ip("10.0.0.7").unwrap(), "printer".to_string())]);
    }
}
