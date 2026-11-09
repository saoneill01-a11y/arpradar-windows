//! DNS Lookup's extra tabs that need the web: domain registration (RDAP), HTTPS certificates on a domain's hosts,
//! and subdomains from the public certificate logs (crt.sh). Each asks only when Sean clicks.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// GET an https:// address (following up to 4 redirects). Returns the status and body.
pub fn https_get(url: &str, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
    let mut url = url.to_string();
    for _ in 0..5 {
        let rest = url.strip_prefix("https://").ok_or("Only https:// addresses")?;
        let (host, path) = rest.split_once('/').map(|(h, p)| (h.to_string(), format!("/{p}"))).unwrap_or((rest.to_string(), "/".into()));
        let addr = (host.as_str(), 443).to_socket_addrs().map_err(|_| format!("Couldn\u{2019}t find {host}."))?.next().ok_or(format!("Couldn\u{2019}t find {host}."))?;
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|_| format!("Couldn\u{2019}t reach {host}."))?;
        tcp.set_read_timeout(Some(timeout)).ok();
        let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
        let mut s = tls.connect(&host, tcp).map_err(|_| format!("Couldn\u{2019}t open a secure connection to {host}."))?;
        // HTTP/1.0 so the answer isn't sent in chunks.
        let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nUser-Agent: ARPradar\r\nAccept: application/json, application/rdap+json, */*\r\n\r\n");
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        let _ = s.read_to_end(&mut data);
        let page = crate::identify::parse_response(&data).ok_or(format!("No answer from {host}."))?;
        if (300..400).contains(&page.status) {
            if let Some(loc) = page.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()) {
                url = if loc.starts_with("https://") { loc } else if loc.starts_with('/') { format!("https://{host}{loc}") } else { return Err("Unexpected redirect.".into()) };
                continue;
            }
        }
        return Ok((page.status, page.body));
    }
    Err("Too many redirects.".into())
}

// MARK: Domain registration (RDAP, the modern WHOIS)

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub registrar: String,
    pub created: Option<String>,
    pub expires: Option<String>,
    pub updated: Option<String>,
    pub name_servers: Vec<String>,
    pub dnssec: Option<bool>,
    pub status: Vec<String>,
}

pub const BAD_HOST: &str = "That isn\u{2019}t a valid host name.";

/// True for an IPv4 or IPv6 address, or a well-formed host name (letters, digits, dots, hyphens and underscores, at
/// most 253 characters; starts with a letter, digit or underscore and ends with a letter or digit, optionally a dot).
/// Same as the Mac's HostName.isValid.
pub fn host_name_ok(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.len() > 253 {
        return false;
    }
    if t.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let body = t.strip_suffix('.').unwrap_or(t);
    let b = body.as_bytes();
    !body.is_empty()
        && !body.contains("..")
        && (b[0].is_ascii_alphanumeric() || b[0] == b'_')
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
}

/// A domain made safe to put in a third-party web address (rdap.org, crt.sh, Cert Spotter): a valid host name that
/// isn't an IP address, lower case, percent-encoded apart from letters, digits, dots and hyphens.
pub fn url_safe(domain: &str) -> Option<String> {
    let d = domain.trim().trim_end_matches('.').to_lowercase();
    if !host_name_ok(&d) || d.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(d.bytes().map(|c| if c.is_ascii_alphanumeric() || c == b'.' || c == b'-' { (c as char).to_string() } else { format!("%{c:02X}") }).collect())
}

pub fn rdap(domain: &str) -> Result<Registration, String> {
    let d = domain.trim().trim_end_matches('.').to_lowercase();
    let safe = url_safe(&d).ok_or(BAD_HOST)?;
    let (status, body) = https_get(&format!("https://rdap.org/domain/{safe}"), Duration::from_secs(15))?;
    if status == 404 {
        return Err(format!("No registration found for {d} (is it the main domain, like example.com?)."));
    }
    if status >= 400 {
        return Err(format!("The registration service answered {status}."));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "Couldn\u{2019}t read the registration details.".to_string())?;
    let mut r = Registration::default();
    for e in v["events"].as_array().into_iter().flatten() {
        let date = e["eventDate"].as_str().map(String::from);
        match e["eventAction"].as_str().unwrap_or("") {
            "registration" => r.created = date,
            "expiration" => r.expires = date,
            "last changed" => r.updated = date,
            _ => {}
        }
    }
    for ent in v["entities"].as_array().into_iter().flatten() {
        let roles: Vec<&str> = ent["roles"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).collect();
        if roles.contains(&"registrar") {
            // vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar, Inc."], ...]]
            if let Some(items) = ent["vcardArray"][1].as_array() {
                if let Some(f) = items.iter().find(|i| i[0] == "fn") {
                    r.registrar = f[3].as_str().unwrap_or("").to_string();
                }
            }
        }
    }
    r.name_servers = v["nameservers"].as_array().into_iter().flatten().filter_map(|n| n["ldhName"].as_str()).map(|s| s.to_lowercase()).collect();
    r.dnssec = v["secureDNS"]["delegationSigned"].as_bool();
    r.status = v["status"].as_array().into_iter().flatten().filter_map(|s| s.as_str()).map(String::from).collect();
    Ok(r)
}

// MARK: HTTPS certificates

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cert {
    pub host: String,
    pub port: u16,
    /// None when nothing answered on that port.
    pub expires: Option<String>,
    pub issuer: String,
    pub names: Vec<String>,
    /// Whether the certificate's names include this host.
    pub covers_host: bool,
    pub problem: String,
}

fn covers(names: &[String], host: &str) -> bool {
    let h = host.to_lowercase();
    names.iter().any(|n| {
        let n = n.to_lowercase();
        n == h || n.strip_prefix("*.").is_some_and(|rest| h.split_once('.').is_some_and(|(_, tail)| tail == rest))
    })
}

/// Reads the certificate a host sends on a port (even an expired or mismatched one, to report it).
pub fn cert(host: &str, port: u16) -> Cert {
    let mut out = Cert { host: host.into(), port, ..Default::default() };
    if !host_name_ok(host) {
        out.problem = BAD_HOST.into();
        return out;
    }
    let Ok(Some(addr)) = (host, port).to_socket_addrs().map(|mut a| a.next()) else {
        out.problem = "no address".into();
        return out;
    };
    let Ok(tcp) = TcpStream::connect_timeout(&addr, Duration::from_secs(4)) else {
        out.problem = "no HTTPS answer".into();
        return out;
    };
    tcp.set_read_timeout(Some(Duration::from_secs(6))).ok();
    let Ok(tls) = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true).build() else {
        out.problem = "TLS error".into();
        return out;
    };
    let s = match tls.connect(host, tcp) {
        Ok(s) => s,
        Err(_) => {
            out.problem = "no HTTPS answer".into();
            return out;
        }
    };
    let Ok(Some(c)) = s.peer_certificate() else {
        out.problem = "no certificate".into();
        return out;
    };
    let Ok(der) = c.to_der() else { return out };
    match x509_parser::parse_x509_certificate(&der) {
        Ok((_, x)) => {
            let t = x.validity().not_after.timestamp();
            out.expires = Some(iso(t));
            out.issuer = x
                .issuer()
                .iter_organization()
                .next()
                .or_else(|| x.issuer().iter_common_name().next())
                .and_then(|a| a.as_str().ok())
                .unwrap_or("")
                .to_string();
            if let Ok(Some(san)) = x.subject_alternative_name() {
                for n in &san.value.general_names {
                    if let x509_parser::extensions::GeneralName::DNSName(d) = n {
                        out.names.push(d.to_string());
                    }
                }
            }
            if out.names.is_empty() {
                if let Some(cn) = x.subject().iter_common_name().next().and_then(|a| a.as_str().ok()) {
                    out.names.push(cn.to_string());
                }
            }
            out.covers_host = covers(&out.names, host);
        }
        Err(_) => out.problem = "unreadable certificate".into(),
    }
    out
}

/// Seconds since 1970 -> "2026-11-29T12:00:00Z".
fn iso(t: i64) -> String {
    let days = t.div_euclid(86_400);
    let secs = t.rem_euclid(86_400);
    // Civil date from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

// MARK: Subdomains from the certificate logs

/// Every name under `domain` that has appeared in a public HTTPS certificate, without wildcards.
/// Asks crt.sh (full history) first; it's often overloaded, so Cert Spotter (current certificates) is the fallback.
/// Returns the names and which service answered.
pub fn subdomains(domain: &str) -> Result<(Vec<String>, String), String> {
    let d = domain.trim().trim_end_matches('.').to_lowercase();
    let safe = url_safe(&d).ok_or(BAD_HOST)?;
    let mut names = std::collections::BTreeSet::new();
    let mut add = |raw: &str| {
        let n = raw.trim().trim_start_matches("*.").to_lowercase();
        if (n.ends_with(&format!(".{d}")) || n == d) && !n.contains(' ') && !n.contains('@') {
            names.insert(n);
        }
    };
    let crt = https_get(&format!("https://crt.sh/?q=%25.{safe}&output=json"), Duration::from_secs(25))
        .ok()
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| serde_json::from_slice::<serde_json::Value>(&body).ok())
        .filter(|v| v.is_array());
    if let Some(v) = crt {
        for e in v.as_array().into_iter().flatten() {
            for field in ["name_value", "common_name"] {
                e[field].as_str().unwrap_or("").split('\n').for_each(&mut add);
            }
        }
        return Ok((names.into_iter().collect(), "crt.sh".into()));
    }
    // Cert Spotter: up to 5 pages of 100 certificates.
    let mut after = String::new();
    for _ in 0..5 {
        let url = format!("https://api.certspotter.com/v1/issuances?domain={safe}&include_subdomains=true&expand=dns_names{after}");
        let (status, body) = https_get(&url, Duration::from_secs(20))?;
        if status == 429 {
            break;
        }
        if status >= 400 {
            return Err(format!("The certificate log services are busy (crt.sh didn\u{2019}t answer, Cert Spotter answered {status}). Try again later."));
        }
        let v: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "Unexpected answer from Cert Spotter.".to_string())?;
        let list = v.as_array().cloned().unwrap_or_default();
        for e in &list {
            e["dns_names"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).for_each(&mut add);
        }
        match list.last().and_then(|e| e["id"].as_str()) {
            Some(id) if list.len() >= 100 => after = format!("&after={id}"),
            _ => break,
        }
    }
    Ok((names.into_iter().collect(), "Cert Spotter (crt.sh was busy)".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names() {
        assert!(host_name_ok("example.com") && host_name_ok("_dmarc.example.com.") && host_name_ok("10.0.0.5") && host_name_ok("fd00::1"));
        assert!(!host_name_ok("-f") && !host_name_ok("a..b") && !host_name_ok("a b") && !host_name_ok("+trace") && !host_name_ok(""));
        assert_eq!(url_safe("_sip.Example.com."), Some("%5Fsip.example.com".into()));
        assert_eq!(url_safe("10.0.0.5"), None);
        assert_eq!(url_safe("x/../y"), None);
    }

    #[test]
    fn dates_and_names() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::iso(1_796_000_000), "2026-11-30T00:53:20Z");
        let names = vec!["*.example.com".to_string(), "example.com".to_string()];
        assert!(super::covers(&names, "mail.example.com"));
        assert!(super::covers(&names, "example.com"));
        assert!(!super::covers(&names, "a.b.example.com"));
    }
}
