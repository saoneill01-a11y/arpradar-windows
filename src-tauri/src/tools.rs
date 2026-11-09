//! The Tools menu's network work: Ping, Traceroute, Public IP and Speed Test.

use crate::scan::par_map;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// An IPv4 address as typed, or the first IPv4 address a name resolves to.
pub fn resolve(text: &str) -> Option<Ipv4Addr> {
    let t = text.trim();
    if let Some(ip) = crate::range::ip(t) {
        return Some(Ipv4Addr::from(ip));
    }
    if !crate::web::host_name_ok(t) {
        return None;
    }
    (t, 0).to_socket_addrs().ok()?.find_map(|a| match a.ip() {
        std::net::IpAddr::V4(v) => Some(v),
        _ => None,
    })
}

// MARK: Ping

/// One round: pings every target once, all at once. Values are ms, or null when nothing came back.
pub fn ping_round(ips: &[u32], timeout_ms: u32) -> HashMap<String, Option<f64>> {
    let never = AtomicBool::new(false);
    par_map(ips, 32, &never, |&ip| Some((crate::range::text(ip), crate::sys::ping(ip, timeout_ms)))).into_iter().collect()
}

// MARK: Traceroute

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub number: u8,
    pub address: String,
    pub name: String,
    pub ms: Option<f64>,
}

/// Asks every TTL from 1 to 30 at once (so a full trace takes seconds, not a minute), then reports hops in order
/// up to the target. Names come from reverse DNS afterwards.
pub fn trace(ip: u32, cancel: &AtomicBool, report: impl Fn(Hop)) -> usize {
    let ttls: Vec<u8> = (1..=30).collect();
    let mut answers: HashMap<u8, (u32, f64, bool)> = par_map(&ttls, 30, cancel, |&t| crate::sys::hop(ip, t, 2000).map(|a| (t, a))).into_iter().collect();
    if cancel.load(Ordering::Relaxed) {
        return 0;
    }
    let last = answers.iter().filter(|(_, a)| a.2).map(|(t, _)| *t).min().unwrap_or(30);
    answers.retain(|t, _| *t <= last);
    let addrs: Vec<u32> = answers.values().map(|a| a.0).collect::<std::collections::HashSet<_>>().into_iter().collect();
    let names: HashMap<u32, String> = par_map(&addrs, 16, cancel, |&a| {
        dns_lookup::lookup_addr(&std::net::IpAddr::V4(Ipv4Addr::from(a))).ok().filter(|n| crate::range::ip(n).is_none()).map(|n| (a, n))
    })
    .into_iter()
    .collect();
    for t in 1..=last {
        let hop = match answers.get(&t) {
            Some(&(a, ms, _)) => Hop { number: t, address: crate::range::text(a), name: names.get(&a).cloned().unwrap_or_default(), ms: Some(ms) },
            None => Hop { number: t, address: "*".into(), name: String::new(), ms: None },
        };
        report(hop);
    }
    last as usize
}

// MARK: HTTPS by host name (public IP, speed test)

fn tls_to(host: &str, port: u16, timeout: Duration) -> Result<native_tls::TlsStream<TcpStream>, String> {
    let addr = (host, port).to_socket_addrs().map_err(|_| format!("Couldn\u{2019}t find {host}."))?.next().ok_or(format!("Couldn\u{2019}t find {host}."))?;
    let tcp = TcpStream::connect_timeout(&addr, timeout).map_err(|_| format!("Couldn\u{2019}t reach {host}."))?;
    tcp.set_read_timeout(Some(timeout)).ok();
    tcp.set_write_timeout(Some(timeout)).ok();
    tcp.set_nodelay(true).ok();
    let c = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    c.connect(host, tcp).map_err(|_| format!("Couldn\u{2019}t open a secure connection to {host}."))
}

/// This network's public address, from api.ipify.org (asked only when Sean clicks Look Up).
pub fn public_ip() -> Result<String, String> {
    let mut s = tls_to("api.ipify.org", 443, Duration::from_secs(5))?;
    s.write_all(b"GET / HTTP/1.0\r\nHost: api.ipify.org\r\nUser-Agent: ARPradar\r\n\r\n").map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    let _ = s.read_to_end(&mut data);
    let page = crate::identify::parse_response(&data).ok_or("No answer from api.ipify.org.")?;
    let ip = String::from_utf8_lossy(&page.body).trim().to_string();
    if ip.parse::<std::net::IpAddr>().is_ok() { Ok(ip) } else { Err("Unexpected answer from api.ipify.org.".into()) }
}

// MARK: Speed test (Cloudflare's speed test servers)

const SPEED_HOST: &str = "speed.cloudflare.com";

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeedEvent {
    Phase { phase: String },
    Live { phase: String, mbps: f64 },
    Done { down_mbps: f64, up_mbps: f64, idle_ms: f64, loaded_ms: f64, server: String },
    Failed { message: String },
}

type Tls = native_tls::TlsStream<TcpStream>;

/// Set when Cloudflare answers "429 Too Many Requests" (it limits how often one address may run the test).
static LIMITED: AtomicBool = AtomicBool::new(false);
const LIMITED_TEXT: &str = "Cloudflare\u{2019}s speed test says this network has run too many tests lately. Try again in an hour.";

/// Reads one HTTP response's head; returns (status, Content-Length, Cloudflare's own time in ms).
fn read_head(s: &mut Tls) -> Option<(u16, usize, f64)> {
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut b).ok()?;
        head.push(b[0]);
        if head.len() > 16 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let status: u16 = text.split_whitespace().nth(1)?.parse().ok()?;
    let len = crate::identify::header(&text, "content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    // "Server-Timing: cfSpeedEdge;dur=11, cfSpeedWorker;dur=36": time Cloudflare spent on its side (added up).
    let dur = crate::identify::header(&text, "server-timing")
        .map(|v| v.split("dur=").skip(1).filter_map(|d| d.split([',', ';']).next()?.trim().parse::<f64>().ok()).sum())
        .unwrap_or(0.0);
    Some((status, len, dur))
}

fn skip_body(s: &mut Tls, mut len: usize, bytes: Option<&AtomicU64>, end: Option<Instant>) -> bool {
    let mut buf = vec![0u8; 64 * 1024];
    while len > 0 {
        if end.is_some_and(|e| Instant::now() >= e) {
            return false;
        }
        match s.read(&mut buf[..len.min(64 * 1024)]) {
            Ok(0) | Err(_) => return false,
            Ok(n) => {
                len -= n;
                if let Some(b) = bytes {
                    b.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
    }
    true
}

/// Round trip to Cloudflare: time to the answer of an empty download, minus Cloudflare's own processing time.
/// Uses an already-open connection, so it measures the network, not the connection setup.
fn latency_on(s: &mut Tls) -> Option<f64> {
    let req = format!("GET /__down?bytes=0 HTTP/1.1\r\nHost: {SPEED_HOST}\r\nUser-Agent: ARPradar\r\n\r\n");
    let start = Instant::now();
    s.write_all(req.as_bytes()).ok()?;
    let (status, len, dur) = read_head(s)?;
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    skip_body(s, len, None, None);
    (status == 200).then(|| (ms - dur).max(0.1))
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Runs `streams` connections for `secs` seconds, each repeating `one` (which adds bytes to the counter as they
/// move), and reports the speed every half second. The first 2 seconds (while connections speed up) don't count.
fn measure(phase: &str, streams: usize, secs: f64, cancel: &AtomicBool, report: &(impl Fn(SpeedEvent) + Sync), one: impl Fn(&AtomicU64, Instant) -> bool + Sync) -> f64 {
    const WARMUP: f64 = 2.0;
    let bytes = AtomicU64::new(0);
    let start = Instant::now();
    let end = start + Duration::from_secs_f64(secs + WARMUP);
    let mut base: Option<(u64, Instant)> = None;
    std::thread::scope(|s| {
        for _ in 0..streams {
            s.spawn(|| {
                while Instant::now() < end && !cancel.load(Ordering::Relaxed) {
                    if !one(&bytes, end) {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            });
        }
        while Instant::now() < end && !cancel.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(500));
            let now = bytes.load(Ordering::Relaxed);
            if base.is_none() && start.elapsed().as_secs_f64() >= WARMUP {
                base = Some((now, Instant::now()));
            }
            let (b0, t0) = base.unwrap_or((0, start));
            let t = t0.elapsed().as_secs_f64().max(0.1);
            report(SpeedEvent::Live { phase: phase.into(), mbps: (now - b0) as f64 * 8.0 / t / 1e6 });
        }
    });
    let (b0, t0) = base.unwrap_or((0, start));
    (bytes.load(Ordering::Relaxed) - b0) as f64 * 8.0 / t0.elapsed().as_secs_f64().max(0.1) / 1e6
}

/// One connection downloading 25 MB pieces back to back (Cloudflare refuses pieces of 100 MB).
fn download_once(bytes: &AtomicU64, end: Instant) -> bool {
    let Ok(mut s) = tls_to(SPEED_HOST, 443, Duration::from_secs(5)) else { return false };
    let req = format!("GET /__down?bytes=25000000 HTTP/1.1\r\nHost: {SPEED_HOST}\r\nUser-Agent: ARPradar\r\n\r\n");
    while Instant::now() < end {
        if s.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let (status, len, _) = match read_head(&mut s) { Some(h) => h, None => return false };
        if status == 429 {
            LIMITED.store(true, Ordering::Relaxed);
        }
        if status != 200 {
            return false;
        }
        if !skip_body(&mut s, len, Some(bytes), Some(end)) {
            break;
        }
    }
    true
}

/// One connection uploading 25 MB pieces back to back.
fn upload_once(bytes: &AtomicU64, end: Instant) -> bool {
    const SIZE: usize = 25_000_000;
    let Ok(mut s) = tls_to(SPEED_HOST, 443, Duration::from_secs(5)) else { return false };
    let head = format!("POST /__up HTTP/1.1\r\nHost: {SPEED_HOST}\r\nUser-Agent: ARPradar\r\nContent-Type: application/octet-stream\r\nContent-Length: {SIZE}\r\n\r\n");
    let chunk = vec![0u8; 64 * 1024];
    while Instant::now() < end {
        if s.write_all(head.as_bytes()).is_err() {
            return false;
        }
        let mut sent = 0;
        while sent < SIZE {
            if Instant::now() >= end {
                return true;
            }
            let n = chunk.len().min(SIZE - sent);
            if s.write_all(&chunk[..n]).is_err() {
                return false;
            }
            sent += n;
            bytes.fetch_add(n as u64, Ordering::Relaxed);
        }
        let Some((_, len, _)) = read_head(&mut s) else { return false };
        skip_body(&mut s, len, None, None);
    }
    true
}

/// Idle latency, download (6 connections, 10 s after a 2 s warm-up, with latency measured meanwhile), upload (6 connections, same).
pub fn speed_test(cancel: Arc<AtomicBool>, report: impl Fn(SpeedEvent) + Sync) {
    LIMITED.store(false, Ordering::Relaxed);
    report(SpeedEvent::Phase { phase: "latency".into() });
    let Ok(mut probe) = tls_to(SPEED_HOST, 443, Duration::from_secs(5)) else {
        return report(SpeedEvent::Failed { message: "Couldn\u{2019}t reach Cloudflare\u{2019}s speed test. Is the internet reachable?".into() });
    };
    // Cloudflare limits how often one address may run the test; say so instead of showing 0 Mbps.
    let check = format!("GET /__down?bytes=1000 HTTP/1.1\r\nHost: {SPEED_HOST}\r\nUser-Agent: ARPradar\r\n\r\n");
    match probe.write_all(check.as_bytes()).ok().and_then(|_| read_head(&mut probe)) {
        Some((200, len, _)) => {
            skip_body(&mut probe, len, None, None);
        }
        Some((429, _, _)) => return report(SpeedEvent::Failed { message: LIMITED_TEXT.into() }),
        _ => return report(SpeedEvent::Failed { message: "Cloudflare\u{2019}s speed test didn\u{2019}t answer properly. Try again later.".into() }),
    }
    let idle: Vec<f64> = (0..8).filter_map(|_| latency_on(&mut probe)).collect();
    if idle.is_empty() {
        return report(SpeedEvent::Failed { message: "Couldn\u{2019}t reach Cloudflare\u{2019}s speed test. Is the internet reachable?".into() });
    }
    let idle_ms = median(idle);

    report(SpeedEvent::Phase { phase: "download".into() });
    let loaded = std::sync::Mutex::new(Vec::new());
    let done = AtomicBool::new(false);
    let down = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_secs(2));
            while !done.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
                match latency_on(&mut probe) {
                    Some(ms) => loaded.lock().unwrap().push(ms),
                    None => match tls_to(SPEED_HOST, 443, Duration::from_secs(5)) {
                        Ok(p) => probe = p,
                        Err(_) => break,
                    },
                }
                std::thread::sleep(Duration::from_millis(400));
            }
        });
        let mbps = measure("download", 6, 10.0, &cancel, &report, download_once);
        done.store(true, Ordering::Relaxed);
        mbps
    });
    if cancel.load(Ordering::Relaxed) {
        return report(SpeedEvent::Failed { message: "Stopped".into() });
    }
    if down < 0.01 && LIMITED.load(Ordering::Relaxed) {
        return report(SpeedEvent::Failed { message: LIMITED_TEXT.into() });
    }

    report(SpeedEvent::Phase { phase: "upload".into() });
    let up = measure("upload", 6, 10.0, &cancel, &report, upload_once);
    if cancel.load(Ordering::Relaxed) {
        return report(SpeedEvent::Failed { message: "Stopped".into() });
    }
    let loaded_ms = median(loaded.into_inner().unwrap());
    report(SpeedEvent::Done { down_mbps: down, up_mbps: up, idle_ms, loaded_ms, server: "Cloudflare".into() });
}
