//! The parts that differ per system: ping, MAC addresses, the computer's name.
//! Windows uses its built-in IP Helper functions (no admin rights needed).
//! Linux (the desktop version and the Pi sensor) pings with an unprivileged ICMP socket and reads /proc/net/arp,
//! falling back to the `ping` command when the system doesn't allow ICMP sockets. macOS (used only to try the app on
//! Sean's Mac while building it) uses the `ping` and `arp` commands.

#[cfg(not(windows))]
use std::collections::HashMap;

/// One ping. Returns the round-trip time in milliseconds, or None if nothing answered.
#[cfg(windows)]
pub fn ping(ip: u32, timeout_ms: u32) -> Option<f64> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY};
    unsafe {
        let h = IcmpCreateFile();
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        let data = *b"ARPradar ping";
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + data.len() + 64];
        let start = std::time::Instant::now();
        let n = IcmpSendEcho(
            h,
            u32::from_ne_bytes(std::net::Ipv4Addr::from(ip).octets()),
            data.as_ptr().cast(),
            data.len() as u16,
            std::ptr::null(),
            reply.as_mut_ptr().cast(),
            reply.len() as u32,
            timeout_ms,
        );
        IcmpCloseHandle(h);
        if n == 0 {
            return None;
        }
        let r = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        // Status 0 = a real echo reply from that address (not "unreachable" from a router).
        if r.Status != 0 || u32::from_be_bytes(r.Address.to_ne_bytes()) != ip {
            return None;
        }
        // Windows rounds to whole milliseconds; under 1 ms use our own clock for a finer number.
        let ms = r.RoundTripTime as f64;
        Some(if ms < 1.0 { (start.elapsed().as_secs_f64() * 1000.0).min(0.99) } else { ms })
    }
}

/// Linux: an unprivileged ICMP "ping socket" (allowed by net.ipv4.ping_group_range, which systemd opens to every
/// user); the `ping` command when that's refused.
#[cfg(target_os = "linux")]
pub fn ping(ip: u32, timeout_ms: u32) -> Option<f64> {
    match icmp_socket_ping(ip, timeout_ms) {
        Ok(r) => r,
        Err(_) => ping_command(ip, timeout_ms),
    }
}

#[cfg(target_os = "linux")]
fn icmp_socket_ping(ip: u32, timeout_ms: u32) -> std::io::Result<Option<f64>> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::mem::MaybeUninit;
    use std::time::{Duration, Instant};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
    let to = SockAddr::from(std::net::SocketAddrV4::new(std::net::Ipv4Addr::from(ip), 0));
    let seq = (ip as u16) ^ 0x5241;
    // Echo request; the kernel fills in the identifier for a ping socket.
    let mut pkt = [8u8, 0, 0, 0, 0, 0, (seq >> 8) as u8, seq as u8, b'A', b'R', b'P', b'r', b'a', b'd', b'a', b'r'];
    let sum = icmp_checksum(&pkt);
    pkt[2] = (sum >> 8) as u8;
    pkt[3] = sum as u8;
    let start = Instant::now();
    s.send_to(&pkt, &to)?;
    let deadline = Duration::from_millis(timeout_ms as u64);
    let mut buf = [MaybeUninit::<u8>::uninit(); 256];
    loop {
        let left = deadline.checked_sub(start.elapsed()).filter(|d| !d.is_zero());
        let Some(left) = left else { return Ok(None) };
        s.set_read_timeout(Some(left))?;
        let (n, from) = match s.recv_from(&mut buf) {
            Ok(r) => r,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Ok(None),
            Err(e) => return Err(e),
        };
        let got: Vec<u8> = buf[..n].iter().map(|b| unsafe { b.assume_init() }).collect();
        let from_ip = from.as_socket_ipv4().map(|a| u32::from(*a.ip()));
        // A ping socket gets the ICMP part only (no IP header): type 0 = echo reply.
        if n >= 8 && got[0] == 0 && from_ip == Some(ip) && u16::from_be_bytes([got[6], got[7]]) == seq {
            return Ok(Some(start.elapsed().as_secs_f64() * 1000.0));
        }
    }
}

#[cfg(target_os = "linux")]
fn icmp_checksum(b: &[u8]) -> u16 {
    let mut sum: u32 = b.chunks(2).map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))).sum();
    while sum > 0xFFFF {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub fn ping(ip: u32, timeout_ms: u32) -> Option<f64> {
    ping_command(ip, timeout_ms)
}

#[cfg(not(windows))]
fn ping_command(ip: u32, timeout_ms: u32) -> Option<f64> {
    let wait = if cfg!(target_os = "macos") { timeout_ms.to_string() } else { (timeout_ms / 1000).max(1).to_string() };
    let out = std::process::Command::new("ping")
        .args(["-c", "1", "-W", &wait, &crate::range::text(ip)])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let at = text.find("time=")?;
    text[at + 5..].split(|c: char| !(c.is_ascii_digit() || c == '.')).next()?.parse().ok()
}

/// Asks one address on this PC's own subnet for its MAC address (an ARP request).
/// Answers even when the device ignores ping and has no open ports.
#[cfg(windows)]
pub fn arp(ip: u32) -> Option<String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::SendARP;
    let mut mac = [0u8; 8];
    let mut len: u32 = 6;
    let r = unsafe { SendARP(u32::from_ne_bytes(std::net::Ipv4Addr::from(ip).octets()), 0, mac.as_mut_ptr().cast(), &mut len) };
    if r != 0 || len < 6 || mac[..6].iter().all(|&b| b == 0) {
        return None;
    }
    Some(format_mac(&mac[..6]))
}

/// Linux: the kernel's ARP table, already filled in by the ping sweep (no `arp` command needed).
#[cfg(target_os = "linux")]
pub fn arp_table() -> HashMap<u32, String> {
    parse_proc_arp(&std::fs::read_to_string("/proc/net/arp").unwrap_or_default())
}

/// "IP address  HW type  Flags  HW address  Mask  Device" rows; flag 0x2 = a complete entry.
#[cfg(not(windows))]
pub fn parse_proc_arp(text: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || u32::from_str_radix(f[2].trim_start_matches("0x"), 16).unwrap_or(0) & 2 == 0 {
            continue;
        }
        let Some(ip) = crate::range::ip(f[0]) else { continue };
        let bytes: Vec<u8> = f[3].split(':').filter_map(|p| u8::from_str_radix(p, 16).ok()).collect();
        if bytes.len() == 6 && bytes.iter().any(|&x| x != 0) && bytes[0] != 0xff {
            out.insert(ip, format_mac(&bytes));
        }
    }
    out
}

/// macOS: the ARP table, already filled in by the ping sweep.
#[cfg(all(not(windows), not(target_os = "linux")))]
pub fn arp_table() -> HashMap<u32, String> {
    let mut out = HashMap::new();
    if let Ok(o) = std::process::Command::new("arp").arg("-an").output() {
        // "? (192.168.1.5) at 3c:22:fb:1:2:3 on en0 ifscope [ethernet]"
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let (Some(a), Some(b)) = (line.find('('), line.find(')')) else { continue };
            let Some(ip) = crate::range::ip(&line[a + 1..b]) else { continue };
            let Some(mac) = line[b..].split_whitespace().nth(2) else { continue };
            let bytes: Vec<u8> = mac.split(':').filter_map(|p| u8::from_str_radix(p, 16).ok()).collect();
            if bytes.len() == 6 && bytes.iter().any(|&x| x != 0) && bytes[0] != 0xff {
                out.insert(ip, format_mac(&bytes));
            }
        }
    }
    out
}

pub fn format_mac(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":")
}

/// This computer's name, for its own row.
pub fn computer_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(n) = std::env::var(key) {
            if !n.is_empty() {
                return n;
            }
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().trim_end_matches(".local").to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "This PC".into())
}

/// The network adapters with an IPv4 address (Wi-Fi, Ethernet, USB, VPN).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub id: String,
    pub display_name: String,
    pub address: String,
    pub prefix: u8,
    pub mac: String,
    pub suggested_range: String,
    pub is_default: bool,
}

pub fn adapters() -> Vec<Adapter> {
    let mut out = Vec::new();
    for i in netdev::get_interfaces() {
        if i.is_loopback() || !i.is_up() {
            continue;
        }
        let label = i.friendly_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| i.name.clone());
        for net in &i.ipv4 {
            let addr = u32::from(net.addr());
            let prefix = net.prefix_len();
            if addr >> 16 == 0xA9FE {
                continue; // 169.254.x.x: no DHCP answer, nothing to scan
            }
            out.push(Adapter {
                id: format!("{}|{}", i.name, crate::range::text(addr)),
                display_name: format!("{label} \u{00b7} {}/{prefix}", crate::range::text(addr)),
                address: crate::range::text(addr),
                prefix,
                mac: i.mac_addr.map(|m| format_mac(&m.octets())).unwrap_or_default(),
                suggested_range: suggested_range(addr, prefix),
                is_default: i.default,
            });
        }
    }
    // The adapter with the default route first.
    out.sort_by_key(|a| !a.is_default);
    out
}

/// The adapter's whole subnet, or the /24 around its address if the subnet is bigger than /22.
pub fn suggested_range(addr: u32, prefix: u8) -> String {
    let bits = if prefix < 22 { 24 } else { prefix.min(32) as u32 };
    let mask: u32 = if bits == 0 { 0 } else { !0u32 << (32 - bits) };
    let net = addr & mask;
    if bits >= 31 {
        return crate::range::text(addr);
    }
    let (lo, hi) = (net + 1, (net | !mask) - 1);
    if lo >> 8 == hi >> 8 {
        format!("{}-{}", crate::range::text(lo), hi & 0xFF)
    } else {
        format!("{}-{}", crate::range::text(lo), crate::range::text(hi))
    }
}

/// Which adapter subnets a target sits on (ARP only works on the local subnet).
pub fn local_subnets() -> Vec<(u32, u32)> {
    adapters()
        .iter()
        .filter_map(|a| {
            let addr = crate::range::ip(&a.address)?;
            let mask: u32 = if a.prefix == 0 { 0 } else { !0u32 << (32 - a.prefix as u32) };
            Some((addr & mask, mask))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn ranges() {
        let ip = |s| crate::range::ip(s).unwrap();
        assert_eq!(super::suggested_range(ip("192.168.1.23"), 24), "192.168.1.1-254");
        assert_eq!(super::suggested_range(ip("10.1.2.3"), 8), "10.1.2.1-254");
        assert_eq!(super::suggested_range(ip("10.1.2.3"), 23), "10.1.2.1-10.1.3.254");
    }

    #[cfg(not(windows))]
    #[test]
    fn proc_arp() {
        let text = "IP address       HW type     Flags       HW address            Mask     Device\n\
                    10.20.30.1       0x1         0x2         02:00:00:00:00:01     *        wlan0\n\
                    10.20.30.7       0x1         0x0         00:00:00:00:00:00     *        wlan0\n\
                    10.20.30.9       0x1         0x2         aa:00:00:00:00:09     *        eth0\n";
        let t = super::parse_proc_arp(text);
        assert_eq!(t.len(), 2);
        assert_eq!(t[&crate::range::ip("10.20.30.1").unwrap()], "02:00:00:00:00:01");
        assert_eq!(t[&crate::range::ip("10.20.30.9").unwrap()], "AA:00:00:00:00:09");
    }
}

/// One traceroute step: a ping that may only travel `ttl` routers. Returns who answered (the router where it
/// ran out, or the target itself), the time, and whether that was the target.
#[cfg(windows)]
pub fn hop(ip: u32, ttl: u8, timeout_ms: u32) -> Option<(u32, f64, bool)> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION};
    unsafe {
        let h = IcmpCreateFile();
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        let data = *b"ARPradar trace";
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + data.len() + 64];
        let opts = IP_OPTION_INFORMATION { Ttl: ttl, Tos: 0, Flags: 0, OptionsSize: 0, OptionsData: std::ptr::null_mut() };
        let start = std::time::Instant::now();
        let n = IcmpSendEcho(h, u32::from_ne_bytes(std::net::Ipv4Addr::from(ip).octets()), data.as_ptr().cast(), data.len() as u16,
                             &opts, reply.as_mut_ptr().cast(), reply.len() as u32, timeout_ms);
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        IcmpCloseHandle(h);
        if n == 0 {
            return None;
        }
        let r = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        let from = u32::from_be_bytes(r.Address.to_ne_bytes());
        // 0 = reached the target; 11013 = TTL expired on the way (a router answered); 11003/11002 = unreachable.
        match r.Status {
            0 => Some((from, if r.RoundTripTime > 0 { r.RoundTripTime as f64 } else { ms }, true)),
            11013 | 11014 => Some((from, ms, false)),
            11002 | 11003 | 11004 | 11005 if from != 0 => Some((from, ms, true)),
            _ => None,
        }
    }
}

#[cfg(not(windows))]
pub fn hop(ip: u32, ttl: u8, timeout_ms: u32) -> Option<(u32, f64, bool)> {
    let mac = cfg!(target_os = "macos");
    let ttl_flag = if mac { "-m" } else { "-t" };
    let wait = if mac { timeout_ms.to_string() } else { (timeout_ms / 1000).max(1).to_string() };
    let start = std::time::Instant::now();
    let out = std::process::Command::new("ping").args(["-n", "-c", "1", ttl_flag, &ttl.to_string(), "-W", &wait, &crate::range::text(ip)]).output().ok()?;
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    for line in text.lines() {
        let lower = line.to_lowercase();
        let Some(at) = lower.find("from ") else { continue };
        let addr: String = line[at + 5..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let Some(from) = crate::range::ip(&addr) else { continue };
        let reached = from == ip && !lower.contains("exceeded");
        let time = lower.find("time=").and_then(|t| lower[t + 5..].split(|c: char| !(c.is_ascii_digit() || c == '.')).next()?.parse().ok());
        return Some((from, time.unwrap_or(ms), reached));
    }
    None
}
