//! Help › Check for Updates…: asks GitHub for the latest ARPradar release (only when clicked), downloads the Windows
//! installer into Downloads, refuses it unless its SHA-256 matches the release notes, and can start it.
//! Same rules as the Mac's Updates.swift.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/saoneill01-a11y/arpradar/releases/latest";
pub const ASSET: &str = "ARPradar-Windows-setup.exe";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub current: String,
    pub newer: bool,
    pub whats_new: String,
    pub url: String,
    pub sha256: String,
}

pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// "1.10.0" > "1.9.2"; a leading "v" is ignored.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.trim().trim_start_matches(['v', 'V']).split('.').map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// The SHA-256 next to `file` in the notes' table: | `ARPradar-Windows-setup.exe` | `abc…` |
pub fn checksum_in(notes: &str, file: &str) -> Option<String> {
    let tag = format!("`{file}`");
    notes.lines().filter(|l| l.contains(&tag)).find_map(|l| {
        l.split('`').find(|p| p.len() == 64 && p.chars().all(|c| c.is_ascii_hexdigit())).map(|p| p.to_lowercase())
    })
}

/// The first sentence under a "## What's…" heading (bullet and ** removed), else "".
pub fn whats_new(notes: &str) -> String {
    let lines: Vec<&str> = notes.lines().map(str::trim).collect();
    let Some(h) = lines.iter().position(|l| l.starts_with('#') && l.to_lowercase().contains("what")) else { return String::new() };
    let Some(first) = lines[h + 1..].iter().find(|l| !l.is_empty() && !l.starts_with('#')) else { return String::new() };
    let t = first.strip_prefix("- ").or_else(|| first.strip_prefix("* ")).unwrap_or(first).replace("**", "");
    match t.find(". ") {
        Some(i) => format!("{}.", &t[..i]),
        None => t,
    }
}

pub fn parse(json: &[u8], current: &str) -> Result<Release, String> {
    let v: serde_json::Value = serde_json::from_slice(json).map_err(|_| "GitHub didn\u{2019}t return a release.".to_string())?;
    let tag = v["tag_name"].as_str().ok_or("GitHub didn\u{2019}t return a release.")?;
    let notes = v["body"].as_str().unwrap_or("");
    let url = v["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"].as_str() == Some(ASSET)))
        .and_then(|x| x["browser_download_url"].as_str())
        .filter(|u| u.starts_with("https://"))
        .ok_or("The latest release has no Windows download.")?;
    let sha256 = checksum_in(notes, ASSET).ok_or("The release notes have no checksum for the Windows download, so it can\u{2019}t be checked.")?;
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    Ok(Release { newer: is_newer(&version, current), current: current.to_string(), version, whats_new: whats_new(notes), url: url.to_string(), sha256 })
}

pub fn check() -> Result<Release, String> {
    let (status, body) = crate::web::https_get(LATEST, Duration::from_secs(15)).map_err(|_| "No connection to github.com. Try again later, or visit arpradar.com.".to_string())?;
    match status {
        200 => parse(&body, current()),
        403 | 429 => Err("GitHub is limiting requests right now. Try again in an hour.".into()),
        s => Err(format!("GitHub answered {s}.")),
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn downloads_folder() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let d = home.join("Downloads");
    if d.is_dir() { d } else { std::env::temp_dir() }
}

/// Downloads the installer as Downloads\ARPradar-x.y.z-setup.exe after checking its SHA-256. Returns the path.
pub fn download(url: &str, sha256: &str, version: &str) -> Result<PathBuf, String> {
    if !url.starts_with("https://github.com/") {
        return Err("That isn\u{2019}t a GitHub download.".into());
    }
    let (status, body) = crate::web::https_get(url, Duration::from_secs(60)).map_err(|e| format!("The download failed: {e}"))?;
    if status != 200 {
        return Err(format!("The download failed ({status})."));
    }
    if sha256_hex(&body) != sha256.to_lowercase() {
        return Err("The download doesn\u{2019}t match the checksum in the release notes, so it wasn\u{2019}t saved. Try again later.".into());
    }
    let safe: String = version.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let dir = downloads_folder();
    let mut path = dir.join(format!("ARPradar-{safe}-setup.exe"));
    for n in 2..100 {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("ARPradar-{safe}-setup ({n}).exe"));
    }
    std::fs::write(&path, &body).map_err(|e| format!("Couldn\u{2019}t save the installer: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTES: &str = "**Download** below.\n\n| File | SHA-256 |\n|---|---|\n| `ARPradar.zip` | `428d7dd353870083debb4047003e443ac9b6c0648d2ac55dbbaf5e7869afdccc` |\n| `ARPradar-Windows-setup.exe` | `B176C106DE9E4E7301C2CB060CAA91018D516FD660369A0B3F5C674F06DF9DBB` |\n\n## What's fixed in 1.0.2\n\n- **Site survey scans the right network.** When you set up a survey\u{2026}\n";

    #[test]
    fn versions() {
        assert!(is_newer("1.1.0", "1.0.2"));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(!is_newer("1.0.2", "1.0.2"));
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(!is_newer("1.0.1", "1.0.2"));
    }

    #[test]
    fn notes() {
        assert_eq!(checksum_in(NOTES, ASSET).unwrap(), "b176c106de9e4e7301c2cb060caa91018d516fd660369a0b3f5c674f06df9dbb");
        assert!(checksum_in(NOTES, "Other.exe").is_none());
        assert_eq!(whats_new(NOTES), "Site survey scans the right network.");
    }

    #[test]
    fn parses_and_refuses() {
        let json = serde_json::json!({"tag_name": "v1.0.2", "body": NOTES, "assets": [
            {"name": "ARPradar.zip", "browser_download_url": "https://github.com/example/ARPradar.zip"},
            {"name": ASSET, "browser_download_url": "https://github.com/example/setup.exe"}]});
        let r = parse(json.to_string().as_bytes(), "1.0.1").unwrap();
        assert_eq!((r.version.as_str(), r.newer, r.url.as_str()), ("1.0.2", true, "https://github.com/example/setup.exe"));
        assert!(!parse(json.to_string().as_bytes(), "1.0.2").unwrap().newer);
        let no_sum = serde_json::json!({"tag_name": "v1.0.2", "body": "none", "assets": [{"name": ASSET, "browser_download_url": "https://github.com/x"}]});
        assert!(parse(no_sum.to_string().as_bytes(), "1.0.0").is_err());
        let no_file = serde_json::json!({"tag_name": "v1.0.2", "body": NOTES, "assets": []});
        assert!(parse(no_file.to_string().as_bytes(), "1.0.0").is_err());
    }

    #[test]
    fn sha() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    /// Asks the real GitHub and checks the real installer's checksum (not saved). Only with ARPRADAR_LIVE_UPDATE set.
    #[test]
    fn live_latest() {
        if std::env::var_os("ARPRADAR_LIVE_UPDATE").is_none() {
            return;
        }
        let r = check().expect("check");
        println!("LIVE latest {} (this build {}): {}", r.version, r.current, r.whats_new);
        let (status, body) = crate::web::https_get(&r.url, Duration::from_secs(60)).expect("download");
        assert_eq!(status, 200);
        assert_eq!(sha256_hex(&body), r.sha256);
    }
}
