//! Wi-Fi for the one-step scan, with NetworkManager (`nmcli`): a network given over Bluetooth is joined as the
//! connection "arpradar-scan" (never auto-joined), used for one scan, then deleted, so no client password stays on
//! the sensor. NetworkManager then goes back to the sensor's own Wi-Fi by itself.

use serde::Serialize;
use std::process::Command;

const SCAN_CONNECTION: &str = "arpradar-scan";
const PREFIX: &str = "arpradar-";

fn nmcli(args: &[&str]) -> Result<String, String> {
    let out = Command::new("nmcli").args(args).output().map_err(|e| format!("nmcli: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().replace("Error: ", "");
        Err(if err.is_empty() { "couldn\u{2019}t join that network".into() } else { err })
    }
}

/// Joins `ssid` for one scan (WPA/WPA2/WPA3 personal, or open when the password is blank). Up to about 30 s.
pub fn join_for_scan(ssid: &str, password: &str) -> Result<(), String> {
    if ssid.len() > 32 {
        return Err("that isn\u{2019}t a Wi-Fi network name".into());
    }
    leave_scan_network();
    let _ = nmcli(&["device", "wifi", "rescan", "ifname", "wlan0"]);
    let mut args = vec!["--wait", "30", "device", "wifi", "connect", ssid, "ifname", "wlan0", "name", SCAN_CONNECTION];
    if !password.is_empty() {
        args.extend(["password", password]);
    }
    nmcli(&args)?;
    let _ = nmcli(&["connection", "modify", SCAN_CONNECTION, "connection.autoconnect", "no"]);
    Ok(())
}

/// Leaves the scan's network and deletes it (and its password).
pub fn leave_scan_network() {
    let _ = nmcli(&["connection", "delete", SCAN_CONNECTION]);
}

/// Deletes every arpradar-… connection (left over if the power was pulled mid-scan). Returns how many.
pub fn forget() -> usize {
    let list = nmcli(&["-t", "-f", "NAME", "connection", "show"]).unwrap_or_default();
    list.lines().filter(|n| n.starts_with(PREFIX)).filter(|n| nmcli(&["connection", "delete", n]).is_ok()).count()
}

/// The Wi-Fi network wlan0 is on and its IPv4 address.
pub fn current() -> (String, String) {
    let ssid = nmcli(&["-t", "-f", "ACTIVE,SSID", "device", "wifi"])
        .unwrap_or_default()
        .lines()
        .find_map(|l| l.strip_prefix("yes:").map(|s| s.replace("\\:", ":")))
        .unwrap_or_default();
    let ip = nmcli(&["-t", "-f", "IP4.ADDRESS", "device", "show", "wlan0"])
        .unwrap_or_default()
        .lines()
        .find_map(|l| l.split_once(':').map(|(_, v)| v.split('/').next().unwrap_or("").to_string()))
        .unwrap_or_default();
    (ssid, ip)
}

/// wlan0's own range (after joining a network for a scan).
pub fn wlan_range() -> Option<String> {
    crate::sys::adapters().into_iter().find(|a| a.id.starts_with("wlan0|")).map(|a| a.suggested_range)
}

#[derive(Serialize)]
pub struct Network {
    pub ssid: String,
    pub signal: u8,
    pub secure: bool,
}

/// Wi-Fi networks in range, strongest first, one entry per name.
pub fn nearby() -> Vec<Network> {
    let text = nmcli(&["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"]).unwrap_or_default();
    let mut out: Vec<Network> = Vec::new();
    for line in text.lines() {
        // Fields are ':'-separated with '\:' inside names; SECURITY and SIGNAL never contain ':'.
        let mut parts = line.rsplitn(3, ':');
        let (Some(sec), Some(sig), Some(ssid)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let ssid = ssid.replace("\\:", ":");
        if ssid.is_empty() {
            continue;
        }
        let signal = sig.parse().unwrap_or(0);
        match out.iter_mut().find(|n| n.ssid == ssid) {
            Some(n) => n.signal = n.signal.max(signal),
            None => out.push(Network { ssid, signal, secure: !sec.is_empty() && sec != "--" }),
        }
    }
    out.sort_by(|a, b| b.signal.cmp(&a.signal));
    out
}
