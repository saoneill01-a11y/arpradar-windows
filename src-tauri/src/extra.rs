//! Per-system extras for the details panel and right-click menu: IPv6 neighbors, shared folders,
//! opening a device in another program, and Wake-on-LAN.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

// MARK: IPv6 neighbors (LAN only)

/// "Global", "Local" (fd00::/8) or "Link" (fe80::), for sorting and labels.
pub fn ipv6_kind(a: &str) -> &'static str {
    let l = a.to_lowercase();
    if ["fe8", "fe9", "fea", "feb"].iter().any(|p| l.starts_with(p)) {
        "Link"
    } else if l.starts_with("fc") || l.starts_with("fd") {
        "Local"
    } else {
        "Global"
    }
}

fn sort_v6(list: &mut Vec<String>) {
    let rank = |a: &String| match ipv6_kind(a) { "Global" => 0, "Local" => 1, _ => 2 };
    list.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.cmp(b)));
    list.dedup();
}

/// IPv6 addresses this PC has seen on the LAN, by MAC address ("AA:BB:...").
/// First nudges devices to talk: a Bonjour question to ff02::fb on every adapter.
pub fn ipv6_neighbors() -> HashMap<String, Vec<String>> {
    nudge_ipv6();
    let mut out = read_ipv6_neighbors();
    out.values_mut().for_each(sort_v6);
    out
}

fn nudge_ipv6() {
    // mDNS question for "_services._dns-sd._udp.local" (PTR), sent once per adapter.
    let mut q: Vec<u8> = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in ["_services", "_dns-sd", "_udp", "local"] {
        q.push(label.len() as u8);
        q.extend(label.as_bytes());
    }
    q.extend([0, 0, 12, 0, 1]);
    let Ok(sock) = std::net::UdpSocket::bind("[::]:0") else { return };
    for i in netdev::get_interfaces() {
        if i.is_loopback() || !i.is_up() || i.ipv6.is_empty() {
            continue;
        }
        let to = std::net::SocketAddrV6::new("ff02::fb".parse().unwrap(), 5353, 0, i.index);
        let _ = sock.send_to(&q, to);
    }
    std::thread::sleep(std::time::Duration::from_millis(1500));
}

#[cfg(windows)]
fn read_ipv6_neighbors() -> HashMap<String, Vec<String>> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIpNetTable2, MIB_IPNET_TABLE2};
    use windows_sys::Win32::Networking::WinSock::AF_INET6;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    unsafe {
        let mut table: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
        if GetIpNetTable2(AF_INET6, &mut table) != 0 || table.is_null() {
            return out;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        for r in rows {
            // 2 = probe, 3 = delay, 4 = stale, 5 = reachable, 6 = permanent (0/1: unreachable/incomplete)
            if r.State < 2 || r.PhysicalAddressLength != 6 || r.PhysicalAddress[..6].iter().all(|&b| b == 0) {
                continue;
            }
            let bytes = r.Address.Ipv6.sin6_addr.u.Byte;
            let addr = std::net::Ipv6Addr::from(bytes);
            if addr.is_multicast() || addr.is_unspecified() {
                continue;
            }
            out.entry(crate::sys::format_mac(&r.PhysicalAddress[..6])).or_default().push(addr.to_string());
        }
        FreeMibTable(table as *const _);
    }
    out
}

#[cfg(not(windows))]
fn read_ipv6_neighbors() -> HashMap<String, Vec<String>> {
    // macOS: `ndp -an`; Linux: `ip -6 neigh`.
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let (cmd, args): (&str, &[&str]) = if cfg!(target_os = "macos") { ("ndp", &["-an"]) } else { ("ip", &["-6", "neigh"]) };
    let Ok(o) = Command::new(cmd).args(args).output() else { return out };
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(addr) = f.first().map(|a| a.split('%').next().unwrap_or(a)) else { continue };
        if addr.parse::<std::net::Ipv6Addr>().is_err() {
            continue;
        }
        let mac = f.iter().find_map(|w| {
            let b: Vec<u8> = w.split(':').filter_map(|p| u8::from_str_radix(p, 16).ok()).collect();
            (b.len() == 6 && w.len() >= 11 && b.iter().any(|&x| x != 0)).then_some(b)
        });
        if let Some(b) = mac {
            out.entry(crate::sys::format_mac(&b)).or_default().push(addr.to_string());
        }
    }
    out
}

// MARK: Shared folders

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub name: String,
    pub comment: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shares {
    pub smb: Vec<Share>,
    pub nfs: Vec<String>,
    /// Why shares couldn't be listed (usually: it needs a login).
    pub problem: Option<String>,
}

/// Lists a device's shared folders. On Windows this uses your Windows login, so it works on domain PCs.
#[cfg(windows)]
pub fn shares(ip: &str) -> Shares {
    use windows_sys::Win32::NetworkManagement::NetManagement::NetApiBufferFree;
    use windows_sys::Win32::Storage::FileSystem::{NetShareEnum, SHARE_INFO_1};
    let server: Vec<u16> = format!("\\\\{ip}").encode_utf16().chain([0]).collect();
    let wide = |p: *mut u16| -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe {
            let len = (0..).take_while(|&i| *p.add(i) != 0).count();
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    };
    let mut out = Shares::default();
    unsafe {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let (mut read, mut total, mut resume) = (0u32, 0u32, 0u32);
        let r = NetShareEnum(server.as_ptr(), 1, &mut buf, u32::MAX, &mut read, &mut total, &mut resume);
        if r == 0 || r == 234 {
            let rows = std::slice::from_raw_parts(buf as *const SHARE_INFO_1, read as usize);
            for s in rows {
                let name = wide(s.shi1_netname);
                // Type 0 = a folder (not a printer or the hidden admin shares like C$ and IPC$).
                if s.shi1_type & 0xFF == 0 && !name.ends_with('$') {
                    out.smb.push(Share { name, comment: wide(s.shi1_remark) });
                }
            }
        } else {
            out.problem = Some(match r {
                5 => "Needs a login".into(),
                53 | 51 => "Not answering file-sharing requests".into(),
                1326 | 1331 | 1909 => "Needs a login".into(),
                n => format!("Couldn\u{2019}t list shares (error {n})"),
            });
        }
        if !buf.is_null() {
            NetApiBufferFree(buf as *const _);
        }
    }
    out.smb.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(not(windows))]
pub fn shares(ip: &str) -> Shares {
    let mut out = Shares::default();
    let smb = if cfg!(target_os = "macos") {
        Command::new("smbutil").args(["view", "-N", &format!("//guest@{ip}")]).output()
    } else {
        Command::new("smbclient").args(["-L", ip, "-N", "-g"]).output()
    };
    match smb {
        Ok(o) if o.status.success() => {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                // macOS: "Name   Disk   Comment"; Linux (-g): "Disk|Name|Comment"
                let (name, kind, comment) = if line.contains('|') {
                    let f: Vec<&str> = line.split('|').collect();
                    (f.get(1).copied().unwrap_or(""), f[0], f.get(2).copied().unwrap_or(""))
                } else {
                    let f: Vec<&str> = line.split_whitespace().collect();
                    if f.len() < 2 {
                        continue;
                    }
                    (f[0], f[1], "")
                };
                if kind == "Disk" && !name.ends_with('$') {
                    out.smb.push(Share { name: name.into(), comment: comment.trim().into() });
                }
            }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).to_lowercase();
            out.problem = Some(if err.contains("auth") || err.contains("denied") { "Needs a login".into() } else { "Couldn\u{2019}t list shares".into() });
        }
        Err(_) => out.problem = Some("No share lister installed".into()),
    }
    if let Ok(o) = Command::new("showmount").args(["-e", ip]).output() {
        out.nfs = String::from_utf8_lossy(&o.stdout).lines().skip(1).filter_map(|l| l.split_whitespace().next()).map(String::from).collect();
    }
    out
}

// MARK: Open a device in another program

fn spawn(cmd: &str, args: &[&str]) -> Result<(), String> {
    Command::new(cmd).args(args).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// kind: "web" (with a full URL in `target`), "shares", "share" (target = ip\\name), "ssh", "rdp", "vnc".
pub fn open(kind: &str, target: &str) -> Result<(), String> {
    // The target goes to another program: it must be an IP address (or ip\\share, or a web address), never
    // something a program could read as an option.
    let ip_ok = |t: &str| t.parse::<std::net::IpAddr>().is_ok();
    let ok = match kind {
        "web" => (target.starts_with("http://") || target.starts_with("https://")) && !target.chars().any(|c| c.is_control() || c == ' '),
        "share" => target.split_once('\\').is_some_and(|(ip, name)| {
            ip_ok(ip) && !name.is_empty() && !name.contains("..") && !name.chars().any(|c| c.is_control() || "\\/\"".contains(c))
        }),
        _ => ip_ok(target),
    };
    if !ok {
        return Err("That isn\u{2019}t a valid address.".into());
    }
    match kind {
        "web" => open::that_detached(target).map_err(|_| "Couldn\u{2019}t open a web browser.".into()),
        "shares" | "share" => {
            let path = format!("\\\\{target}");
            if cfg!(windows) {
                spawn("explorer", &[&path]).map_err(|_| "Couldn\u{2019}t open File Explorer.".into())
            } else {
                open::that_detached(format!("smb://{}", target.replace('\\', "/"))).map_err(|_| "Couldn\u{2019}t open the shares.".into())
            }
        }
        "ssh" => {
            if cfg!(windows) {
                // Windows Terminal if it's there, else a plain command window. Both use Windows' own ssh.
                spawn("wt", &["ssh", target])
                    .or_else(|_| spawn("cmd", &["/c", "start", "", "cmd", "/k", "ssh", target]))
                    .map_err(|_| "Couldn\u{2019}t open a terminal for SSH.".into())
            } else {
                open::that_detached(format!("ssh://{target}")).map_err(|_| "Couldn\u{2019}t open a terminal for SSH.".into())
            }
        }
        "rdp" => {
            if cfg!(windows) {
                spawn("mstsc", &[&format!("/v:{target}")]).map_err(|_| "Couldn\u{2019}t open Remote Desktop.".into())
            } else {
                Err("Remote Desktop opens from the Windows version.".into())
            }
        }
        "vnc" => open::that_detached(format!("vnc://{target}"))
            .map_err(|_| "No VNC viewer is installed. Install one (TightVNC, RealVNC or UltraVNC), then try again.".into()),
        _ => Err(format!("Unknown action {kind}")),
    }
}

// MARK: Wake-on-LAN

/// Sends the "magic packet" (6 x FF, then the MAC 16 times) as a UDP broadcast on port 9, to the general
/// broadcast address and each adapter's subnet broadcast. Returns how many MACs it was sent for.
pub fn wake(macs: &[String]) -> Result<usize, String> {
    let parsed: Vec<Vec<u8>> = macs
        .iter()
        .filter_map(|m| {
            let b: Vec<u8> = m.split([':', '-']).filter_map(|p| u8::from_str_radix(p, 16).ok()).collect();
            (b.len() == 6).then_some(b)
        })
        .collect();
    if parsed.is_empty() {
        return Err("Wake-on-LAN needs the device\u{2019}s MAC address. Scan it while it\u{2019}s awake on this subnet first.".into());
    }
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    let mut targets = vec![u32::MAX];
    for (net, mask) in crate::sys::local_subnets() {
        targets.push(net | !mask);
    }
    targets.sort();
    targets.dedup();
    // Counted as sent when at least one broadcast went out for it; otherwise the error is reported.
    let (mut sent, mut problem) = (0, None);
    for mac in &parsed {
        let mut packet = vec![0xFFu8; 6];
        for _ in 0..16 {
            packet.extend(mac);
        }
        let mut any = false;
        for &t in &targets {
            match sock.send_to(&packet, (std::net::Ipv4Addr::from(t), 9)) {
                Ok(_) => any = true,
                Err(e) => problem = Some(e.to_string()),
            }
        }
        sent += any as usize;
    }
    if sent == 0 {
        return Err(format!("Couldn\u{2019}t send the Wake-on-LAN packet: {}", problem.unwrap_or_else(|| "no network".into())));
    }
    Ok(sent)
}
