//! Right-click > Scan Ports: checks one device for common ports, all ports, or a typed list.

use crate::scan::par_map;
use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// About 100 TCP ports worth checking on one device, with what usually runs there (same list as the Mac app).
pub const COMMON: &[(u16, &str)] = &[
    (20, "FTP data"), (21, "FTP"), (22, "SSH"), (23, "Telnet"), (25, "SMTP (mail)"), (53, "DNS"),
    (80, "HTTP (web)"), (81, "HTTP (web, alt.)"), (88, "Kerberos"), (102, "Siemens S7 PLC"),
    (110, "POP3 (mail)"), (111, "RPC portmapper"), (135, "Windows RPC"), (139, "NetBIOS file sharing"),
    (143, "IMAP (mail)"), (179, "BGP"), (389, "LDAP / Active Directory"), (443, "HTTPS (web)"),
    (445, "SMB (file sharing)"), (465, "SMTP over TLS"), (502, "Modbus"), (515, "LPD printing"),
    (548, "AFP (Mac file sharing)"), (554, "RTSP (camera video)"), (587, "Mail submission"),
    (593, "RPC over HTTP"), (631, "IPP printing"), (636, "LDAP over TLS"), (873, "rsync"),
    (902, "VMware ESXi"), (993, "IMAP over TLS"), (995, "POP3 over TLS"), (1080, "SOCKS proxy"),
    (1194, "OpenVPN"), (1433, "Microsoft SQL Server"), (1521, "Oracle database"), (1723, "PPTP VPN"),
    (1883, "MQTT"), (2049, "NFS"), (2179, "Hyper-V console"), (2375, "Docker API"),
    (2376, "Docker API (TLS)"), (3000, "Web app (Grafana etc.)"), (3128, "Web proxy"), (3260, "iSCSI"),
    (3306, "MySQL / MariaDB"), (3389, "RDP (Remote Desktop)"), (4443, "HTTPS (alt.)"),
    (5000, "Synology / UPnP / web app"), (5001, "Synology HTTPS"), (5060, "SIP (VoIP)"),
    (5061, "SIP over TLS"), (5222, "XMPP chat"), (5432, "PostgreSQL"), (5555, "Android debug"),
    (5601, "Kibana"), (5900, "VNC (screen sharing)"), (5901, "VNC display 1"), (5985, "WinRM"),
    (5986, "WinRM over TLS"), (6379, "Redis"), (6443, "Kubernetes API"), (7000, "AirPlay"),
    (7443, "HTTPS (alt.)"), (8000, "HTTP (alt.)"), (8008, "HTTP (alt.)"), (8009, "Chromecast"),
    (8060, "Roku"), (8080, "HTTP (alt. / proxy)"), (8081, "HTTP (alt.)"), (8088, "HTTP (alt.)"),
    (8123, "Home Assistant"), (8200, "DLNA media"), (8291, "MikroTik Winbox"), (8443, "HTTPS (alt.)"),
    (8554, "RTSP (alt.)"), (8728, "MikroTik API"), (8843, "UniFi HTTPS"), (8880, "UniFi HTTP"),
    (8883, "MQTT over TLS"), (8888, "HTTP (alt.)"), (9000, "Portainer / web app"),
    (9090, "Cockpit / Prometheus"), (9091, "Transmission"), (9100, "Printer (JetDirect)"),
    (9200, "Elasticsearch"), (9443, "HTTPS (alt.)"), (10000, "Webmin"), (11211, "Memcached"),
    (27017, "MongoDB"), (32400, "Plex"), (34567, "DVR / NVR"), (37777, "Dahua camera / NVR"),
    (49152, "UPnP"), (62078, "iPhone / iPad sync"),
];

/// "1-1024" or "22, 80, 8000-8100" -> sorted ports. None if anything is invalid or outside 1-65535.
pub fn parse_list(text: &str) -> Option<Vec<u16>> {
    let mut out = std::collections::BTreeSet::new();
    let pieces: Vec<&str> = text.split([',', ' ']).filter(|p| !p.is_empty()).collect();
    if pieces.is_empty() {
        return None;
    }
    for piece in pieces {
        let (a, b) = match piece.split_once('-') {
            Some((a, b)) => (a.parse::<u16>().ok()?, b.parse::<u16>().ok()?),
            None => {
                let a = piece.parse::<u16>().ok()?;
                (a, a)
            }
        };
        if a == 0 || b < a {
            return None;
        }
        out.extend(a..=b);
    }
    Some(out.into_iter().collect())
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PortEvent {
    Open { id: u32, port: u16 },
    Progress { id: u32, done: usize, total: usize },
    Banners { id: u32, banners: std::collections::HashMap<u16, String> },
    Finished { id: u32, cancelled: bool },
}

pub fn run(id: u32, ip: u32, ports: Vec<u16>, cancel: &AtomicBool, report: impl Fn(PortEvent) + Sync) {
    let total = ports.len();
    let done = AtomicUsize::new(0);
    // More threads for a long list; each one mostly waits on the network.
    let workers = if total > 2000 { 1024 } else { 256 };
    let timeout = Duration::from_millis(if total > 2000 { 600 } else { 1000 });
    let probe = |&port: &u16| {
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(ip), port));
        let is_open = TcpStream::connect_timeout(&addr, timeout).is_ok();
        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
        if is_open {
            report(PortEvent::Open { id, port });
        }
        if n % 500 == 0 || n == total {
            report(PortEvent::Progress { id, done: n, total });
        }
        is_open.then_some(port)
    };
    // The first batch on its own: if every connection fails at once (well under the timeout), the network
    // wasn't ready yet (seen right after an update on the Mac). Wait a moment and try that batch again, once.
    let first = total.min(workers);
    let started = Instant::now();
    let mut open = par_map(&ports[..first], workers, cancel, &probe);
    if open.is_empty() && first > 0 && started.elapsed() < Duration::from_millis(300) && !cancel.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(1));
        done.fetch_sub(first, Ordering::Relaxed);
        open = par_map(&ports[..first], workers, cancel, &probe);
    }
    open.extend(par_map(&ports[first..], workers, cancel, &probe));
    if !cancel.load(Ordering::Relaxed) && !open.is_empty() {
        report(PortEvent::Banners { id, banners: crate::identify::banners(ip, &open, Duration::from_secs(2)) });
    }
    report(PortEvent::Finished { id, cancelled: cancel.load(Ordering::Relaxed) });
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists() {
        assert_eq!(super::parse_list("22, 80,8000-8002"), Some(vec![22, 80, 8000, 8001, 8002]));
        assert_eq!(super::parse_list("0-5"), None);
        assert_eq!(super::parse_list("9-3"), None);
        assert_eq!(super::parse_list("abc"), None);
        assert_eq!(super::parse_list("1-65535").map(|v| v.len()), Some(65535));
    }
}
