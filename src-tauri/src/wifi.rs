#![cfg_attr(not(windows), allow(dead_code))]
//! Wi-Fi Signal and Wi-Fi Analyzer, through Windows' Native Wi-Fi API (wlanapi). Windows 11 hides network names
//! (and on newer builds the whole list) from apps until Location is allowed for desktop apps.

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub ssid: String,
    pub bssid: String,
    pub rssi: i32,
    pub channel: u32,
    pub band: String,
    pub width_mhz: u32,
    pub security: String,
    pub mine: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "ok", "off" (no Wi-Fi or not connected), "location" (Windows is hiding Wi-Fi details), "unsupported"
    pub state: String,
    pub ssid: String,
    pub bssid: String,
    pub rssi: i32,
    pub quality: u32,
    pub rx_mbps: f64,
    pub tx_mbps: f64,
    pub channel: u32,
    pub band: String,
    pub width_mhz: u32,
    pub security: String,
    pub adapter: String,
}

pub fn channel_of(freq_khz: u32) -> (u32, String) {
    let mhz = freq_khz / 1000;
    match mhz {
        2484 => (14, "2.4 GHz".into()),
        2400..=2483 => ((mhz - 2407) / 5, "2.4 GHz".into()),
        5150..=5925 => ((mhz - 5000) / 5, "5 GHz".into()),
        5926..=7125 => ((mhz - 5950) / 5, "6 GHz".into()),
        _ => (0, String::new()),
    }
}

/// Reads the information elements a network broadcasts: channel width (HT/VHT operation) and security (RSN/WPA).
pub fn parse_ies(ies: &[u8], privacy: bool) -> (u32, String) {
    let (mut width, mut rsn_akms, mut wpa) = (20, Vec::new(), false);
    let mut i = 0;
    while i + 2 <= ies.len() {
        let (id, len) = (ies[i], ies[i + 1] as usize);
        let body = &ies[i + 2..(i + 2 + len).min(ies.len())];
        match id {
            61 if body.len() >= 2 && body[1] & 0x03 != 0 && body[1] & 0x04 != 0 => width = width.max(40),
            192 if body.len() >= 3 => match body[0] {
                1 => width = if body[2] != 0 && (body[2] as i32 - body[1] as i32).abs() == 8 { 160 } else { 80 },
                2 | 3 => width = 160,
                _ => {}
            },
            48 if body.len() >= 8 => {
                // version(2) group(4) pairwise count(2) + 4 each, then AKM count(2) + 4 each
                let pc = u16::from_le_bytes([body[6], body[7]]) as usize;
                let a = 8 + pc * 4;
                if body.len() >= a + 2 {
                    let ac = u16::from_le_bytes([body[a], body[a + 1]]) as usize;
                    for k in 0..ac {
                        let s = a + 2 + k * 4;
                        if s + 4 <= body.len() {
                            rsn_akms.push(body[s + 3]);
                        }
                    }
                }
            }
            221 if body.len() >= 4 && body[..4] == [0x00, 0x50, 0xF2, 0x01] => wpa = true,
            _ => {}
        }
        i += 2 + len;
    }
    let has = |x: u8| rsn_akms.contains(&x);
    let security = if has(1) || has(5) || has(12) || has(13) {
        if has(12) || has(13) { "WPA3 Enterprise" } else { "WPA2 Enterprise" }
    } else if has(8) && (has(2) || has(6)) {
        "WPA2/WPA3 Personal"
    } else if has(8) || has(24) {
        "WPA3 Personal"
    } else if has(2) || has(6) {
        "WPA2 Personal"
    } else if has(18) {
        "Enhanced Open"
    } else if wpa {
        "WPA Personal"
    } else if privacy {
        "WEP"
    } else {
        "Open"
    };
    (width, security.into())
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::NetworkManagement::WiFi::*;

    pub struct Client(pub HANDLE);
    impl Drop for Client {
        fn drop(&mut self) {
            unsafe { WlanCloseHandle(self.0, std::ptr::null()) };
        }
    }

    pub fn open() -> Option<Client> {
        let (mut ver, mut h): (u32, HANDLE) = (0, std::ptr::null_mut());
        (unsafe { WlanOpenHandle(2, std::ptr::null(), &mut ver, &mut h) } == 0).then(|| Client(h))
    }

    /// (guid, description, connected) for each Wi-Fi adapter.
    pub fn interfaces(c: &Client) -> Vec<(GUID, String, bool)> {
        let mut out = Vec::new();
        unsafe {
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(c.0, std::ptr::null(), &mut list) != 0 || list.is_null() {
                return out;
            }
            let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), (*list).dwNumberOfItems as usize);
            for it in items {
                let d = &it.strInterfaceDescription;
                let len = d.iter().position(|&x| x == 0).unwrap_or(d.len());
                out.push((it.InterfaceGuid, String::from_utf16_lossy(&d[..len]), it.isState == wlan_interface_state_connected));
            }
            WlanFreeMemory(list as *const _);
        }
        out
    }

    fn query<T: Copy>(c: &Client, g: &GUID, op: WLAN_INTF_OPCODE) -> Result<T, u32> {
        unsafe {
            let (mut size, mut data, mut kind): (u32, *mut core::ffi::c_void, WLAN_OPCODE_VALUE_TYPE) = (0, std::ptr::null_mut(), 0);
            let r = WlanQueryInterface(c.0, g, op, std::ptr::null(), &mut size, &mut data, &mut kind);
            if r != 0 || data.is_null() {
                return Err(r);
            }
            let v = *(data as *const T);
            WlanFreeMemory(data);
            Ok(v)
        }
    }

    /// Every network the adapter heard in its last scan. Err(5) = access denied (Location is off for apps).
    pub fn bss_list(c: &Client, g: &GUID) -> Result<Vec<(Network, u16)>, u32> {
        let mut out = Vec::new();
        unsafe {
            let mut list: *mut WLAN_BSS_LIST = std::ptr::null_mut();
            let r = WlanGetNetworkBssList(c.0, g, std::ptr::null(), dot11_BSS_type_any, 0, std::ptr::null(), &mut list);
            if r != 0 || list.is_null() {
                return Err(r);
            }
            let base = list as *const u8;
            let entries = std::slice::from_raw_parts((*list).wlanBssEntries.as_ptr(), (*list).dwNumberOfItems as usize);
            for (i, e) in entries.iter().enumerate() {
                let entry_ptr = (*list).wlanBssEntries.as_ptr().add(i) as *const u8;
                let ies = std::slice::from_raw_parts(entry_ptr.add(e.ulIeOffset as usize), e.ulIeSize as usize);
                let _ = base;
                let (channel, band) = channel_of(e.ulChCenterFrequency);
                let (width, security) = parse_ies(ies, e.usCapabilityInformation & 0x10 != 0);
                let ssid_len = (e.dot11Ssid.uSSIDLength as usize).min(32);
                out.push((
                    Network {
                        ssid: String::from_utf8_lossy(&e.dot11Ssid.ucSSID[..ssid_len]).into_owned(),
                        bssid: crate::sys::format_mac(&e.dot11Bssid),
                        rssi: e.lRssi,
                        channel,
                        band,
                        width_mhz: width,
                        security,
                        mine: false,
                    },
                    e.usCapabilityInformation,
                ));
            }
            WlanFreeMemory(list as *const _);
        }
        Ok(out)
    }

    pub fn status() -> Status {
        let Some(c) = open() else { return Status { state: "unsupported".into(), ..Default::default() } };
        let Some((g, desc, _)) = interfaces(&c).into_iter().find(|i| i.2) else { return Status { state: "off".into(), ..Default::default() } };
        let mut s = Status { state: "ok".into(), adapter: desc, ..Default::default() };
        match query::<WLAN_CONNECTION_ATTRIBUTES>(&c, &g, wlan_intf_opcode_current_connection) {
            Ok(a) => {
                let assoc = a.wlanAssociationAttributes;
                let n = (assoc.dot11Ssid.uSSIDLength as usize).min(32);
                s.ssid = String::from_utf8_lossy(&assoc.dot11Ssid.ucSSID[..n]).into_owned();
                s.bssid = crate::sys::format_mac(&assoc.dot11Bssid);
                s.quality = assoc.wlanSignalQuality;
                s.rx_mbps = assoc.ulRxRate as f64 / 1000.0;
                s.tx_mbps = assoc.ulTxRate as f64 / 1000.0;
                if s.bssid == "00:00:00:00:00:00" {
                    s.bssid.clear();
                }
            }
            Err(5) => s.state = "location".into(),
            Err(_) => return Status { state: "off".into(), ..Default::default() },
        }
        s.rssi = query::<i32>(&c, &g, wlan_intf_opcode_rssi).unwrap_or(0);
        if s.rssi == 0 {
            // Some drivers don't report RSSI; estimate it from Windows' 0-100 signal quality.
            s.rssi = (s.quality as i32 / 2) - 100;
        }
        s.channel = query::<u32>(&c, &g, wlan_intf_opcode_channel_number).unwrap_or(0);
        match bss_list(&c, &g) {
            Ok(list) => {
                if let Some((n, _)) = list.iter().find(|(n, _)| !s.bssid.is_empty() && n.bssid == s.bssid) {
                    s.band = n.band.clone();
                    s.width_mhz = n.width_mhz;
                    s.security = n.security.clone();
                    if s.channel == 0 {
                        s.channel = n.channel;
                    }
                }
            }
            Err(5) => s.state = "location".into(),
            Err(_) => {}
        }
        if s.band.is_empty() && s.channel > 0 {
            s.band = if s.channel <= 14 { "2.4 GHz".into() } else { "5 GHz".into() };
        }
        s
    }

    /// Asks the adapter to scan again (results show up a few seconds later) and returns what it heard last time.
    pub fn scan() -> Result<Vec<Network>, String> {
        let c = open().ok_or("Wi-Fi isn\u{2019}t available on this PC.")?;
        let ifs = interfaces(&c);
        let (g, _, _) = ifs.iter().find(|i| i.2).or(ifs.first()).ok_or("No Wi-Fi adapter found.")?;
        unsafe { WlanScan(c.0, g, std::ptr::null(), std::ptr::null(), std::ptr::null()) };
        let mine = query::<WLAN_CONNECTION_ATTRIBUTES>(&c, g, wlan_intf_opcode_current_connection)
            .map(|a| crate::sys::format_mac(&a.wlanAssociationAttributes.dot11Bssid))
            .unwrap_or_default();
        match bss_list(&c, g) {
            Ok(list) => Ok(list.into_iter().map(|(mut n, _)| { n.mine = n.bssid == mine; n }).collect()),
            Err(5) => Err("location".into()),
            Err(e) => Err(format!("Couldn\u{2019}t read the Wi-Fi list (error {e}).")),
        }
    }
}

#[cfg(windows)]
pub fn status() -> Status {
    win::status()
}
#[cfg(windows)]
pub fn scan() -> Result<Vec<Network>, String> {
    win::scan()
}

#[cfg(not(windows))]
pub fn status() -> Status {
    Status { state: "unsupported".into(), ..Default::default() }
}
#[cfg(not(windows))]
pub fn scan() -> Result<Vec<Network>, String> {
    Err("The Wi-Fi tools work in the Windows version (Linux comes later).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_and_ies() {
        assert_eq!(channel_of(2_437_000), (6, "2.4 GHz".into()));
        assert_eq!(channel_of(5_180_000), (36, "5 GHz".into()));
        assert_eq!(channel_of(5_955_000), (1, "6 GHz".into()));
        // RSN with AKM PSK (2), plus VHT operation saying 80 MHz.
        let rsn = [48u8, 20, 1, 0, 0, 0x0F, 0xAC, 4, 1, 0, 0, 0x0F, 0xAC, 4, 1, 0, 0, 0x0F, 0xAC, 2, 0, 0];
        let vht = [192u8, 5, 1, 42, 0, 0, 0];
        let ies: Vec<u8> = rsn.iter().chain(vht.iter()).copied().collect();
        assert_eq!(parse_ies(&ies, true), (80, "WPA2 Personal".into()));
        assert_eq!(parse_ies(&[], false), (20, "Open".into()));
    }
}
