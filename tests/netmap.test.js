// Tests for the map's pure parts (ui/netmap.js): the SNMP switch layout and merge, the UniFi uplink parsing and the
// Switch port links. Same cases as the Mac's SNMPMapTests / SwitchLinkTests. Run: node tests/netmap.test.js
// (no packages needed; GitHub Actions runs it before building). Made-up MACs and addresses only.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert/strict");

const ctx = { console, document: { createElement: () => ({ getContext: () => ({ measureText: t => ({ width: String(t).length * 6 }) }) }) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "netmap.js"), "utf8")
  + "\nObject.assign(this, { NetMapBuilder, UniFiJSON, SNMPMapBuilder, mapSwitchLinks, switchLinkShort });", ctx);
const { NetMapBuilder, UniFiJSON, SNMPMapBuilder, mapSwitchLinks, switchLinkShort } = ctx;

/// Arrays made inside the sandbox have its own Array prototype: compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const node = (map, id) => map.nodes.find(n => n.id === id);
const ports = (n, speed = p => (p === 10 ? 10000 : 1000), name = p => `Gi0/${p}`) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { name: name(i + 1), mbps: speed(i + 1), up: true }]));
const at = (r, m) => { const p = r.placements.get(m); return p ? `${p.switchMAC} P${p.port}` : null; };

/// gateway ─ P1 core (Cisco-ish, 24 ports)
///             P10 ─LLDP─ P24 access-a ─ P3 printer, P4 pc-1
///             P11 ─────── P8 access-b (no LLDP) ─ P5 UniFi AP (+ its Wi-Fi phone), P6 pc-2 + pc-3 (a small unmanaged switch)
///             P2 nas
function network() {
  const gw = "02:00:00:00:00:01";
  const core = "02:00:00:00:00:10", a = "02:00:00:00:00:20", b = "02:00:00:00:00:30";
  const printer = "02:00:00:00:01:03", pc1 = "02:00:00:00:01:04", nas = "02:00:00:00:01:02";
  const ap = "02:00:00:00:02:05", phone = "02:00:00:00:02:99", pc2 = "02:00:00:00:02:06", pc3 = "02:00:00:00:02:07";
  const c = { ip: "10.20.30.2", mac: core, bridgeMAC: "02:00:00:00:00:11", name: "core.example.lan", descr: "Cisco IOS Software, C2960X Software",
    ports: ports(24), macTable: { [gw]: 1, [nas]: 2, [a]: 10, [printer]: 10, [pc1]: 10, [b]: 11, [ap]: 11, [phone]: 11, [pc2]: 11, [pc3]: 11 },
    neighbors: [{ localPort: 10, chassisMAC: "02:00:00:00:00:21", chassisText: "", sysName: "access-a", portID: "Gi0/24", portDescr: "" }] };
  const sa = { ip: "10.20.30.3", mac: a, bridgeMAC: "02:00:00:00:00:21", name: "access-a", descr: "Aruba", ports: ports(24),
    macTable: { [gw]: 24, [core]: 24, [nas]: 24, [b]: 24, [printer]: 3, [pc1]: 4 },
    neighbors: [{ localPort: 24, chassisMAC: "02:00:00:00:00:11", chassisText: "", sysName: "core", portID: "Gi0/10", portDescr: "" }] };
  const sb = { ip: "10.20.30.4", mac: b, bridgeMAC: "", name: "access-b", descr: "Netgear GS308T", ports: ports(8),
    macTable: { [gw]: 8, [core]: 8, [nas]: 8, [a]: 8, [ap]: 5, [phone]: 5, [pc2]: 6, [pc3]: 6 }, neighbors: [] };
  return { switches: [c, sa, sb], gw };
}

test("switches and devices are placed", () => {
  const { switches, gw } = network();
  const r = SNMPMapBuilder.layout(switches, gw);
  const by = new Map(r.devices.map(d => [d.mac, d]));
  const core = by.get("02:00:00:00:00:10");
  assert.equal(core.uplinkMAC, gw);
  assert.equal(core.uplinkOwnPort, 1);
  assert.equal(core.model, "Cisco IOS Software");
  const a = by.get("02:00:00:00:00:20");
  assert.equal(a.uplinkMAC, "02:00:00:00:00:10");
  assert.equal(a.uplinkRemotePort, 10);          // from LLDP
  assert.equal(a.uplinkOwnPort, 24);
  assert.equal(a.uplinkMbps, 1000);               // the slower end of a 10G/1G link
  const b = by.get("02:00:00:00:00:30");
  assert.equal(b.uplinkMAC, "02:00:00:00:00:10");
  assert.equal(b.uplinkRemotePort, 11);          // from the MAC table, no LLDP
  assert.equal(b.uplinkOwnPort, 8);
  assert.equal(at(r, "02:00:00:00:01:02"), "02:00:00:00:00:10 P2");   // nas on the core
  assert.equal(at(r, "02:00:00:00:01:03"), "02:00:00:00:00:20 P3");   // printer on access-a, not the core's P10
  assert.equal(at(r, "02:00:00:00:01:04"), "02:00:00:00:00:20 P4");
  assert.equal(at(r, "02:00:00:00:02:06"), "02:00:00:00:00:30 P6");
  assert.equal(r.placements.has(gw), false);
  assert.equal(r.placements.has("02:00:00:00:00:20"), false);         // switches aren't devices
});

test("drawn as a map and mixed with UniFi", () => {
  const { switches, gw } = network();
  // The UniFi controller knows the AP and its Wi-Fi phone, but not where the AP plugs in (a non-UniFi switch).
  const ap = { mac: "02:00:00:00:02:05", name: "Lobby AP", model: "U6 Lite", ip: "10.20.30.50", firmware: "", type: "uap", online: true,
    uplinkMAC: "", uplinkRemotePort: null, uplinkOwnPort: null, uplinkMbps: null, uplinkToNonUniFi: true, wireless: false, signal: null, ports: [], channels: "" };
  const phone = { mac: "02:00:00:00:02:99", ip: "10.20.30.99", name: "phone", parentMAC: "02:00:00:00:02:05", wired: false, port: null, signal: null, ssid: "" };
  const snmp = SNMPMapBuilder.layout(switches, gw, new Set(["02:00:00:00:02:05"]));
  assert.equal(at(snmp, "02:00:00:00:02:05"), "02:00:00:00:00:30 P5");
  const scan = [{ ip: "10.20.30.1", mac: gw, name: "firewall" }, { ip: "10.20.30.62", mac: "02:00:00:00:02:06", name: "pc-2" }];
  const merged = SNMPMapBuilder.merge([ap], [phone], snmp, scan);
  const map = NetMapBuilder.build(merged.devices, merged.clients, scan, "10.20.30.1", "");
  const root = map.nodes[0];
  assert.equal(node(map, "02:00:00:00:00:10").parent, root.id);
  assert.equal(node(map, "02:00:00:00:00:20").parent, "02:00:00:00:00:10");
  const lobby = node(map, "02:00:00:00:02:05");
  assert.equal(lobby.parent, "02:00:00:00:00:30");                    // the AP hangs off access-b, port 5
  assert.equal(lobby.parentPort, 5);
  assert.equal(lobby.guessed, false);
  assert.deepEqual(plain(lobby.clients.filter(c => !c.wired).map(c => c.name)), ["phone"]);   // UniFi's own client list wins
  assert.ok(map.nodes.every(n => !n.guessed || n.kind === "guess"));
  // pc-2 and pc-3 share access-b port 6: the usual "Unmanaged switch?" guess.
  assert.ok(map.nodes.some(n => n.kind === "guess" && n.parent === "02:00:00:00:00:30" && n.parentPort === 6));
  assert.deepEqual(plain(node(map, "02:00:00:00:00:20").clients.map(c => c.port)), [3, 4]);
  // The Switch port column reads the same map.
  assert.equal(switchLinkShort(mapSwitchLinks(map).get("02:00:00:00:01:03")), "access-a · P3");
});

test("without the gateway MAC", () => {
  // The gateway isn't in the scan: the busiest port counts as each switch's uplink.
  const { switches } = network();
  const r = SNMPMapBuilder.layout(switches, null);
  const by = new Map(r.devices.map(d => [d.mac, d]));
  assert.equal(by.get("02:00:00:00:00:20").uplinkMAC, "02:00:00:00:00:10");
  assert.equal(by.get("02:00:00:00:00:30").uplinkMAC, "02:00:00:00:00:10");
  assert.equal(r.placements.get("02:00:00:00:01:03").switchMAC, "02:00:00:00:00:20");
});

test("a gateway that is a switch", () => {
  // core (10.20.30.1, the router) ─ P24 ─ P1 access ─ P5 pc; the core's P3 has a printer.
  const core = "02:00:00:00:00:01", access = "02:00:00:00:00:20", pc = "02:00:00:00:01:05", printer = "02:00:00:00:01:03";
  const c = { ip: "10.20.30.1", mac: core, bridgeMAC: "", name: "core", descr: "Cisco IOS Software, C9300", ports: ports(24, () => 1000, p => `Gi${p}`),
    macTable: { [access]: 24, [pc]: 24, [printer]: 3 }, neighbors: [] };
  const a = { ip: "10.20.30.2", mac: access, bridgeMAC: "", name: "access", descr: "Aruba", ports: ports(8, () => 1000, p => `Gi${p}`),
    macTable: { [core]: 1, [printer]: 1, [pc]: 5 }, neighbors: [] };
  const snmp = SNMPMapBuilder.layout([c, a], core);
  const scan = [{ ip: "10.20.30.1", mac: core, name: "core" }];
  const merged = SNMPMapBuilder.merge([], [], snmp, scan);
  const map = NetMapBuilder.build(merged.devices, merged.clients, scan, "10.20.30.1", "");
  const root = map.nodes[0];
  assert.equal(root.id, core);                        // the core switch is the top of the map…
  assert.equal(root.kind, "gateway");
  assert.equal(root.ports.length, 24);                // …with its ports
  assert.equal(map.nodes.filter(n => n.id === core).length, 1);
  const acc = node(map, access);
  assert.equal(acc.parent, core);
  assert.equal(acc.parentPort, 24);
  assert.equal(acc.uplinkPort, 1);
  assert.equal(acc.guessed, false);
  assert.deepEqual(plain(root.clients.map(x => x.port)), [3]);   // the printer on the core's port 3
  assert.deepEqual(plain(acc.clients.map(x => x.port)), [5]);
});

test("UniFi switch plugged into a non-UniFi firewall isn't a guessed loop", () => {
  const gw = { mac: "aa:00:00:00:00:01", type: "udm", name: "Gateway", state: 1, ip: "10.20.30.1" };
  // Online, live uplink (port 1) with no uplink_mac (a non-UniFi firewall), stale last_uplink -> the Flex Mini behind it.
  const pro = { mac: "aa:00:00:00:00:48", type: "usw", name: "Core Pro 48", state: 1, ip: "10.20.30.2",
    uplink: { port_idx: 1, speed: 1000, type: "wire" }, last_uplink: { uplink_mac: "aa:00:00:00:00:05", uplink_remote_port: 3 } };
  const flex = { mac: "aa:00:00:00:00:05", type: "usw", name: "Flex Mini", state: 1, ip: "10.20.30.3",
    uplink: { uplink_mac: "aa:00:00:00:00:48", uplink_remote_port: 7, port_idx: 1, speed: 1000, type: "wire" } };
  // An offline switch with no live uplink still uses last_uplink.
  const off = { mac: "aa:00:00:00:00:09", type: "usw", name: "Closet", state: 0, last_uplink: { uplink_mac: "aa:00:00:00:00:48", uplink_remote_port: 9 } };
  const map = NetMapBuilder.build([gw, pro, flex, off].map(UniFiJSON.classicDevice), [], [], "10.20.30.1", "");
  const n = m => node(map, NetMapBuilder.mac(m));
  assert.equal(n(pro.mac).parent, NetMapBuilder.mac(gw.mac));
  assert.equal(n(pro.mac).guessed, false);
  assert.equal(n(flex.mac).parent, NetMapBuilder.mac(pro.mac));
  assert.equal(n(flex.mac).parentPort, 7);
  assert.equal(n(off.mac).parent, NetMapBuilder.mac(pro.mac));
  assert.equal(n(off.mac).parentPort, 9);
});

test("short model", () => {
  assert.equal(SNMPMapBuilder.shortModel("Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2"), "Cisco IOS Software");
  assert.equal(SNMPMapBuilder.shortModel(""), "Managed switch");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}
console.log(`${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
