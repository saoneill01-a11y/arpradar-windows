//! SNMP v2c table walks for the network map: a managed switch's ports, MAC address table and LLDP neighbours
//! (same as the Mac's Scan/SNMPWalk.swift). Blocking: run it on a worker thread.

use crate::identify::{decode_oid, integer, oid, read_tlv, tlv};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::{Duration, Instant};

/// One value from an SNMP table.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Int(i64),
    Bytes(Vec<u8>),
    Oid(Vec<u32>),
    None,
}

impl Value {
    pub fn int(&self) -> Option<i64> {
        if let Value::Int(v) = self { Some(*v) } else { None }
    }
    pub fn bytes(&self) -> &[u8] {
        if let Value::Bytes(b) = self { b } else { &[] }
    }
    /// Text, with control characters dropped (names, port descriptions).
    pub fn text(&self) -> String {
        crate::identify::clean_text(&String::from_utf8_lossy(self.bytes()), 120)
    }
}

/// Reads whole tables from one device with GetBulk: 20 rows per request, 3 tries of 1.5 s each, at most 20,000 rows.
pub struct Walker {
    ip: Ipv4Addr,
    community: String,
    port: u16,
    timeout: Duration,
    max_rows: usize,
    sock: Option<UdpSocket>,
    request_id: i32,
}

impl Walker {
    pub fn new(ip: Ipv4Addr, community: &str, port: u16) -> Self {
        let sock = UdpSocket::bind("0.0.0.0:0").ok();
        let request_id = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(1) & 0x0FFF_FFFF) as i32;
        Walker { ip, community: community.to_string(), port, timeout: Duration::from_millis(1500), max_rows: 20_000, sock, request_id: request_id.max(1) }
    }

    /// Every row under `root`: (the rest of the OID after `root`, value). Empty when it doesn't answer.
    pub fn walk(&mut self, root: &[u32]) -> Vec<(Vec<u32>, Value)> {
        let mut out = Vec::new();
        if self.sock.is_none() {
            return out;
        }
        let mut next = root.to_vec();
        while out.len() < self.max_rows {
            let Some(binds) = self.get_bulk(&next) else { break };
            let mut moved = false;
            for (o, v) in binds {
                if o.len() <= root.len() || o[..root.len()] != *root || v == Value::None {
                    return out;
                }
                if !is_after(&o, &next) {
                    return out; // an agent that goes backwards would loop forever
                }
                out.push((o[root.len()..].to_vec(), v));
                next = o;
                moved = true;
            }
            if !moved {
                break;
            }
        }
        out
    }

    /// A GetBulk for the rows after `oid`, sent up to three times.
    fn get_bulk(&mut self, after: &[u32]) -> Option<Vec<(Vec<u32>, Value)>> {
        self.request_id = self.request_id.wrapping_add(1);
        let id = self.request_id;
        let packet = bulk_request(&self.community, id, after, 20);
        let sock = self.sock.as_ref()?;
        let to = SocketAddrV4::new(self.ip, self.port);
        let mut buf = vec![0u8; 65_536];
        for _ in 0..3 {
            let _ = sock.send_to(&packet, to);
            let deadline = Instant::now() + self.timeout;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                let _ = sock.set_read_timeout(Some(left.max(Duration::from_millis(5))));
                match sock.recv_from(&mut buf) {
                    Ok((n, SocketAddr::V4(from))) if *from.ip() == self.ip => {
                        if let Some((rid, err, binds)) = parse_binds(&buf[..n]) {
                            if rid == id {
                                return (err == 0).then_some(binds);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                    Err(_) => break,
                }
            }
        }
        None
    }
}

pub fn is_after(a: &[u32], b: &[u32]) -> bool {
    for (x, y) in a.iter().zip(b) {
        if x != y {
            return x > y;
        }
    }
    a.len() > b.len()
}

pub fn bulk_request(community: &str, id: i32, start: &[u32], repetitions: i32) -> Vec<u8> {
    let bind = tlv(0x30, &[oid(start), vec![0x05, 0x00]].concat());
    // GetBulkRequest: request id, non-repeaters 0, max-repetitions.
    let pdu = tlv(0xA5, &[integer(id), integer(0), integer(repetitions), tlv(0x30, &bind)].concat());
    tlv(0x30, &[integer(1), tlv(0x04, community.as_bytes()), pdu].concat())
}

fn signed(s: &[u8]) -> i64 {
    let Some(&first) = s.first() else { return 0 };
    let mut v: i64 = if first & 0x80 != 0 { -1 } else { 0 };
    for &b in s.iter().take(8) {
        v = v << 8 | b as i64;
    }
    v
}

fn unsigned(s: &[u8]) -> i64 {
    let start = s.len().saturating_sub(8);
    s[start..].iter().fold(0u64, |v, &b| v << 8 | b as u64) as i64
}

/// A GetResponse: its request id, error status and (OID, value) pairs.
pub fn parse_binds(b: &[u8]) -> Option<(i32, i64, Vec<(Vec<u32>, Value)>)> {
    let mut o = 0;
    let (t, msg) = read_tlv(b, &mut o)?;
    if t != 0x30 {
        return None;
    }
    o = msg.start;
    if read_tlv(b, &mut o)?.0 != 0x02 || read_tlv(b, &mut o)?.0 != 0x04 {
        return None;
    }
    let (t, pdu) = read_tlv(b, &mut o)?;
    if t != 0xA2 {
        return None;
    }
    o = pdu.start;
    let (t, id) = read_tlv(b, &mut o)?;
    if t != 0x02 {
        return None;
    }
    let (_, err) = read_tlv(b, &mut o)?;
    read_tlv(b, &mut o)?;
    let (t, list) = read_tlv(b, &mut o)?;
    if t != 0x30 {
        return None;
    }
    let mut binds = Vec::new();
    let mut p = list.start;
    while p < list.end {
        let Some((t, bind)) = read_tlv(b, &mut p) else { break };
        if t != 0x30 {
            break;
        }
        let mut q = bind.start;
        let (Some((0x06, name)), Some((vt, v))) = (read_tlv(b, &mut q), read_tlv(b, &mut q)) else { continue };
        let value = match vt {
            0x02 => Value::Int(signed(&b[v])),                              // INTEGER
            0x41 | 0x42 | 0x43 | 0x46 => Value::Int(unsigned(&b[v])),       // Counter32, Gauge32, TimeTicks, Counter64
            0x04 | 0x40 => Value::Bytes(b[v].to_vec()),                      // OCTET STRING, IpAddress
            0x06 => Value::Oid(decode_oid(&b[v])),
            _ => Value::None,                                                // NULL, noSuchObject, endOfMibView…
        };
        binds.push((decode_oid(&b[name]), value));
    }
    Some((signed(&b[id]) as i32, signed(&b[err]), binds))
}

// MARK: What the map needs from one switch

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Port {
    pub name: String,
    pub mbps: i64,
    pub up: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Neighbor {
    pub local_port: i64,
    #[serde(rename = "chassisMAC")]
    pub chassis_mac: String,
    pub chassis_text: String,
    pub sys_name: String,
    #[serde(rename = "portID")]
    pub port_id: String,
    pub port_descr: String,
}

/// The tables the map reads from a managed switch. Port numbers are bridge ports (on almost every switch these are
/// the front-panel numbers).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwitchData {
    pub ip: String,
    /// The MAC the scan found for its management address.
    pub mac: String,
    /// dot1dBaseBridgeAddress (often what LLDP neighbours report as its chassis id).
    #[serde(rename = "bridgeMAC")]
    pub bridge_mac: String,
    pub name: String,
    pub descr: String,
    pub ports: BTreeMap<i64, Port>,
    /// MAC → the bridge port it was learned on.
    pub mac_table: BTreeMap<String, i64>,
    pub neighbors: Vec<Neighbor>,
}

const BRIDGE_ADDRESS: [u32; 9] = [1, 3, 6, 1, 2, 1, 17, 1, 1];
const BASE_PORT_IF_INDEX: [u32; 11] = [1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2];
const IF_NAME: [u32; 11] = [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1];
const IF_DESCR: [u32; 10] = [1, 3, 6, 1, 2, 1, 2, 2, 1, 2];
const IF_HIGH_SPEED: [u32; 11] = [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15];
const IF_OPER_STATUS: [u32; 10] = [1, 3, 6, 1, 2, 1, 2, 2, 1, 8];
const Q_FDB_PORT: [u32; 13] = [1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2];
const FDB_PORT: [u32; 11] = [1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2];
const LLDP_REM: [u32; 10] = [1, 0, 8802, 1, 1, 2, 1, 4, 1, 1];
const LLDP_LOC_PORT: [u32; 10] = [1, 0, 8802, 1, 1, 2, 1, 3, 7, 1];
/// CISCO-VTP-MIB vtpVlanState (index: domain.vlan; 1 = operational).
const CISCO_VLAN_STATE: [u32; 14] = [1, 3, 6, 1, 4, 1, 9, 9, 46, 1, 3, 1, 1, 2];
/// Most VLANs read per switch (each is a few requests).
const MAX_VLANS: usize = 64;

/// A real switch: at least 4 bridge ports, and it has learned MACs or has LLDP neighbours. (A NAS or a virtual-machine
/// host can answer a few bridge questions too, but won't pass this.)
pub fn looks_like_switch(ports: usize, macs: usize, neighbors: usize) -> bool {
    ports >= 4 && (macs > 0 || neighbors > 0)
}

/// One VLAN's bridge table on a Cisco switch: bridge port → ifIndex, and MAC → bridge port.
pub struct VlanTables {
    pub bridge_ports: HashMap<i64, i64>,
    pub fdb: HashMap<String, i64>,
}

/// Cisco keeps one bridge table per VLAN, read with "community@vlan". Joins them: the ifIndex → bridge-port map from
/// each VLAN (ports only in other VLANs get numbers too) and every MAC learned in any VLAN.
pub fn join_vlans(base: &HashMap<i64, i64>, vlans: &[VlanTables]) -> (HashMap<i64, i64>, HashMap<String, i64>) {
    let mut ports = base.clone();
    let mut macs = HashMap::new();
    for v in vlans {
        let mut bps: Vec<(&i64, &i64)> = v.bridge_ports.iter().collect();
        bps.sort();
        for (&bp, &ifx) in bps {
            if !ports.contains_key(&ifx) {
                // The same bridge number for a port in every VLAN on almost all Catalysts; if it's taken, use the ifIndex.
                let taken = ports.values().any(|&x| x == bp);
                ports.insert(ifx, if taken { ifx } else { bp });
            }
        }
        for (m, bp) in &v.fdb {
            if let Some(ours) = v.bridge_ports.get(bp).and_then(|ifx| ports.get(ifx)) {
                macs.insert(m.clone(), *ours);
            }
        }
    }
    (ports, macs)
}

pub fn mac_text(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":")
}

/// A port id is text ("Gi1/0/5", "5") or, for some switches, a MAC address.
pub fn port_id_text(b: &[u8]) -> String {
    if b.len() == 6 && b.iter().any(|&x| !(0x20..=0x7E).contains(&x)) {
        return mac_text(b);
    }
    crate::identify::clean_text(&String::from_utf8_lossy(b), 120)
}

/// The bridge port an LLDP port number means: by name, then as an ifIndex, then as a bridge port.
pub fn bridge_port(lldp_port: i64, id: &str, descr: &str, d: &SwitchData, port_of_if: &HashMap<i64, i64>) -> Option<i64> {
    for text in [id, descr] {
        if text.is_empty() {
            continue;
        }
        if let Some((bp, _)) = d.ports.iter().find(|(_, p)| p.name.eq_ignore_ascii_case(text)) {
            return Some(*bp);
        }
    }
    if let Some(bp) = id.parse::<i64>().ok().and_then(|n| port_of_if.get(&n)) {
        return Some(*bp);
    }
    if let Some(bp) = port_of_if.get(&lldp_port) {
        return Some(*bp);
    }
    d.ports.contains_key(&lldp_port).then_some(lldp_port)
}

fn mac_from_index(idx: &[u32]) -> String {
    mac_text(&idx.iter().map(|&x| x as u8).collect::<Vec<_>>())
}

/// Reads one device. None when it isn't a switch or doesn't answer; `log` gets a line either way.
pub fn read(ip: Ipv4Addr, mac: &str, name: &str, descr: &str, community: &str, port: u16, log: &mut Vec<String>) -> Option<SwitchData> {
    let mut w = Walker::new(ip, community, port);
    let bridge_ports = w.walk(&BASE_PORT_IF_INDEX);
    if bridge_ports.len() < 2 {
        log.push(format!("SNMP {ip}: not a switch (no bridge ports)"));
        return None;
    }
    let mut d = SwitchData { ip: ip.to_string(), mac: mac.to_string(), name: name.to_string(), descr: descr.to_string(), ..Default::default() };
    if let Some((_, v)) = w.walk(&BRIDGE_ADDRESS).first() {
        if v.bytes().len() == 6 {
            d.bridge_mac = mac_text(v.bytes());
        }
    }
    let mut port_of_if: HashMap<i64, i64> = HashMap::new();
    for (idx, v) in &bridge_ports {
        if let (Some(&bp), Some(ifx)) = (idx.first(), v.int()) {
            port_of_if.insert(ifx, bp as i64);
        }
    }
    // The MAC table: Q-BRIDGE (per VLAN, one table) first; on Cisco, one BRIDGE table per VLAN; else the plain BRIDGE table.
    let mut fdb: Vec<(String, i64)> = w
        .walk(&Q_FDB_PORT)
        .into_iter()
        .filter_map(|(idx, v)| (idx.len() >= 7).then_some(()).and(v.int()).filter(|&p| p > 0).map(|p| (mac_from_index(&idx[idx.len() - 6..]), p)))
        .collect();
    if fdb.is_empty() {
        let vlans: Vec<u32> = w
            .walk(&CISCO_VLAN_STATE)
            .into_iter()
            .filter(|(idx, v)| idx.len() == 2 && v.int() == Some(1))
            .map(|(idx, _)| idx[1])
            .filter(|v| !(1002..=1005).contains(v)) // Cisco's reserved FDDI/Token Ring VLANs
            .collect();
        if !vlans.is_empty() {
            let mut contexts = Vec::new();
            for v in vlans.iter().take(MAX_VLANS) {
                let mut vw = Walker::new(ip, &format!("{community}@{v}"), port);
                let mut bps = HashMap::new();
                for (idx, val) in vw.walk(&BASE_PORT_IF_INDEX) {
                    if let (Some(&bp), Some(ifx)) = (idx.first(), val.int()) {
                        bps.insert(bp as i64, ifx);
                    }
                }
                let mut table = HashMap::new();
                for (idx, val) in vw.walk(&FDB_PORT) {
                    if idx.len() == 6 {
                        if let Some(p) = val.int().filter(|&p| p > 0) {
                            table.insert(mac_from_index(&idx), p);
                        }
                    }
                }
                contexts.push(VlanTables { bridge_ports: bps, fdb: table });
            }
            let (ports, macs) = join_vlans(&port_of_if, &contexts);
            port_of_if = ports;
            fdb = macs.into_iter().collect();
            let n = vlans.len().min(MAX_VLANS);
            log.push(format!("SNMP {ip}: Cisco, {n} VLAN{} read", if n == 1 { "" } else { "s" }));
        }
    }
    let mut by_if = |root: &[u32]| -> HashMap<i64, Value> {
        let mut m = HashMap::new();
        for (idx, v) in w.walk(root) {
            if let Some(&i) = idx.first() {
                m.entry(i as i64).or_insert(v);
            }
        }
        m
    };
    let (names, descrs, speeds, status) = (by_if(&IF_NAME), by_if(&IF_DESCR), by_if(&IF_HIGH_SPEED), by_if(&IF_OPER_STATUS));
    for (ifx, bp) in &port_of_if {
        let n = names.get(ifx).map(|v| v.text()).unwrap_or_default();
        d.ports.insert(*bp, Port {
            name: if n.is_empty() { descrs.get(ifx).map(|v| v.text()).unwrap_or_default() } else { n },
            mbps: speeds.get(ifx).and_then(|v| v.int()).unwrap_or(0),
            up: status.get(ifx).and_then(|v| v.int()) == Some(1),
        });
    }
    if fdb.is_empty() {
        fdb = w
            .walk(&FDB_PORT)
            .into_iter()
            .filter_map(|(idx, v)| (idx.len() == 6).then_some(()).and(v.int()).filter(|&p| p > 0).map(|p| (mac_from_index(&idx), p)))
            .collect();
    }
    for (m, p) in fdb {
        d.mac_table.insert(m, p);
    }
    // LLDP neighbours (index: column.timeMark.localPortNum.remIndex).
    let loc_ports = w.walk(&LLDP_LOC_PORT);
    let rem = w.walk(&LLDP_REM);
    let mut neighbors: BTreeMap<String, Neighbor> = BTreeMap::new();
    for (idx, v) in &rem {
        if idx.len() < 4 {
            continue;
        }
        let key = idx[1..].iter().map(|x| x.to_string()).collect::<Vec<_>>().join(".");
        let n = neighbors.entry(key).or_insert_with(|| Neighbor { local_port: idx[2] as i64, ..Default::default() });
        match idx[0] {
            5 => {
                // lldpRemChassisId
                if v.bytes().len() == 6 { n.chassis_mac = mac_text(v.bytes()) } else { n.chassis_text = v.text() }
            }
            7 => n.port_id = port_id_text(v.bytes()), // lldpRemPortId
            8 => n.port_descr = v.text(),             // lldpRemPortDesc
            9 => n.sys_name = v.text(),               // lldpRemSysName
            _ => {}
        }
    }
    // LLDP's own port numbers → bridge ports, by the local port's id or description.
    let (mut loc_id, mut loc_desc) = (HashMap::new(), HashMap::new());
    for (idx, v) in &loc_ports {
        if idx.len() == 2 {
            if idx[0] == 3 {
                loc_id.insert(idx[1] as i64, port_id_text(v.bytes()));
            }
            if idx[0] == 4 {
                loc_desc.insert(idx[1] as i64, v.text());
            }
        }
    }
    let mut list: Vec<Neighbor> = neighbors
        .into_values()
        .filter_map(|mut n| {
            let id = loc_id.get(&n.local_port).cloned().unwrap_or_default();
            let desc = loc_desc.get(&n.local_port).cloned().unwrap_or_default();
            n.local_port = bridge_port(n.local_port, &id, &desc, &d, &port_of_if)?;
            Some(n)
        })
        .collect();
    list.sort_by_key(|n| n.local_port);
    d.neighbors = list;
    if !looks_like_switch(d.ports.len(), d.mac_table.len(), d.neighbors.len()) {
        log.push(format!("SNMP {ip}: not a switch ({} bridge ports, {} MACs, no LLDP neighbours)", d.ports.len(), d.mac_table.len()));
        return None;
    }
    log.push(format!("SNMP {ip}: {} ports, {} MAC table entries, {} LLDP neighbours", d.ports.len(), d.mac_table.len(), d.neighbors.len()));
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_request_and_response() {
        let req = bulk_request("public", 7, &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1], 20);
        assert_eq!(req[0], 0x30);
        assert!(req.contains(&0xA5)); // GetBulkRequest
        // A made-up response: ifName.1 = "Gi1/0/1", ifHighSpeed.1 = Gauge32 1000, then endOfMibView.
        let bind = |o: &[u32], v: Vec<u8>| tlv(0x30, &[oid(o), v].concat());
        let binds = [
            bind(&[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1, 1], tlv(0x04, b"Gi1/0/1")),
            bind(&[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15, 1], tlv(0x42, &[0x03, 0xE8])),
            bind(&[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15, 2], vec![0x82, 0x00]),
        ]
        .concat();
        let pdu = tlv(0xA2, &[integer(7), integer(0), integer(0), tlv(0x30, &binds)].concat());
        let msg = tlv(0x30, &[integer(1), tlv(0x04, b"public"), pdu].concat());
        let (id, err, b) = parse_binds(&msg).unwrap();
        assert_eq!((id, err, b.len()), (7, 0, 3));
        assert_eq!(b[0].1.text(), "Gi1/0/1");
        assert_eq!(b[1].1.int(), Some(1000));
        assert_eq!(b[2].1, Value::None);
        assert!(is_after(&[1, 3, 6, 2], &[1, 3, 6, 1, 9]));
        assert!(!is_after(&[1, 3, 6, 1], &[1, 3, 6, 1]));
    }

    #[test]
    fn lldp_port_numbers() {
        let mut d = SwitchData::default();
        d.ports.insert(1, Port { name: "Gi1/0/1".into(), ..Default::default() });
        d.ports.insert(2, Port { name: "Gi1/0/2".into(), ..Default::default() });
        let port_of_if = HashMap::from([(10101, 1), (10102, 2)]);
        assert_eq!(bridge_port(7, "Gi1/0/2", "", &d, &port_of_if), Some(2)); // by name
        assert_eq!(bridge_port(7, "10101", "", &d, &port_of_if), Some(1)); // ifIndex
        assert_eq!(bridge_port(10102, "", "", &d, &port_of_if), Some(2));
        assert_eq!(bridge_port(1, "x", "", &d, &HashMap::new()), Some(1)); // bridge port
        assert_eq!(port_id_text(&[0x02, 0, 0, 0, 0, 0x2A]), "02:00:00:00:00:2A");
        assert_eq!(port_id_text(b"port 5"), "port 5");
    }

    #[test]
    fn cisco_vlan_tables_are_joined() {
        // VLAN 1: Gi1 (ifIndex 10101) is bridge port 1. VLAN 20 adds Gi5 (ifIndex 10105, bridge port 5), only in VLAN 20.
        let base = HashMap::from([(10101, 1)]);
        let vlan1 = VlanTables { bridge_ports: HashMap::from([(1, 10101)]), fdb: HashMap::from([("02:00:00:00:00:AA".to_string(), 1)]) };
        let vlan20 = VlanTables {
            bridge_ports: HashMap::from([(1, 10101), (5, 10105)]),
            fdb: HashMap::from([("02:00:00:00:00:BB".to_string(), 5), ("02:00:00:00:00:CC".to_string(), 1)]),
        };
        let (ports, macs) = join_vlans(&base, &[vlan1, vlan20]);
        assert_eq!(ports[&10105], 5);
        assert_eq!(macs["02:00:00:00:00:AA"], 1);
        assert_eq!(macs["02:00:00:00:00:BB"], 5);
        assert_eq!(macs["02:00:00:00:00:CC"], 1);
        // A VLAN whose bridge number is already taken by another port gets the ifIndex instead, never a clash.
        let odd = VlanTables { bridge_ports: HashMap::from([(1, 10107)]), fdb: HashMap::from([("02:00:00:00:00:DD".to_string(), 1)]) };
        let (ports, macs) = join_vlans(&base, &[odd]);
        assert_eq!(ports[&10107], 10107);
        assert_eq!(macs["02:00:00:00:00:DD"], 10107);
    }

    #[test]
    fn servers_are_not_switches() {
        assert!(looks_like_switch(8, 12, 0));
        assert!(looks_like_switch(24, 0, 2));
        assert!(!looks_like_switch(2, 30, 0)); // a VM host's bridge
        assert!(!looks_like_switch(6, 0, 0)); // nothing learned, no neighbours
    }

    /// Against a real agent, when one runs on this computer for testing (net-snmp on 127.0.0.1:16161, community
    /// "arpradar-test"); passes without checking anything otherwise.
    #[test]
    fn walks_a_real_agent() {
        let mut w = Walker::new(Ipv4Addr::LOCALHOST, "arpradar-test", 16161);
        w.timeout = Duration::from_millis(500);
        let system = w.walk(&[1, 3, 6, 1, 2, 1, 1]);
        if system.is_empty() {
            return; // no test agent
        }
        assert!(!system.iter().find(|(i, _)| i == &[1, 0]).map(|(_, v)| v.text()).unwrap_or_default().is_empty());
        let all = w.walk(&[1, 3, 6, 1, 2, 1]);
        assert!(all.len() > 40);
        for pair in all.windows(2) {
            assert!(is_after(&pair[1].0, &pair[0].0));
        }
    }
}
