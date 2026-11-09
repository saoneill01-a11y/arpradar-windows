//! Connection Info: one adapter's address, router, DHCP server and lease, DNS, IPv6, MAC, MTU and link speed.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub adapter: String,
    pub description: String,
    pub address: String,
    pub prefix: u8,
    pub mask: String,
    pub router: String,
    pub dhcp_server: String,
    pub dhcp: bool,
    /// Seconds until the DHCP lease runs out (Windows doesn't keep the start time).
    pub lease_left_secs: Option<u64>,
    pub dns: Vec<String>,
    pub domain: String,
    pub ipv6: Vec<String>,
    pub mac: String,
    pub mtu: u32,
    pub link_mbps: Option<u64>,
}

fn mask(prefix: u8) -> String {
    let m: u32 = if prefix == 0 { 0 } else { !0u32 << (32 - prefix as u32) };
    crate::range::text(m)
}

/// `id` is an adapter id from `list_adapters` ("name|address").
#[cfg(windows)]
pub fn read(id: &str) -> Option<ConnectionInfo> {
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH};
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS};
    let (name, want_addr) = id.split_once('|')?;
    let wide = |p: *const u16| -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe {
            let len = (0..).take_while(|&i| *p.add(i) != 0).count();
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    };
    let ascii = |p: *const u8| -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(p as *const std::ffi::c_char).to_string_lossy().into_owned() }
    };
    let sockaddr = |s: &SOCKET_ADDRESS| -> Option<std::net::IpAddr> {
        if s.lpSockaddr.is_null() {
            return None;
        }
        unsafe {
            let sa = &*(s.lpSockaddr as *const SOCKADDR);
            if sa.sa_family == AF_INET {
                let v4 = &*(s.lpSockaddr as *const SOCKADDR_IN);
                Some(Ipv4Addr::from(v4.sin_addr.S_un.S_addr.to_ne_bytes()).into())
            } else if sa.sa_family == AF_INET6 {
                let v6 = &*(s.lpSockaddr as *const SOCKADDR_IN6);
                Some(Ipv6Addr::from(v6.sin6_addr.u.Byte).into())
            } else {
                None
            }
        }
    };
    let mut size: u32 = 32 * 1024;
    let mut buf: Vec<u8>;
    loop {
        buf = vec![0u8; size as usize];
        // 0x80 = include gateway addresses.
        let r = unsafe { GetAdaptersAddresses(AF_UNSPEC as u32, 0x80, std::ptr::null(), buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH, &mut size) };
        if r == 0 {
            break;
        }
        if r != 111 {
            return None; // 111 = buffer too small: try again with the size it asked for
        }
    }
    let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !p.is_null() {
        let a = unsafe { &*p };
        p = a.Next;
        let friendly = wide(a.FriendlyName);
        let mut info = ConnectionInfo { adapter: friendly.clone(), description: wide(a.Description), ..Default::default() };
        let mut matched = false;
        let mut u = a.FirstUnicastAddress;
        while !u.is_null() {
            let ua = unsafe { &*u };
            u = ua.Next;
            match sockaddr(&ua.Address) {
                Some(std::net::IpAddr::V4(v4)) => {
                    if v4.to_string() == want_addr {
                        matched = true;
                        info.address = v4.to_string();
                        info.prefix = ua.OnLinkPrefixLength;
                        if ua.LeaseLifetime != 0 && ua.LeaseLifetime != u32::MAX {
                            info.lease_left_secs = Some(ua.LeaseLifetime as u64);
                        }
                    }
                }
                Some(std::net::IpAddr::V6(v6)) => info.ipv6.push(v6.to_string()),
                None => {}
            }
        }
        // Matched by address; the name part of the id is netdev's adapter name (Windows' GUID name).
        let _ = (name, ascii(a.AdapterName));
        if !matched {
            continue;
        }
        info.mask = mask(info.prefix);
        let flags = unsafe { a.Anonymous2.Flags };
        info.dhcp = flags & 0x4 != 0;
        info.dhcp_server = sockaddr(&a.Dhcpv4Server).map(|x| x.to_string()).unwrap_or_default();
        let mut g = a.FirstGatewayAddress;
        while !g.is_null() {
            let ga = unsafe { &*g };
            g = ga.Next;
            if let Some(std::net::IpAddr::V4(v4)) = sockaddr(&ga.Address) {
                info.router = v4.to_string();
                break;
            }
        }
        let mut d = a.FirstDnsServerAddress;
        while !d.is_null() {
            let da = unsafe { &*d };
            d = da.Next;
            if let Some(ip) = sockaddr(&da.Address) {
                info.dns.push(ip.to_string());
            }
        }
        info.domain = wide(a.DnsSuffix);
        let len = (a.PhysicalAddressLength as usize).min(8);
        info.mac = crate::sys::format_mac(&a.PhysicalAddress[..len]);
        info.mtu = a.Mtu;
        if a.TransmitLinkSpeed != 0 && a.TransmitLinkSpeed != u64::MAX {
            info.link_mbps = Some(a.TransmitLinkSpeed / 1_000_000);
        }
        info.ipv6.sort_by_key(|x| match crate::extra::ipv6_kind(x) { "Global" => 0, "Local" => 1, _ => 2 });
        return Some(info);
    }
    None
}

#[cfg(not(windows))]
pub fn read(id: &str) -> Option<ConnectionInfo> {
    let (name, want_addr) = id.split_once('|')?;
    let i = netdev::get_interfaces().into_iter().find(|i| i.name == name)?;
    let net = i.ipv4.iter().find(|n| n.addr().to_string() == want_addr)?;
    let mut info = ConnectionInfo {
        adapter: i.friendly_name.clone().unwrap_or(i.name.clone()),
        description: i.description.clone().unwrap_or_default(),
        address: net.addr().to_string(),
        prefix: net.prefix_len(),
        mask: mask(net.prefix_len()),
        router: i.gateway.as_ref().and_then(|g| g.ipv4.first()).map(|a| a.to_string()).unwrap_or_default(),
        dns: i.dns_servers.iter().map(|a| a.to_string()).collect(),
        ipv6: i.ipv6.iter().map(|n| n.addr().to_string()).collect(),
        mac: i.mac_addr.map(|m| crate::sys::format_mac(&m.octets())).unwrap_or_default(),
        link_mbps: i.transmit_speed.map(|s| s / 1_000_000),
        ..Default::default()
    };
    if cfg!(target_os = "macos") {
        // DHCP details from `ipconfig getpacket` (the Mac app's way).
        if let Ok(o) = std::process::Command::new("ipconfig").args(["getpacket", name]).output() {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            info.dhcp = !text.trim().is_empty();
            for line in text.lines() {
                let Some((k, v)) = line.split_once("): ") else { continue };
                let v = v.trim().trim_start_matches('{').trim_end_matches('}').to_string();
                match k.split_whitespace().next().unwrap_or("") {
                    "server_identifier" => info.dhcp_server = v,
                    "domain_name" => info.domain = v,
                    "lease_time" => info.lease_left_secs = u64::from_str_radix(v.trim_start_matches("0x"), 16).ok(),
                    _ => {}
                }
            }
        }
    }
    info.ipv6.sort_by_key(|x| match crate::extra::ipv6_kind(x) { "Global" => 0, "Local" => 1, _ => 2 });
    Some(info)
}

/// Renew the DHCP lease. On Windows this needs admin rights, so Windows shows its own "allow changes?" prompt.
pub fn renew(adapter: &str) -> Result<(), String> {
    if cfg!(windows) {
        let arg = format!("/renew \"{}\"", adapter.replace('"', ""));
        let ps = format!("Start-Process ipconfig -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -Wait", arg.replace('\'', "''"));
        let st = std::process::Command::new("powershell").args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps]).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err("The renew didn\u{2019}t run (cancelled, or Windows refused).".into()) }
    } else {
        Err("Renew DHCP works in the Windows version.".into())
    }
}
