//! Joining and forgetting Wi-Fi networks with NetworkManager (`nmcli`), for the Bluetooth setup. Networks the sensor
//! is given over Bluetooth are saved as "arpradar-…" connections, so Forget only removes those.

use std::process::Command;

const PREFIX: &str = "arpradar-";

fn nmcli(args: &[&str]) -> Result<String, String> {
    let out = Command::new("nmcli").args(args).output().map_err(|e| format!("nmcli: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().replace("Error: ", "");
        Err(if err.is_empty() { "Couldn\u{2019}t join that network.".into() } else { err })
    }
}

/// Joins `ssid` (WPA/WPA2/WPA3 personal, or open when the password is blank). Up to about 30 s.
pub fn join(ssid: &str, password: &str) -> Result<(), String> {
    if ssid.trim().is_empty() || ssid.len() > 32 {
        return Err("That isn\u{2019}t a Wi-Fi network name.".into());
    }
    let name = format!("{PREFIX}{ssid}");
    let _ = nmcli(&["connection", "delete", &name]);
    let _ = nmcli(&["device", "wifi", "rescan", "ifname", "wlan0"]);
    let mut args = vec!["--wait", "30", "device", "wifi", "connect", ssid, "ifname", "wlan0", "name", &name];
    if !password.is_empty() {
        args.extend(["password", password]);
    }
    nmcli(&args).map(|_| ())
}

/// Deletes every network given over Bluetooth. Returns how many.
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
