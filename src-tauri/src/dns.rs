//! DNS Lookup without `dig` (Windows has none): builds the question, sends it over UDP (TCP when the answer is
//! too big), and turns each answer into text the way dig prints it.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Answer {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ttl: u32,
    pub data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub answers: Vec<Answer>,
    pub ms: u64,
    pub server: String,
    /// "NXDOMAIN", "SERVFAIL", "REFUSED"... (empty when fine)
    pub status: String,
}

const TYPES: &[(&str, u16)] = &[("A", 1), ("NS", 2), ("CNAME", 5), ("SOA", 6), ("PTR", 12), ("MX", 15), ("TXT", 16), ("AAAA", 28), ("SRV", 33), ("DS", 43), ("DNSKEY", 48), ("CAA", 257)];

pub fn type_code(name: &str) -> Option<u16> {
    TYPES.iter().find(|t| t.0.eq_ignore_ascii_case(name)).map(|t| t.1)
}
fn type_name(code: u16) -> String {
    TYPES.iter().find(|t| t.1 == code).map(|t| t.0.to_string()).unwrap_or_else(|| format!("TYPE{code}"))
}

/// 10.0.0.5 -> 5.0.0.10.in-addr.arpa
pub fn reverse_name(ip: Ipv4Addr) -> String {
    let o = ip.octets();
    format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
}

pub fn question(name: &str, qtype: u16, id: u16) -> Vec<u8> {
    let mut q = vec![(id >> 8) as u8, id as u8, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in name.trim_end_matches('.').split('.').filter(|l| !l.is_empty()) {
        let b = label.as_bytes();
        q.push(b.len().min(63) as u8);
        q.extend(&b[..b.len().min(63)]);
    }
    q.extend([0, (qtype >> 8) as u8, qtype as u8, 0, 1]);
    q
}

/// This PC's DNS server (the default adapter's first one).
pub fn system_server() -> Option<IpAddr> {
    let mut list: Vec<IpAddr> = netdev::get_default_interface().map(|i| i.dns_servers).unwrap_or_default();
    if list.is_empty() {
        if let Ok(t) = std::fs::read_to_string("/etc/resolv.conf") {
            list = t.lines().filter_map(|l| l.strip_prefix("nameserver")).filter_map(|a| a.trim().parse().ok()).collect();
        }
    }
    list.iter().find(|a| a.is_ipv4()).or(list.first()).copied()
}

/// One question to one server. `server` empty = this PC's DNS.
pub fn lookup(name: &str, qtype: &str, server: &str) -> Result<Reply, String> {
    let name = name.trim().trim_end_matches('.');
    let (qname, code) = match (name.parse::<Ipv4Addr>(), qtype) {
        (Ok(ip), "A" | "PTR") => (reverse_name(ip), 12),
        _ => (name.to_string(), type_code(qtype).ok_or_else(|| format!("Unknown record type {qtype}"))?),
    };
    let server_ip: IpAddr = if server.trim().is_empty() {
        system_server().ok_or("Couldn\u{2019}t find this PC\u{2019}s DNS server.")?
    } else {
        match server.trim().parse() {
            Ok(a) => a,
            Err(_) => crate::tools::resolve(server.trim()).map(IpAddr::V4).ok_or_else(|| format!("Couldn\u{2019}t find the server {server}."))?,
        }
    };
    let to = SocketAddr::new(server_ip, 53);
    let id = (Instant::now().elapsed().subsec_nanos() as u16) ^ 0x5A5A;
    let q = question(&qname, code, id);
    let start = Instant::now();
    let sock = UdpSocket::bind(if server_ip.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).map_err(|e| e.to_string())?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();
    sock.send_to(&q, to).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 4096];
    let mut reply = loop {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) if from.ip() == server_ip && n >= 12 && buf[0] == q[0] && buf[1] == q[1] => break buf[..n].to_vec(),
            Ok(_) => continue,
            Err(_) => return Err(format!("No answer from {server_ip}.")),
        }
    };
    // Truncated: ask again over TCP.
    if reply[2] & 0x02 != 0 {
        if let Ok(mut t) = TcpStream::connect_timeout(&to, Duration::from_secs(3)) {
            t.set_read_timeout(Some(Duration::from_secs(3))).ok();
            let mut framed = vec![(q.len() >> 8) as u8, q.len() as u8];
            framed.extend(&q);
            if t.write_all(&framed).is_ok() {
                let mut len = [0u8; 2];
                if t.read_exact(&mut len).is_ok() {
                    let mut full = vec![0u8; u16::from_be_bytes(len) as usize];
                    if t.read_exact(&mut full).is_ok() {
                        reply = full;
                    }
                }
            }
        }
    }
    let ms = start.elapsed().as_millis() as u64;
    let status = match reply[3] & 0x0F {
        0 => "",
        1 => "FORMERR",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        5 => "REFUSED",
        _ => "ERROR",
    };
    Ok(Reply { answers: parse_answers(&reply), ms, server: server_ip.to_string(), status: status.into() })
}

pub fn parse_answers(b: &[u8]) -> Vec<Answer> {
    let mut out = Vec::new();
    if b.len() < 12 {
        return out;
    }
    let qd = u16::from_be_bytes([b[4], b[5]]);
    let an = u16::from_be_bytes([b[6], b[7]]);
    let mut o = 12;
    for _ in 0..qd {
        if crate::names::read_name(b, &mut o).is_none() {
            return out;
        }
        o += 4;
    }
    for _ in 0..an {
        let Some(name) = crate::names::read_name(b, &mut o) else { break };
        if o + 10 > b.len() {
            break;
        }
        let t = u16::from_be_bytes([b[o], b[o + 1]]);
        let ttl = u32::from_be_bytes([b[o + 4], b[o + 5], b[o + 6], b[o + 7]]);
        let len = u16::from_be_bytes([b[o + 8], b[o + 9]]) as usize;
        o += 10;
        if o + len > b.len() {
            break;
        }
        let data = rdata(b, o, len, t);
        out.push(Answer { name, kind: type_name(t), ttl, data });
        o += len;
    }
    out
}

fn rdata(b: &[u8], o: usize, len: usize, t: u16) -> String {
    let r = &b[o..o + len];
    let name_at = |at: usize| {
        let mut p = at;
        crate::names::read_name(b, &mut p).map(|n| format!("{n}.")).unwrap_or_default()
    };
    let u16_at = |i: usize| u16::from_be_bytes([r[i], r[i + 1]]);
    let u32_at = |i: usize| u32::from_be_bytes([r[i], r[i + 1], r[i + 2], r[i + 3]]);
    match t {
        1 if len == 4 => Ipv4Addr::new(r[0], r[1], r[2], r[3]).to_string(),
        28 if len == 16 => Ipv6Addr::from(<[u8; 16]>::try_from(r).unwrap()).to_string(),
        2 | 5 | 12 => name_at(o),
        15 if len > 2 => format!("{} {}", u16_at(0), name_at(o + 2)),
        33 if len > 6 => format!("{} {} {} {}", u16_at(0), u16_at(2), u16_at(4), name_at(o + 6)),
        6 => {
            let mut p = o;
            let mname = crate::names::read_name(b, &mut p).unwrap_or_default();
            let rname = crate::names::read_name(b, &mut p).unwrap_or_default();
            if p + 20 > o + len {
                return String::new();
            }
            let n = |i: usize| u32::from_be_bytes([b[p + i], b[p + i + 1], b[p + i + 2], b[p + i + 3]]);
            format!("{mname}. {rname}. {} {} {} {} {}", n(0), n(4), n(8), n(12), n(16))
        }
        16 => {
            let mut parts = Vec::new();
            let mut i = 0;
            while i < len {
                let l = r[i] as usize;
                let end = (i + 1 + l).min(len);
                parts.push(format!("\"{}\"", String::from_utf8_lossy(&r[i + 1..end]).replace('"', "\\\"")));
                i = end;
            }
            parts.join(" ")
        }
        // DNSSEC: DS = key tag, algorithm, digest type, digest; DNSKEY = flags, protocol, algorithm (key not shown).
        43 if len > 4 => format!("{} {} {} {}", u16_at(0), r[2], r[3], r[4..].iter().map(|x| format!("{x:02X}")).collect::<String>()),
        48 if len > 4 => format!("{} {} {} ({} byte key)", u16_at(0), r[2], r[3], len - 4),
        257 if len > 2 => {
            let tl = r[1] as usize;
            let tag = String::from_utf8_lossy(&r[2..(2 + tl).min(len)]);
            let value = String::from_utf8_lossy(&r[(2 + tl).min(len)..]);
            format!("{} {tag} \"{value}\"", r[0])
        }
        _ => {
            let _ = u32_at;
            r.iter().map(|x| format!("{x:02x}")).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_and_answers() {
        let q = question("example.com", 15, 7);
        assert_eq!(&q[12..25], b"\x07example\x03com\x00");
        // A made-up reply: the question, then an MX answer "10 mail.example.com." (name compressed to the question).
        let mut r = q.clone();
        r[2] = 0x81;
        r[3] = 0x80;
        r[7] = 1;
        r.extend([0xC0, 12, 0, 15, 0, 1, 0, 0, 0x0E, 0x10]);
        let rd: Vec<u8> = [0u8, 10, 4].iter().copied().chain(*b"mail").chain([0xC0, 12]).collect();
        r.extend([0, rd.len() as u8]);
        r.extend(rd);
        assert_eq!(parse_answers(&r), vec![Answer { name: "example.com".into(), kind: "MX".into(), ttl: 3600, data: "10 mail.example.com.".into() }]);
        assert_eq!(reverse_name(Ipv4Addr::new(10, 0, 0, 5)), "5.0.0.10.in-addr.arpa");
    }
}
