//! One scan, start to finish, on a background thread (same steps as the Mac app):
//!   1. ping sweep (with response times)
//!   2. TCP knock on the addresses that didn't answer ping (Windows PCs often block ping)
//!   3. MAC addresses (ARP), which also finds quiet devices that answered nothing else
//!   4. open ports on the devices found
//!   5. names: NetBIOS, Bonjour, the saved scan's name server, then this PC's DNS (first name wins)
//! It reports back to the window as it goes, through `ScanEvent`s.

use crate::{extra, identify, names, oui, sys};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The ports shown in the "Open ports" column (same list as the Mac app).
pub const KNOWN_PORTS: [u16; 15] = [21, 22, 23, 53, 80, 443, 445, 548, 554, 631, 3389, 5900, 8080, 8443, 9100];
/// Ports knocked on to find devices that ignore ping.
const DISCOVERY_PORTS: [u16; 5] = [445, 80, 443, 22, 3389];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    pub this_pc: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MacInfo {
    pub mac: String,
    pub vendor: String,
}

/// Messages to the window while a scan runs. IP addresses are text ("192.168.1.5").
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanEvent {
    Found { devices: Vec<Found> },
    Response { ms: HashMap<String, f64> },
    Macs { macs: HashMap<String, MacInfo> },
    Ports { ports: HashMap<String, Vec<u16>> },
    Names { source: String, names: HashMap<String, String> },
    WebTitles { titles: HashMap<String, String> },
    Upnp { info: HashMap<String, crate::identify::UpnpInfo> },
    Snmp { info: HashMap<String, crate::identify::SnmpInfo> },
    Ubiquiti { info: HashMap<String, crate::unifi::UbiquitiInfo> },
    Ipv6 { ipv6: HashMap<String, Vec<String>> },
    Progress { fraction: f64, text: String },
    Finished { cancelled: bool },
}

pub struct Options {
    pub name_server: Option<u32>,
    pub snmp_community: String,
}

/// Runs `f` on every item with `workers` threads; collects what it returns.
pub fn par_map<T: Sync, R: Send>(items: &[T], workers: usize, cancel: &AtomicBool, f: impl Fn(&T) -> Option<R> + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..workers.min(items.len()).max(1) {
            let _ = std::thread::Builder::new().stack_size(256 * 1024).spawn_scoped(s, || loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(i) else { return };
                if let Some(r) = f(item) {
                    out.lock().unwrap().push(r);
                }
            });
        }
    });
    out.into_inner().unwrap()
}

/// TCP connect: Some(true) = port open, Some(false) = the device refused (still: it's there), None = no answer.
fn knock(ip: u32, port: u16, timeout: Duration) -> Option<bool> {
    let addr = SocketAddr::V4(SocketAddrV4::new(std::net::Ipv4Addr::from(ip), port));
    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => Some(true),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Some(false),
        Err(_) => None,
    }
}

fn key(ip: u32) -> String {
    crate::range::text(ip)
}

pub fn run(targets: Vec<u32>, opts: Options, cancel: Arc<AtomicBool>, report: impl Fn(ScanEvent) + Sync) {
    let stop = || cancel.load(Ordering::Relaxed);
    let target_set: HashSet<u32> = targets.iter().copied().collect();
    let mut alive: HashSet<u32> = HashSet::new();
    let progress = |fraction: f64, text: String| report(ScanEvent::Progress { fraction, text });

    // This PC itself, if it's inside the range.
    let mut own_macs: HashMap<u32, String> = HashMap::new();
    let mut me = Vec::new();
    for a in sys::adapters() {
        let Some(ip) = crate::range::ip(&a.address) else { continue };
        if target_set.contains(&ip) && alive.insert(ip) {
            me.push(Found { ip: key(ip), name: Some(sys::computer_name()), mac: Some(a.mac.clone()).filter(|m| !m.is_empty()), this_pc: true });
            if !a.mac.is_empty() {
                own_macs.insert(ip, a.mac.clone());
            }
        }
    }
    if !me.is_empty() {
        report(ScanEvent::Found { devices: me });
    }

    // 1. Ping
    progress(0.05, format!("Pinging {} addresses\u{2026}", targets.len()));
    let to_ping: Vec<u32> = targets.iter().copied().filter(|t| !alive.contains(t)).collect();
    let replies: Vec<(u32, f64)> = par_map(&to_ping, 128, &cancel, |&ip| sys::ping(ip, 1000).map(|ms| (ip, ms)));
    let mut found: Vec<u32> = replies.iter().map(|r| r.0).collect();
    found.sort();
    alive.extend(&found);
    report(ScanEvent::Found { devices: found.iter().map(|&ip| Found { ip: key(ip), name: None, mac: None, this_pc: false }).collect() });
    report(ScanEvent::Response { ms: replies.iter().map(|&(ip, ms)| (key(ip), ms)).collect() });
    if stop() {
        return report(ScanEvent::Finished { cancelled: true });
    }

    // 2. TCP knock on the rest
    progress(0.35, "Checking devices that ignore ping\u{2026}".into());
    let rest: Vec<u32> = targets.iter().copied().filter(|t| !alive.contains(t)).collect();
    let jobs: Vec<(u32, u16)> = rest.iter().flat_map(|&ip| DISCOVERY_PORTS.iter().map(move |&p| (ip, p))).collect();
    let knocked_set = Mutex::new(HashSet::new());
    par_map(&jobs, 384, &cancel, |&(ip, port)| {
        if knocked_set.lock().unwrap().contains(&ip) {
            return None::<()>;
        }
        if knock(ip, port, Duration::from_millis(900)).is_some() {
            knocked_set.lock().unwrap().insert(ip);
        }
        None
    });
    let mut knocked: Vec<u32> = knocked_set.into_inner().unwrap().into_iter().collect();
    knocked.sort();
    alive.extend(&knocked);
    report(ScanEvent::Found { devices: knocked.iter().map(|&ip| Found { ip: key(ip), name: None, mac: None, this_pc: false }).collect() });
    if stop() {
        return report(ScanEvent::Finished { cancelled: true });
    }

    // 3. MAC addresses
    progress(0.6, "Reading MAC addresses\u{2026}".into());
    let macs = read_macs(&targets, &own_macs, &cancel);
    let mut quiet: Vec<u32> = macs.keys().copied().filter(|ip| !alive.contains(ip)).collect();
    quiet.sort();
    alive.extend(&quiet);
    report(ScanEvent::Found { devices: quiet.iter().map(|&ip| Found { ip: key(ip), name: None, mac: None, this_pc: false }).collect() });
    report(ScanEvent::Macs {
        macs: macs.iter().map(|(&ip, m)| (key(ip), MacInfo { mac: m.clone(), vendor: oui::vendor(m) })).collect(),
    });
    if stop() {
        return report(ScanEvent::Finished { cancelled: true });
    }

    // 4. Open ports
    let mut alive_list: Vec<u32> = alive.iter().copied().collect();
    alive_list.sort();
    progress(0.72, format!("Checking open ports on {} devices\u{2026}", alive_list.len()));
    let jobs: Vec<(u32, u16)> = alive_list.iter().flat_map(|&ip| KNOWN_PORTS.iter().map(move |&p| (ip, p))).collect();
    let open = par_map(&jobs, 512, &cancel, |&(ip, port)| (knock(ip, port, Duration::from_millis(800)) == Some(true)).then_some((ip, port)));
    let mut port_map: HashMap<u32, Vec<u16>> = HashMap::new();
    for (ip, port) in open {
        port_map.entry(ip).or_default().push(port);
    }
    port_map.values_mut().for_each(|p| p.sort());
    report(ScanEvent::Ports { ports: port_map.iter().map(|(&ip, p)| (key(ip), p.clone())).collect() });
    if stop() {
        return report(ScanEvent::Finished { cancelled: true });
    }

    // 5. Names, and alongside them: web page titles, UPnP models, SNMP, IPv6 neighbors.
    // Everything below came off the network: cleaned of control and invisible characters and cut to length first.
    let clean = identify::clean_text;
    let to_map = |m: HashMap<u32, String>| {
        m.into_iter().map(|(ip, n)| (key(ip), clean(&n, 64))).filter(|(_, n)| !n.is_empty()).collect::<HashMap<_, _>>()
    };
    let others: Vec<u32> = alive_list.iter().copied().filter(|ip| !own_macs.contains_key(ip)).collect();
    let other_set: HashSet<u32> = others.iter().copied().collect();
    let (mut upnp_names, mut snmp_names) = (HashMap::new(), HashMap::new());
    std::thread::scope(|s| {
        let web = s.spawn(|| identify::web_titles(&port_map, &cancel));
        let upnp = s.spawn(|| identify::upnp(&other_set, Duration::from_secs(3), &cancel));
        let snmp = s.spawn(|| identify::snmp(&others, &opts.snmp_community, Duration::from_secs(2), &cancel));
        let ubnt = s.spawn(|| crate::unifi::discover(&others, Duration::from_secs(2), &cancel));
        let v6 = s.spawn(extra::ipv6_neighbors);

        // NetBIOS, Bonjour and the saved scan's name server are asked at the same time; their names are reported in
        // that order (first name wins), so the result is the same as asking one after the other.
        progress(0.8, "Looking up names\u{2026}".into());
        let nb = s.spawn(|| names::netbios(&alive_list, Duration::from_millis(1500), &cancel));
        let bj = s.spawn(|| names::bonjour(&alive_list, Duration::from_secs(2), &cancel));
        let (list, flag): (&[u32], &AtomicBool) = (&alive_list, &cancel);
        let site = opts.name_server.map(|server| s.spawn(move || names::dns_ptr(list, server, Duration::from_secs(2), flag)));
        report(ScanEvent::Names { source: "NetBIOS".into(), names: to_map(nb.join().unwrap_or_default()) });
        report(ScanEvent::Names { source: "Bonjour".into(), names: to_map(bj.join().unwrap_or_default()) });
        if let Some(site) = site {
            report(ScanEvent::Names { source: "DNS".into(), names: to_map(site.join().unwrap_or_default()) });
        }

        progress(0.9, "Reading web pages, UPnP and SNMP\u{2026}".into());
        let by_mac = v6.join().unwrap_or_default();
        report(ScanEvent::Ipv6 {
            ipv6: macs.iter().filter_map(|(&ip, m)| by_mac.get(m).map(|v| (key(ip), v.clone()))).collect(),
        });
        report(ScanEvent::WebTitles {
            titles: web.join().unwrap_or_default().into_iter().map(|(ip, t)| (key(ip), clean(&t, 120))).filter(|(_, t)| !t.is_empty()).collect(),
        });
        let mut u = upnp.join().unwrap_or_default();
        for i in u.values_mut() {
            i.friendly_name = clean(&i.friendly_name, 64);
            i.model = clean(&i.model, 120);
        }
        upnp_names = u.iter().filter(|(_, i)| names::is_useful(&i.friendly_name)).map(|(&ip, i)| (ip, i.friendly_name.clone())).collect();
        report(ScanEvent::Upnp { info: u.into_iter().map(|(ip, i)| (key(ip), i)).collect() });
        let mut sn = snmp.join().unwrap_or_default();
        for i in sn.values_mut() {
            i.name = clean(&i.name, 64);
            i.descr = clean(&i.descr, 255);
            i.location = clean(&i.location, 120);
        }
        snmp_names = sn.iter().filter(|(_, i)| names::is_useful(&i.name)).map(|(&ip, i)| (ip, i.name.clone())).collect();
        report(ScanEvent::Snmp { info: sn.into_iter().map(|(ip, i)| (key(ip), i)).collect() });
        let mut ub = ubnt.join().unwrap_or_default();
        for i in ub.values_mut() {
            i.name = clean(&i.name, 64);
            i.model = clean(&i.model, 64);
            i.firmware = clean(&i.firmware, 32);
        }
        report(ScanEvent::Names { source: "UniFi".into(), names: ub.iter().filter(|(_, i)| names::is_useful(&i.name)).map(|(&ip, i)| (key(ip), i.name.clone())).collect() });
        report(ScanEvent::Ubiquiti { info: ub.into_iter().map(|(ip, i)| (key(ip), i)).collect() });
    });

    if !stop() {
        progress(0.95, "Looking up DNS names\u{2026}".into());
        names::reverse_dns(&alive_list, Duration::from_secs(4), cancel.clone(), |ip, n| {
            let n = identify::clean_text(&n, 64);
            if !n.is_empty() {
                report(ScanEvent::Names { source: "DNS".into(), names: HashMap::from([(key(ip), n)]) });
            }
        });
    }
    // Names from UPnP and SNMP come last: only used when nothing else named the device.
    report(ScanEvent::Names { source: "UPnP".into(), names: to_map(upnp_names) });
    report(ScanEvent::Names { source: "SNMP".into(), names: to_map(snmp_names) });

    report(ScanEvent::Finished { cancelled: stop() });
}

/// MAC addresses for the targets on this PC's own subnets (ARP doesn't cross routers).
fn read_macs(targets: &[u32], own: &HashMap<u32, String>, cancel: &AtomicBool) -> HashMap<u32, String> {
    let subnets = sys::local_subnets();
    let local: Vec<u32> = targets
        .iter()
        .copied()
        .filter(|ip| !own.contains_key(ip) && subnets.iter().any(|&(net, mask)| ip & mask == net))
        .collect();
    let mut out: HashMap<u32, String> = own.clone();
    #[cfg(windows)]
    {
        // SendARP asks each address directly; up to ~1 s for addresses where nothing answers.
        for (ip, mac) in par_map(&local, 128, cancel, |&ip| sys::arp(ip).map(|m| (ip, m))) {
            out.insert(ip, mac);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = cancel;
        let wanted: HashSet<u32> = local.into_iter().collect();
        for (ip, mac) in sys::arp_table() {
            if wanted.contains(&ip) {
                out.insert(ip, mac);
            }
        }
    }
    out
}
