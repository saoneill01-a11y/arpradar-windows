//! Survey: Wi-Fi readings over and over, for a heatmap made while walking (the phone knows where it is, the sensor
//! says what it hears). Each reading is one `iw dev <iface> scan` sweep, turned into a short "wifi" event.
//!
//! The parsing is plain Rust with no system calls, so it's tested on any computer; `run` needs Linux, `iw` and
//! CAP_NET_ADMIN (the service runs as root).

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Keep each event's JSON under this (it goes over Bluetooth in pieces).
pub const MAX_EVENT_BYTES: usize = 4000;

/// One access point (BSS) in a reading. Short field names keep events small.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Ap {
    /// BSSID, lowercase with colons.
    pub b: String,
    /// SSID, "" when hidden.
    pub s: String,
    /// Signal in dBm.
    pub r: i32,
    /// Primary channel.
    pub c: u32,
    /// Channel width in MHz (20 when unknown).
    pub w: u32,
    /// Band: "2.4", "5" or "6".
    pub g: String,
    /// Milliseconds since this BSS was last heard (0 when unknown).
    pub a: u64,
}

/// One reading, as sent: {"type":"wifi","seq","ms","took","iface","aps"}.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Reading {
    #[serde(rename = "type")]
    pub kind: String,
    pub seq: u64,
    /// Sensor clock (milliseconds since the service started, never goes back) when the sweep finished.
    pub ms: u64,
    /// How long the sweep took, in ms.
    pub took: u64,
    pub iface: String,
    pub aps: Vec<Ap>,
}

/// Band and primary channel from a frequency in MHz.
pub fn band_channel(freq: u32) -> Option<(&'static str, u32)> {
    match freq {
        2484 => Some(("2.4", 14)),
        2412..=2472 => Some(("2.4", (freq - 2407) / 5)),
        5955..=7115 => Some(("6", (freq - 5950) / 5)),
        5935 => Some(("6", 2)),
        5150..=5925 => Some(("5", (freq - 5000) / 5)),
        _ => None,
    }
}

/// iw prints SSIDs with odd bytes as \xNN.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'x') {
            if let Some(v) = s.get(i + 2..i + 4).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    let text = String::from_utf8_lossy(&out).into_owned();
    // A hidden network can show as a run of zero bytes.
    if text.chars().all(|c| c == '\0') {
        String::new()
    } else {
        text.chars().filter(|c| !c.is_control()).collect()
    }
}

/// The first number of MHz in a line like "channel width: 1 (80 MHz)", "Channel Width: 160 MHz" or "80+80 MHz".
fn mhz_in(line: &str) -> Option<u32> {
    let l = line.to_ascii_lowercase();
    if l.contains("80+80") {
        return Some(160);
    }
    let at = l.find("mhz")?;
    let digits: String = l[..at].trim_end().chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().ok()
}

#[derive(Default)]
struct Partial {
    bssid: String,
    ssid: Option<String>,
    freq: u32,
    signal: Option<f64>,
    last_ms: u64,
    ht40: bool,
    width: u32,
    section: String,
    vht_code: Option<u32>,
    vht_seg1: u32,
    vht_seg2: u32,
}

impl Partial {
    fn finish(self) -> Option<Ap> {
        let (band, channel) = band_channel(self.freq)?;
        let signal = self.signal?;
        let mut w = self.width;
        // VHT says 80 MHz but a second segment 8 channels away means 160 MHz (the newer way of signalling it).
        if self.vht_code == Some(1) && self.vht_seg2 != 0 {
            w = w.max(if self.vht_seg2.abs_diff(self.vht_seg1) == 8 { 160 } else { 80 });
        }
        if self.ht40 {
            w = w.max(40);
        }
        Some(Ap { b: self.bssid, s: self.ssid.unwrap_or_default(), r: signal.round() as i32, c: channel, w: if w == 0 { 20 } else { w }, g: band.into(), a: self.last_ms })
    }
}

/// Every BSS in `iw dev <iface> scan` (or `scan dump`) output, strongest first.
pub fn parse_iw(text: &str) -> Vec<Ap> {
    let mut out = Vec::new();
    let mut cur: Option<Partial> = None;
    for raw in text.lines() {
        if let Some(rest) = raw.strip_prefix("BSS ") {
            if let Some(p) = cur.take().and_then(Partial::finish) {
                out.push(p);
            }
            let mac: String = rest.chars().take(17).collect::<String>().to_ascii_lowercase();
            cur = (mac.len() == 17 && mac.split(':').count() == 6).then(|| Partial { bssid: mac, ..Default::default() });
            continue;
        }
        let Some(p) = cur.as_mut() else { continue };
        let line = raw.trim().trim_start_matches("* ").trim();
        let lower = line.to_ascii_lowercase();
        // A line with no leading tab-tab is a new section heading (HT operation:, VHT operation:, ...).
        let depth = raw.len() - raw.trim_start_matches('\t').len();
        if depth == 1 {
            p.section = lower.trim_end_matches(':').to_string();
        }
        if depth == 1 {
            if let Some(v) = line.strip_prefix("freq:") {
                p.freq = v.trim().split('.').next().and_then(|f| f.parse().ok()).unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("signal:") {
                p.signal = v.trim().split_whitespace().next().and_then(|f| f.parse().ok());
            } else if let Some(v) = line.strip_prefix("last seen:") {
                let v = v.trim();
                if v.ends_with("ms ago") {
                    p.last_ms = v.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
                }
            } else if let Some(v) = raw.trim_start_matches('\t').strip_prefix("SSID:") {
                if p.ssid.is_none() {
                    p.ssid = Some(unescape(v.strip_prefix(' ').unwrap_or(v)));
                }
            }
            continue;
        }
        let sec = p.section.as_str();
        if sec.starts_with("ht operation") {
            if lower.starts_with("secondary channel offset:") && (lower.contains("above") || lower.contains("below")) {
                p.ht40 = true;
            }
        } else if sec.starts_with("vht operation") {
            if let Some(v) = lower.strip_prefix("channel width:") {
                let code = v.trim().split_whitespace().next().and_then(|n| n.parse::<u32>().ok());
                p.vht_code = code;
                // Code 0 means "20 or 40 MHz": HT operation decides.
                if let Some(m) = mhz_in(v).filter(|_| code.unwrap_or(0) >= 1) {
                    p.width = p.width.max(m);
                }
            } else if let Some(v) = lower.strip_prefix("center freq segment 1:") {
                p.vht_seg1 = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = lower.strip_prefix("center freq segment 2:") {
                p.vht_seg2 = v.trim().parse().unwrap_or(0);
            }
        } else if (sec.starts_with("he operation") || sec.starts_with("eht operation")) && lower.contains("width") {
            if let Some(m) = mhz_in(&lower) {
                p.width = p.width.max(m);
            }
        }
    }
    if let Some(p) = cur.and_then(Partial::finish) {
        out.push(p);
    }
    out.sort_by(|a, b| b.r.cmp(&a.r).then_with(|| a.b.cmp(&b.b)));
    out
}

/// Drops the weakest access points until the event's JSON fits in `max` bytes. `r.aps` must be strongest first.
pub fn trim(r: &mut Reading, max: usize) {
    while !r.aps.is_empty() && serde_json::to_vec(r).map(|v| v.len()).unwrap_or(0) > max {
        // Cut a few at once when far over, then one at a time.
        let over = serde_json::to_vec(r).map(|v| v.len()).unwrap_or(0) - max;
        let cut = (over / 120).clamp(1, r.aps.len());
        r.aps.truncate(r.aps.len() - cut);
    }
}

/// The sensor's clock for `ms`: milliseconds since the program started, never goes back.
pub fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The Wi-Fi interface to measure with: a USB adapter if one is plugged in, else wlan0.
pub fn pick_interface() -> Option<String> {
    let mut list: Vec<(bool, String)> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .flatten()
        .filter(|e| e.path().join("wireless").exists() || e.path().join("phy80211").exists())
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let usb = std::fs::canonicalize(e.path().join("device")).map(|p| p.to_string_lossy().contains("/usb")).unwrap_or(false);
            (usb, name)
        })
        .collect();
    // USB first, then anything that isn't wlan0, then wlan0.
    list.sort_by_key(|(usb, name)| (!usb, name == "wlan0", name.clone()));
    list.into_iter().next().map(|(_, n)| n)
}

fn iw(args: &[&str]) -> Result<String, String> {
    let out = Command::new("iw").args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "iw isn\u{2019}t installed (sudo apt install iw)".to_string() } else { format!("iw: {e}") }
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// One sweep: a fresh scan, or (when the radio is busy with someone else's scan) the latest results the system has.
pub fn sweep(iface: &str) -> Result<Vec<Ap>, String> {
    match iw(&["dev", iface, "scan"]) {
        Ok(text) => Ok(parse_iw(&text)),
        Err(e) if e.contains("-16") || e.to_ascii_lowercase().contains("busy") => iw(&["dev", iface, "scan", "dump"]).map(|t| parse_iw(&t)),
        Err(e) => Err(e),
    }
}

/// Measures until `cancel`: one "wifi" event per sweep through `send`, then "surveyStopped".
pub fn run(interval_ms: u32, cancel: &AtomicBool, send: &dyn Fn(serde_json::Value)) {
    let stopped = |readings: u64, text: &str| {
        let mut v = serde_json::json!({"type": "surveyStopped", "readings": readings});
        if !text.is_empty() {
            v["text"] = text.into();
        }
        send(v);
    };
    let Some(iface) = pick_interface() else { return stopped(0, "This sensor has no Wi-Fi adapter.") };
    // A USB adapter nobody uses may be down; scanning needs it up.
    let _ = Command::new("ip").args(["link", "set", &iface, "up"]).status();
    let mut seq = 0u64;
    let mut failures = 0;
    while !cancel.load(Ordering::Relaxed) {
        let started = Instant::now();
        match sweep(&iface) {
            Ok(aps) => {
                failures = 0;
                seq += 1;
                let mut r = Reading { kind: "wifi".into(), seq, ms: now_ms(), took: started.elapsed().as_millis() as u64, iface: iface.clone(), aps };
                trim(&mut r, MAX_EVENT_BYTES);
                send(serde_json::to_value(&r).unwrap_or_default());
            }
            Err(e) => {
                failures += 1;
                if failures >= 3 || !std::path::Path::new("/sys/class/net").join(&iface).exists() {
                    let text = if e.is_empty() { format!("{iface} stopped answering") } else { e };
                    return stopped(seq, &text);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        let wait = Duration::from_millis(interval_ms as u64).saturating_sub(started.elapsed());
        let until = Instant::now() + wait;
        while Instant::now() < until && !cancel.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(50).min(until - Instant::now()));
        }
    }
    stopped(seq, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shaped like real `iw dev wlan1 scan` output (iw 6.x); names and addresses are made up.
    const SAMPLE: &str = "BSS 02:11:22:33:44:01(on wlan1) -- associated
\tlast seen: 1234.567s [boottime]
\tTSF: 123456789 usec (0d, 00:02:03)
\tfreq: 5180.0
\tbeacon interval: 100 TUs
\tcapability: ESS Privacy SpectrumMgmt (0x0111)
\tsignal: -61.00 dBm
\tlast seen: 120 ms ago
\tInformation elements from Probe Response frame:
\tSSID: Example-Office
\tSupported rates: 6.0* 9.0 12.0* 18.0 24.0* 36.0 48.0 54.0
\tHT capabilities:
\t\tCapabilities: 0x9ef
\t\t\tHT20/HT40
\tHT operation:
\t\t * primary channel: 36
\t\t * secondary channel offset: above
\t\t * STA channel width: any
\tVHT operation:
\t\t * channel width: 1 (80 MHz)
\t\t * center freq segment 1: 42
\t\t * center freq segment 2: 0
\t\t * VHT basic MCS set: 0xfffc
\tHE Operation:
\t\tHE Operation Parameters: (0x003ff4)
BSS 02:11:22:33:44:02(on wlan1)
\tfreq: 2437
\tsignal: -48.00 dBm
\tlast seen: 40 ms ago
\tSSID: Example-Guest
\tDS Parameter set: channel 6
\tHT operation:
\t\t * primary channel: 6
\t\t * secondary channel offset: no secondary
\t\t * STA channel width: 20 MHz
BSS 02:11:22:33:44:03(on wlan1)
\tfreq: 5500
\tsignal: -70.00 dBm
\tlast seen: 2300 ms ago
\tSSID: \\x00\\x00\\x00\\x00
\tHT operation:
\t\t * primary channel: 100
\t\t * secondary channel offset: above
\tVHT operation:
\t\t * channel width: 1 (80 MHz)
\t\t * center freq segment 1: 106
\t\t * center freq segment 2: 114
BSS 02:11:22:33:44:04(on wlan1)
\tfreq: 6115
\tsignal: -66.00 dBm
\tlast seen: 800 ms ago
\tSSID: Example Caf\\xc3\\xa9
\tHE Operation:
\t\tHE Operation Parameters: (0x023ff0)
\t\t\t6 GHz Operation Information
\t\t\t\tPrimary Channel: 33
\t\t\t\tControl: 0x03
\t\t\t\t\tChannel Width: 160 MHz
\t\t\t\tCenter Frequency Segment 0: 39
BSS 02:11:22:33:44:05(on wlan1)
\tfreq: 6275
\tsignal: -74.00 dBm
\tSSID: Example-Lab
\tEHT Operation:
\t\tEHT Operation Parameters: 0x01
\t\t\tChannel Width: 320 MHz
BSS 02:11:22:33:44:06(on wlan1)
\tfreq: 2412
\tSSID: no-signal-line
";

    #[test]
    fn reads_iw_scan_output() {
        let aps = parse_iw(SAMPLE);
        let b: Vec<&str> = aps.iter().map(|a| a.b.as_str()).collect();
        // Strongest first; the one with no signal line is skipped.
        assert_eq!(b, ["02:11:22:33:44:02", "02:11:22:33:44:01", "02:11:22:33:44:04", "02:11:22:33:44:03", "02:11:22:33:44:05"]);
        assert_eq!(aps[1], Ap { b: "02:11:22:33:44:01".into(), s: "Example-Office".into(), r: -61, c: 36, w: 80, g: "5".into(), a: 120 });
        assert_eq!(aps[0], Ap { b: "02:11:22:33:44:02".into(), s: "Example-Guest".into(), r: -48, c: 6, w: 20, g: "2.4".into(), a: 40 });
        assert_eq!((aps[3].s.as_str(), aps[3].w, aps[3].c, aps[3].a), ("", 160, 100, 2300));
        assert_eq!((aps[2].s.as_str(), aps[2].g.as_str(), aps[2].c, aps[2].w), ("Example Caf\u{e9}", "6", 33, 160));
        assert_eq!((aps[4].g.as_str(), aps[4].c, aps[4].w, aps[4].a), ("6", 65, 320, 0));
    }

    #[test]
    fn bands_channels_and_widths() {
        assert_eq!(band_channel(2412), Some(("2.4", 1)));
        assert_eq!(band_channel(2472), Some(("2.4", 13)));
        assert_eq!(band_channel(2484), Some(("2.4", 14)));
        assert_eq!(band_channel(5180), Some(("5", 36)));
        assert_eq!(band_channel(5825), Some(("5", 165)));
        assert_eq!(band_channel(5955), Some(("6", 1)));
        assert_eq!(band_channel(7115), Some(("6", 233)));
        assert_eq!(band_channel(900), None);
        assert_eq!(mhz_in("channel width: 1 (80 MHz)"), Some(80));
        assert_eq!(mhz_in("channel width: 0 (20 or 40 MHz)"), Some(40));
        assert_eq!(mhz_in("Channel Width: 80+80 or 160 MHz"), Some(160));
        assert_eq!(mhz_in("channel width: 320 MHz"), Some(320));
        assert_eq!(mhz_in("STA channel width: any"), None);
    }

    #[test]
    fn trims_to_4_kb_weakest_first() {
        let aps: Vec<Ap> = (0..200)
            .map(|i| Ap { b: format!("02:00:00:00:{:02x}:{:02x}", i / 256, i % 256), s: format!("Example-Net-{i}"), r: -30 - (i as i32 / 3), c: 36, w: 80, g: "5".into(), a: 100 })
            .collect();
        let mut r = Reading { kind: "wifi".into(), seq: 1, ms: 1000, took: 1800, iface: "wlan1".into(), aps: aps.clone() };
        trim(&mut r, MAX_EVENT_BYTES);
        let len = serde_json::to_vec(&r).unwrap().len();
        assert!(len <= MAX_EVENT_BYTES && len > MAX_EVENT_BYTES - 200, "{len}");
        assert_eq!(r.aps[..], aps[..r.aps.len()]);
        // Small readings are left alone.
        let mut small = Reading { kind: "wifi".into(), seq: 2, ms: 0, took: 0, iface: "wlan0".into(), aps: aps[..3].to_vec() };
        trim(&mut small, MAX_EVENT_BYTES);
        assert_eq!(small.aps.len(), 3);
    }

    #[test]
    fn reading_json_shape() {
        let r = Reading { kind: "wifi".into(), seq: 3, ms: 12345, took: 1700, iface: "wlan1".into(), aps: vec![Ap { b: "02:11:22:33:44:01".into(), s: "Example-Office".into(), r: -61, c: 36, w: 80, g: "5".into(), a: 120 }] };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"type":"wifi","seq":3,"ms":12345,"took":1700,"iface":"wlan1","aps":[{"b":"02:11:22:33:44:01","s":"Example-Office","r":-61,"c":36,"w":80,"g":"5","a":120}]}"#
        );
    }
}
