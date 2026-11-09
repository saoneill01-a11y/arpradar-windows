// The Map tab: a network map from a UniFi controller (same as the Mac's NetMap.swift, UniFiController.swift and
// NetMapView.swift). The gateway at the top, switches and access points under it, each with its clients.
// Without a controller it only lists the Ubiquiti devices the scan found (every link a guess).
"use strict";

// MARK: Building the map

const NetMapBuilder = (() => {
  /// "74:ac:b9:1e:22:1" / "74acb91e2201" -> "74:AC:B9:1E:22:01"
  function mac(s) {
    s = String(s || "");
    const parts = s.split(/[:-]/);
    if (parts.length === 6) return parts.map(p => (p.length === 1 ? "0" + p : p)).join(":").toUpperCase();
    const hex = s.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length !== 12) return s.toUpperCase();
    return hex.match(/../g).join(":").toUpperCase();
  }
  const node = (id, kind, extra = {}) => ({ id, kind, name: "", model: "", ip: "", mac: "", firmware: "", parent: null, parentPort: null,
    uplinkPort: null, linkMbps: null, wireless: false, signal: null, online: true, channels: "", poeWatts: null, ports: [], clients: [],
    note: "", guessed: false, ...extra });

  const GATEWAY_TYPES = new Set(["ugw", "udm", "uxg", "ucg", "uck-gateway"]);

  /// `devices`/`clients`: the controller's answers as plain values; `scan`: online devices; `gatewayIP`: the scan's router.
  function build(devices, clients, scan, gatewayIP, controller) {
    const map = { date: new Date().toISOString(), source: "UniFi controller", controller, cabled: true, nodes: [] };
    const scanByMAC = new Map();
    for (const d of scan) if (d.mac && !scanByMAC.has(mac(d.mac))) scanByMAC.set(mac(d.mac), d);
    const gwIP = gatewayIP || "";
    let nodes = [];
    const uniGateway = devices.find(d => GATEWAY_TYPES.has((d.type || "").toLowerCase()) || (gwIP && d.ip === gwIP));
    let rootID;
    if (uniGateway) {
      rootID = mac(uniGateway.mac);
    } else {
      const gw = scan.find(d => d.ip === gwIP);
      if (gw) { rootID = gw.mac ? mac(gw.mac) : "gateway"; nodes.push(scanNode(gw, "gateway", rootID)); }
      else { rootID = "gateway"; nodes.push(node(rootID, "gateway", { name: "Gateway", model: "Not in this scan", guessed: true })); }
    }

    const uniMACs = new Set(devices.map(d => mac(d.mac)));
    for (const d of devices) {
      const id = mac(d.mac);
      const n = node(id, kindOf(d, id === rootID));
      n.name = d.name || scanByMAC.get(id)?.name || d.model;
      n.model = d.model; n.ip = d.ip; n.mac = id; n.firmware = d.firmware; n.online = d.online;
      n.ports = [...(d.ports || [])].sort((a, b) => a.idx - b.idx);
      n.channels = d.channels || "";
      const watts = (d.ports || []).reduce((t, p) => t + (p.poeWatts || 0), 0);
      n.poeWatts = watts > 0 ? watts : null;
      if (id !== rootID) {
        const up = mac(d.uplinkMAC);
        n.wireless = d.wireless; n.signal = d.signal;
        n.parentPort = d.uplinkRemotePort; n.uplinkPort = d.uplinkOwnPort; n.linkMbps = d.uplinkMbps;
        if (d.uplinkMAC && (uniMACs.has(up) || up === rootID)) {
          n.parent = up;
        } else if (d.uplinkMAC) {
          // Plugged into something that isn't UniFi (another switch, a firewall port): show it.
          n.parent = up;
          if (!nodes.some(x => x.id === up)) {
            const s = scanByMAC.get(up);
            const other = s ? scanNode(s, "other", up) : node(up, "other", { name: "Unknown device", mac: up });
            other.parent = rootID; other.guessed = true;
            nodes.push(other);
          }
        } else if (d.uplinkToNonUniFi) {
          // Its uplink port goes to something UniFi doesn't manage: the firewall at the top of the map.
          n.parent = rootID;
        } else {
          n.parent = rootID; n.guessed = true;
        }
        if (slowLink(n)) n.note = `Uplink is at ${d.uplinkMbps || 0} Mb. Check the cable or wall jack.`;
      }
      nodes.push(n);
    }

    nodes = breakLoops(nodes, rootID);

    // Clients go under the switch or access point they're on.
    const byID = new Set(nodes.map(n => n.id));
    const thisPc = new Set(scan.filter(d => d.thisPc && d.mac).map(d => mac(d.mac)));
    const attached = new Map();
    for (const c of clients) {
      const m = mac(c.mac);
      if (uniMACs.has(m) || byID.has(m)) continue;
      const s = scanByMAC.get(m);
      const mc = { mac: m, ip: c.ip || s?.ip || "", name: c.name || s?.name || "", vendor: s?.vendor || "",
                   wired: c.wired, port: c.port ?? null, signal: c.signal ?? null, ssid: c.ssid || "", isThisPc: thisPc.has(m) };
      const known = byID.has(mac(c.parentMAC));
      if (!known) mc.port = null;   // a port on some switch that isn't on the map
      const at = known ? mac(c.parentMAC) : rootID;
      if (!attached.has(at)) attached.set(at, []);
      attached.get(at).push(mc);
    }
    const cmp = (a, b) => ((a.port ?? 999) - (b.port ?? 999)) || a.name.localeCompare(b.name) || ipKey(a.ip) - ipKey(b.ip);
    for (const n of nodes) n.clients = (attached.get(n.id) || []).sort(cmp);

    nodes = labelPorts(guessUnmanagedSwitches(nodes));
    // The root goes first.
    const r = nodes.findIndex(n => n.id === rootID);
    if (r >= 0) { const root = nodes.splice(r, 1)[0]; root.parent = null; root.kind = "gateway"; nodes.unshift(root); }
    map.nodes = nodes;
    return map;
  }
  const ipKey = ip => String(ip || "").split(".").reduce((a, p) => a * 256 + (+p || 0), 0);

  /// Controllers sometimes report two switches as each other's uplink. A loop cuts everything in it off from the
  /// gateway, so the biggest switch in each loop is put under the gateway instead, as a guess.
  function breakLoops(input, rootID) {
    const nodes = input.map(n => ({ ...n }));
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const settled = new Set([rootID]);
    for (const start of nodes) {
      const path = [];
      let cur = start.id;
      while (cur != null && !settled.has(cur) && index.has(cur)) {
        const at = path.indexOf(cur);
        if (at >= 0) {
          const loop = path.slice(at).map(id => index.get(id));
          const score = i => [nodes[i].ports.length, nodes[i].kind === "switch" ? 1 : 0];
          let top = loop[0];
          for (const i of loop.slice(1)) {
            const [a1, a2] = score(i), [b1, b2] = score(top);
            if (a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && nodes[i].name < nodes[top].name)))) top = i;
          }
          const names = loop.filter(i => i !== top).map(i => nodes[i].name).join(", ");
          Object.assign(nodes[top], { parent: rootID, parentPort: null, guessed: true,
            note: `The controller says this switch and ${names} are each other’s uplink, so where it connects is a guess.` });
          break;
        }
        path.push(cur);
        cur = nodes[index.get(cur)].parent;
      }
      for (const p of path) settled.add(p);
    }
    return nodes;
  }

  function kindOf(d, isGateway) {
    if (isGateway) return "gateway";
    switch ((d.type || "").toLowerCase()) {
      case "usw": case "switching": return "switch";
      case "uap": case "accesspoint": return "ap";
      case "ugw": case "udm": case "uxg": case "ucg": return "gateway";
      default: return "device";
    }
  }

  function scanNode(d, kind, id) {
    const n = node(id, kind);
    n.name = d.name || (kind === "gateway" ? "Gateway" : d.vendor || d.ip);
    const descr = (d.snmpDescr || "").split("\n")[0];
    n.model = d.ubntModel || descr || d.upnp || d.vendor || "";
    if (n.model === n.name) n.model = kind === "gateway" ? "" : "No name";
    n.ip = d.ip; n.mac = d.mac ? mac(d.mac) : ""; n.firmware = d.ubntFirmware || "";
    return n;
  }

  /// Two or more wired devices on one switch port with no UniFi device on it: an unmanaged switch (or a VM host).
  function guessUnmanagedSwitches(input) {
    const nodes = input.map(n => ({ ...n, clients: [...n.clients] }));
    const extra = [];
    for (const n of nodes) {
      if (!(n.kind === "switch" || n.kind === "gateway") || !n.ports.length) continue;
      const used = new Set(nodes.filter(x => x.parent === n.id).map(x => x.parentPort).filter(p => p != null));
      const byPort = new Map();
      for (const c of n.clients) if (c.wired && c.port != null) { if (!byPort.has(c.port)) byPort.set(c.port, []); byPort.get(c.port).push(c); }
      for (const [port, list] of byPort) {
        if (list.length < 2 || used.has(port) || port === n.uplinkPort) continue;
        extra.push(node(`guess-${n.id}-${port}`, "guess", {
          name: "Unmanaged switch?", model: `${list.length} devices on port ${port}`, parent: n.id, parentPort: port, guessed: true,
          linkMbps: n.ports.find(p => p.idx === port)?.mbps ?? null,
          note: "Several devices share this port: an unmanaged switch, or a computer running virtual machines.", clients: list }));
        n.clients = n.clients.filter(c => !(list.includes(c) && c.port === port));
      }
    }
    return [...nodes, ...extra.sort((a, b) => (a.id < b.id ? -1 : 1))];
  }

  /// Fills in each port's "Connected" text.
  function labelPorts(input) {
    const nodes = input.map(n => ({ ...n, ports: n.ports.map(p => ({ ...p })) }));
    for (const n of nodes) {
      if (!n.ports.length) continue;
      const kids = nodes.filter(k => k.parent === n.id);
      const parent = nodes.find(x => x.id === n.parent);
      for (const p of n.ports) {
        const k = kids.find(k => k.parentPort === p.idx);
        if (k) p.connected = k.kind === "guess" ? k.model : k.name;
        else if (parent && n.uplinkPort === p.idx) p.connected = "↑ " + parent.name;
        else {
          const here = n.clients.filter(c => c.wired && c.port === p.idx);
          p.connected = here.length === 1 ? displayName(here[0]) : here.length > 1 ? `${here.length} devices` : "";
        }
      }
    }
    return nodes;
  }

  /// No controller: the gateway with every Ubiquiti device the scan found under it. Nothing says how they're cabled.
  function withoutController(scan, gatewayIP) {
    const gw = scan.find(d => d.ip === gatewayIP);
    const rootID = gw ? (gw.mac ? mac(gw.mac) : "gateway") : "gateway";
    const root = gw ? scanNode(gw, "gateway", rootID) : node(rootID, "gateway", { name: "Gateway", model: "Not in this scan", guessed: true });
    const nodes = [root];
    for (const d of scan) {
      if (!d.isOnline || d.ip === gw?.ip || !isUbiquiti(d)) continue;
      const n = scanNode(d, guessKind(d), d.mac ? mac(d.mac) : d.ip);
      n.parent = rootID; n.guessed = true;
      if (nodes.some(x => x.id === n.id)) n.id = d.ip;
      nodes.push(n);
    }
    return { date: new Date().toISOString(), source: "This scan only", controller: "", cabled: false, nodes };
  }
  const isUbiquiti = d => !!d.ubntModel || /ubiquiti/i.test(d.vendor || "");
  /// From its name or model: "housebackbedroomswitch.lan" -> switch, "shopap.lan" -> access point.
  function guessKind(d) {
    const text = [d.name, d.ubntModel].filter(Boolean).join(" ").toLowerCase();
    if (text.includes("switch") || text.includes("usw") || text.includes("flex mini")) return "switch";
    if (/(^|[^a-z])(ap|u6|u7|uap|nanohd|access point)([^a-z]|$)/.test(text) || text.endsWith("ap.lan") || text.endsWith("ap")) return "ap";
    return "device";
  }

  return { mac, build, breakLoops, withoutController, guessKind, labelPorts, guessUnmanagedSwitches };
})();

// Small helpers about nodes and clients.
// MARK: Managed switches over SNMP (any brand), same as the Mac's SNMPMap.swift

/// Turns what managed switches report over SNMP (their MAC tables and LLDP neighbours) into the same device and client
/// records the UniFi controller gives, so NetMapBuilder.build draws them, alone or mixed with UniFi gear.
/// - A switch's uplink is the port it learned the gateway's MAC on. When the gateway is itself one of the switches (a
///   layer-3 core), it has no uplink and becomes the top of the map, with its ports.
/// - Two switches are linked when LLDP says so, or when one learned the other's MAC on a port that isn't its uplink
///   (the port with the fewest MACs behind it wins: that's the closest one).
/// - A device is on the switch and port where it was learned with the fewest other MACs on that port. Ports facing
///   another switch don't count.
/// Switch data (from the snmp_switches command): {ip, mac, bridgeMAC, name, descr, ports: {bp: {name, mbps, up}},
/// macTable: {mac: bp}, neighbors: [{localPort, chassisMAC, chassisText, sysName, portID, portDescr}]}.
const SNMPMapBuilder = (() => {
  const num = o => new Map(Object.entries(o || {}).map(([k, v]) => [Number(k), v]));
  const firstLabel = t => String(t || "").toLowerCase().split(".")[0] || "";
  const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  /// Returns { devices: raw devices (as the UniFi parsers give), placements: Map MAC → {switchMAC, port} }.
  function layout(switchList, gatewayMAC, infrastructure = new Set()) {
    const mac = NetMapBuilder.mac;
    const gw = gatewayMAC ? mac(gatewayMAC) || null : null;
    // Each switch's id is the MAC the scan found for it (else its bridge address); any of its MACs identifies it.
    const sw = (switchList || []).filter(s => s.mac || s.bridgeMAC).map(s => ({ ...s, ports: num(s.ports) }));
    const ids = sw.map(s => mac(s.mac || s.bridgeMAC));
    const whose = new Map();
    sw.forEach((s, i) => { for (const m of [s.mac, s.bridgeMAC]) if (m) whose.set(mac(m), i); });
    const byName = new Map();
    sw.forEach((s, i) => { if (s.name && !byName.has(firstLabel(s.name))) byName.set(firstLabel(s.name), i); });
    const tables = sw.map(s => { const t = new Map(); for (const [m, p] of Object.entries(s.macTable || {})) if (!t.has(mac(m))) t.set(mac(m), Number(p)); return t; });
    // How many MACs each port carries (a smaller number means closer to the device).
    const load = tables.map(t => { const l = new Map(); for (const p of t.values()) l.set(p, (l.get(p) || 0) + 1); return l; });
    const portByText = (s, text) => { if (!text) return null; for (const [bp, p] of s.ports) if (sameText(p.name, text)) return bp; return null; };

    // Uplinks (towards the gateway), and LLDP links between the switches (and to the gateway). Without the gateway's
    // MAC (it isn't in the scan, e.g. over a VPN): the switch that has learned the most addresses is taken as the core,
    // and every other switch's uplink is the port it sees the core on.
    let core = null;
    if (!gw) tables.forEach((t, i) => { if (core === null || t.size > tables[core].size) core = i; });
    const uplink = tables.map((t, i) => {
      if (gw) return t.has(gw) ? t.get(gw) : null;
      if (core === null || core === i) return null;
      for (const m of [sw[core].mac, sw[core].bridgeMAC].filter(Boolean)) if (t.has(mac(m))) return t.get(mac(m));
      return null;
    });
    const links = sw.map(() => new Map());            // switch → its port → {other, otherPort}
    const facing = sw.map(() => new Set());           // ports that lead to a switch or the gateway
    sw.forEach((s, i) => {
      for (const n of s.neighbors || []) {
        const cm = n.chassisMAC ? mac(n.chassisMAC) : "";
        if (gw && cm === gw) { if (uplink[i] == null) uplink[i] = n.localPort; facing[i].add(n.localPort); continue; }
        if (cm && infrastructure.has(cm)) { facing[i].add(n.localPort); continue; }
        const other = cm ? whose.get(cm) : undefined;
        const t = other ?? byName.get(firstLabel(n.sysName)) ?? byName.get(firstLabel(n.chassisText));
        if (t === undefined || t === i) continue;
        let theirPort = portByText(sw[t], n.portID) ?? portByText(sw[t], n.portDescr);
        if (theirPort == null && /^\d+$/.test(n.portID || "") && sw[t].ports.has(Number(n.portID))) theirPort = Number(n.portID);
        links[i].set(n.localPort, { other: t, otherPort: theirPort });
        facing[i].add(n.localPort);
      }
      if (uplink[i] != null) facing[i].add(uplink[i]);
      // Ports where UniFi gear (switches, access points) is learned lead to more of the network.
      for (const [m, p] of tables[i]) if (infrastructure.has(m)) facing[i].add(p);
    });

    // Parents.
    const parent = sw.map(() => null), parentPort = sw.map(() => null), toGateway = sw.map(() => false);
    sw.forEach((s, i) => {
      // LLDP on the uplink port names the switch above.
      const l = uplink[i] != null ? links[i].get(uplink[i]) : null;
      if (l) { parent[i] = l.other; parentPort[i] = l.otherPort ?? tables[l.other].get(ids[i]) ?? null; return; }
      // Otherwise the closest switch that learned this one's MAC on a port that isn't its own uplink.
      const mine = [s.mac, s.bridgeMAC].filter(Boolean).map(mac);
      let best = null;
      sw.forEach((_, t) => {
        if (t === i) return;
        for (const m of mine) {
          const p = tables[t].get(m);
          if (p == null || p === uplink[t]) continue;
          const ld = load[t].get(p) || 0;
          if (!best || ld < best.load) best = { t, port: p, load: ld };
        }
      });
      if (best) { parent[i] = best.t; parentPort[i] = best.port; return; }
      // Nothing above it: it's the switch the gateway plugs into.
      if (uplink[i] != null || i === core) toGateway[i] = true;
    });
    parentPort.forEach((p, i) => { if (parent[i] != null && p != null) facing[parent[i]].add(p); });

    // Where everything else is plugged in.
    const placements = new Map(), bestLoad = new Map();
    tables.forEach((t, i) => {
      for (const [m, p] of t) {
        if (whose.has(m) || m === gw) continue;
        // Infrastructure (UniFi gear) may sit on a port that faces more network; ordinary devices may not.
        if (facing[i].has(p) && !(infrastructure.has(m) && p !== uplink[i])) continue;
        const ld = load[i].get(p) || 0;
        if (!bestLoad.has(m) || ld < bestLoad.get(m)) { bestLoad.set(m, ld); placements.set(m, { switchMAC: ids[i], port: p }); }
      }
    });

    // The switches as map devices.
    const devices = sw.map((s, i) => {
      let own = uplink[i];
      if (own == null) for (const [p, l] of links[i]) if (l.other === parent[i]) { own = p; break; }
      const d = { mac: ids[i], name: s.name || s.ip, model: shortModel(s.descr), ip: s.ip, firmware: "", type: "usw", online: true,
        uplinkMAC: "", uplinkRemotePort: null, uplinkOwnPort: own ?? null, uplinkMbps: null, uplinkToNonUniFi: false,
        wireless: false, signal: null, channels: "", ports: [] };
      const speed = (sx, p) => p == null ? 0 : sx.ports.get(p)?.mbps || 0;
      if (parent[i] != null) {
        d.uplinkMAC = ids[parent[i]]; d.uplinkRemotePort = parentPort[i];
        const speeds = [speed(s, own), speed(sw[parent[i]], parentPort[i])].filter(x => x > 0);
        d.uplinkMbps = speeds.length ? Math.min(...speeds) : null;
      } else if (toGateway[i] || uplink[i] != null) {
        if (gw) d.uplinkMAC = gw; else d.uplinkToNonUniFi = true;
        d.uplinkMbps = speed(s, own) || null;
      }
      d.ports = [...s.ports].map(([bp, p]) => ({ idx: bp, name: p.name || "", up: !!p.up, mbps: p.up ? p.mbps || 0 : 0, poeWatts: null, uplink: bp === own, connected: "" }))
        .sort((a, b) => a.idx - b.idx);
      return d;
    });
    return { devices, placements };
  }

  /// Mixes SNMP switches into a UniFi controller's devices and clients (either list may be empty). UniFi's own answers
  /// win; SNMP adds the non-UniFi switches, where UniFi gear plugs into them, and the devices UniFi doesn't know.
  function merge(unifiDevices, unifiClients, snmp, scan) {
    const mac = NetMapBuilder.mac;
    const uni = new Set(unifiDevices.map(d => mac(d.mac)));
    const devices = unifiDevices.map(d => {
      // A UniFi device with nothing UniFi above it: an SNMP switch may know where it's plugged in.
      const p = !d.uplinkMAC ? snmp.placements.get(mac(d.mac)) : null;
      return p ? { ...d, uplinkMAC: p.switchMAC, uplinkRemotePort: p.port, uplinkToNonUniFi: false } : d;
    });
    devices.push(...snmp.devices.filter(d => !uni.has(mac(d.mac))));
    const deviceMACs = new Set(devices.map(d => mac(d.mac)));
    const known = new Set(unifiClients.map(c => mac(c.mac)));
    const scanByMAC = new Map();
    for (const d of scan || []) if (d.mac && !scanByMAC.has(mac(d.mac))) scanByMAC.set(mac(d.mac), d);
    const clients = [...unifiClients];
    for (const [m, p] of [...snmp.placements].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (known.has(m) || deviceMACs.has(m)) continue;
      const s = scanByMAC.get(m);
      clients.push({ mac: m, ip: s?.ip || "", name: s?.name || "", parentMAC: p.switchMAC, wired: true, port: p.port, signal: null, ssid: "" });
    }
    return { devices, clients };
  }

  /// "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2…" → "Cisco IOS Software"
  function shortModel(descr) {
    const t = (String(descr || "").split(/[\r\n,]/)[0] || "").trim();
    return t.length > 40 ? t.slice(0, 40) + "…" : t || "Managed switch";
  }

  return { layout, merge, shortModel };
})();

/// Where each device plugs into the UniFi network, by MAC (as NetMapBuilder.mac writes it): a switch and port with its
/// speed, or an access point for Wi-Fi. Clients behind a guessed unmanaged switch are on the real switch's port it hangs
/// off; UniFi switches and access points get their uplink. Same as the Mac's NetMap.switchLinks().
function mapSwitchLinks(map) {
  const out = new Map();
  if (!map) return out;
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const label = n => n.name || n.model;
  for (const n of map.nodes) {
    const owner = n.kind === "guess" ? byId.get(n.parent) : n;
    if (!owner) continue;
    for (const c of n.clients) {
      if (!c.mac) continue;
      const port = n.kind === "guess" ? n.parentPort : c.port;
      out.set(NetMapBuilder.mac(c.mac), { device: label(owner), port: c.wired ? port ?? null : null,
        mbps: c.wired ? owner.ports.find(p => p.idx === port)?.mbps ?? null : null,
        wireless: !c.wired, ssid: c.ssid || "", signal: c.signal ?? null, viaUnmanaged: n.kind === "guess" });
    }
    const parent = byId.get(n.parent);
    if (n.kind !== "guess" && n.mac && parent && parent.kind !== "guess") {
      out.set(NetMapBuilder.mac(n.mac), { device: label(parent), port: n.wireless ? null : n.parentPort ?? null, mbps: n.linkMbps ?? null,
        wireless: n.wireless, ssid: "", signal: n.signal ?? null, viaUnmanaged: false });
    }
  }
  return out;
}
/// "Office USW · P5", "Lobby AP · Wi-Fi"
const switchLinkShort = l => l.wireless ? `${l.device} · Wi-Fi` : l.port != null ? `${l.device} · P${l.port}` : l.device;
/// Sorts by switch, then port number.
const switchLinkSort = l => l ? `${l.device.toLowerCase()} ${String(l.port ?? 99999).padStart(5, "0")}` : "\uffff";
/// The tooltip: "Office USW, port 5, 1G (from the UniFi map)" or "Lobby AP (Wi-Fi, Home-5G, -58 dBm)".
function switchLinkHelp(l) {
  if (l.wireless) { const x = [l.ssid, l.signal != null ? `${l.signal} dBm` : ""].filter(Boolean); return `${l.device} (Wi-Fi${x.length ? ", " + x.join(", ") : ""})`; }
  let s = l.device;
  if (l.port != null) s += `, port ${l.port}`;
  if (l.mbps > 0) s += `, ${mapSpeed(l.mbps)}`;
  if (l.viaUnmanaged) s += ", behind an unmanaged switch";
  return s + " (from the UniFi map)";
}
/// Link speed colours, shared by the map and the table: 10G blue, 2.5G/5G light blue, 1G green, 100M or less orange.
function speedColor(mbps, pal) {
  if (mbps >= 10000) return pal.blue;
  if (mbps >= 2500) return pal.cyan;
  if (mbps >= 1000) return pal.green;
  if (mbps >= 1 && mbps <= 100) return pal.orange;
  return pal.line;
}
/// A line's colour: by its speed; Wi-Fi and unknown speeds grey.
const linkColor = (n, pal) => !n.wireless && n.linkMbps > 0 ? speedColor(n.linkMbps, pal) : pal.line;

const slowLink = n => !n.wireless && n.linkMbps > 0 && n.linkMbps <= 100 && (n.kind === "switch" || n.kind === "ap");
const mapSpeed = mbps => mbps >= 1000 ? (mbps % 1000 === 0 ? `${mbps / 1000}G` : `${(mbps / 1000).toFixed(1)}G`) : `${mbps}M`;
function displayName(c) {
  if (c.isThisPc) return "This PC" + (c.name ? ` (${c.name})` : "");
  return c.name || c.vendor || c.ip || c.mac;
}
/// "P1 ⇄ P8 · 1G", "Mesh · −61 dBm"
function linkLabel(n) {
  if (n.wireless) return "Mesh" + (n.signal != null ? ` · ${n.signal} dBm` : "");
  const parts = [];
  const p = n.parentPort, u = n.uplinkPort;
  if (p != null && u != null) parts.push(`P${p} ⇄ P${u}`); else if (p != null) parts.push(`P${p}`); else if (u != null) parts.push(`⇄ P${u}`);
  if (n.linkMbps > 0) parts.push(mapSpeed(n.linkMbps));
  return parts.join(" · ") + (slowLink(n) ? " ⚠" : "");
}
function clientSummary(n) {
  const w = n.clients.filter(c => c.wired).length, f = n.clients.length - w;
  return [w ? `${w} wired` : "", f ? `${f} Wi-Fi` : ""].filter(Boolean).join(" · ");
}

// MARK: Reading the controller's JSON (every field optional: versions differ)

const UniFiJSON = (() => {
  const str = (d, k) => (d?.[k] == null ? "" : typeof d[k] === "string" ? d[k] : typeof d[k] === "number" || typeof d[k] === "boolean" ? String(d[k]) : "");
  const int = (d, k) => { const v = d?.[k]; if (typeof v === "number") return Math.trunc(v); if (typeof v === "string" && v.trim() && !isNaN(+v)) return Math.trunc(+v); return null; };
  const num = (d, k) => { const v = d?.[k]; if (typeof v === "number") return v; if (typeof v === "string" && v.trim() && !isNaN(+v)) return +v; return null; };
  const bool = (d, k) => { const v = d?.[k]; if (typeof v === "boolean") return v; if (typeof v === "number") return v !== 0; return null; };
  const dicts = (d, k) => (Array.isArray(d?.[k]) ? d[k].filter(x => x && typeof x === "object") : []);
  /// The `data` array of a reply, or a bare array.
  function dataArray(text) {
    try { const o = JSON.parse(text); if (Array.isArray(o)) return o; if (o && Array.isArray(o.data)) return o.data; } catch {}
    return null;
  }
  const MODEL_NAMES = {
    USMINI: "USW Flex Mini", USF5P: "USW Flex", USL8LP: "USW Lite 8 PoE", USL16LP: "USW Lite 16 PoE",
    USL8A: "USW Aggregation", US8P60: "US 8 60W", US8P150: "US 8 150W", US16P150: "US 16 150W",
    US24P250: "US 24 250W", US24: "US 24", US48: "US 48",
    U7PG2: "AC Pro", U7LT: "AC Lite", U7LR: "AC LR", U7MSH: "AC Mesh", U7NHD: "nanoHD",
    UAL6: "U6 Lite", UAP6MP: "U6 Pro", UDMPRO: "Dream Machine Pro", UDM: "Dream Machine", UDR: "Dream Router",
  };

  // Classic API: /api/s/<site>/stat/device and /stat/sta
  function classicDevice(d) {
    const m = str(d, "mac"); if (!m) return null;
    const code = str(d, "model");
    const r = { mac: m, name: str(d, "name"), model: MODEL_NAMES[code] || code || str(d, "type").toUpperCase(), ip: str(d, "ip"),
      firmware: str(d, "version"), type: str(d, "type"), online: true, uplinkMAC: "", uplinkRemotePort: null, uplinkOwnPort: null,
      uplinkMbps: null, wireless: false, signal: null, ports: [], channels: "" };
    const s = int(d, "state"); if (s != null) r.online = s === 1;
    const up = d.uplink;
    if (up && typeof up === "object") {
      r.uplinkMAC = str(up, "uplink_mac"); r.uplinkRemotePort = int(up, "uplink_remote_port");
      r.uplinkOwnPort = int(up, "port_idx"); r.uplinkMbps = int(up, "speed");
      r.wireless = str(up, "type") === "wireless";
      if (r.wireless) {
        const sig = int(up, "signal"), rssi = int(up, "rssi");
        if (sig != null && sig < 0) r.signal = sig; else if (rssi != null && rssi > 0) r.signal = rssi - 96;
        r.uplinkMbps = null;
      }
    }
    // `last_uplink` is only the last UniFi device it was seen behind, and can be long out of date (a switch that was once
    // cabled through another one). Use it only when there's no current uplink to go by (the device is offline). An online
    // switch whose current uplink has no UniFi device above it is plugged into the firewall or another non-UniFi device;
    // reading last_uplink there made a USW Pro 48 and a Flex Mini each other's uplink. Same as the Mac.
    const liveUplink = !!(up && typeof up === "object" && Object.keys(up).length);
    if (!r.uplinkMAC && liveUplink && r.online) {
      r.uplinkToNonUniFi = true;
    } else if (!r.uplinkMAC && d.last_uplink && typeof d.last_uplink === "object") {
      r.uplinkMAC = str(d.last_uplink, "uplink_mac"); r.uplinkRemotePort = int(d.last_uplink, "uplink_remote_port");
    }
    r.ports = dicts(d, "port_table").map(p => {
      const idx = int(p, "port_idx"); if (idx == null) return null;
      const isUp = bool(p, "up") ?? false;
      const w = num(p, "poe_power");
      return { idx, name: str(p, "name"), up: isUp, mbps: isUp ? int(p, "speed") ?? 0 : 0, poeWatts: w > 0 ? w : null, uplink: bool(p, "is_uplink") ?? false, connected: "" };
    }).filter(Boolean);
    const radios = dicts(d, "radio_table_stats").length ? dicts(d, "radio_table_stats") : dicts(d, "radio_table");
    r.channels = radios.map(rd => {
      const ch = int(rd, "channel"); if (!(ch > 0)) return null;
      const band = str(rd, "radio");
      const name = band === "ng" ? "2.4 GHz" : band === "na" ? "5 GHz" : band === "6e" ? "6 GHz" : band;
      return [band === "6e" ? 0 : band === "na" ? 1 : 2, `${name} ch ${ch}`];
    }).filter(Boolean).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(" · ");
    return r;
  }
  function classicClient(d) {
    const m = str(d, "mac"); if (!m) return null;
    const c = { mac: m, ip: str(d, "ip") || str(d, "last_ip"), name: str(d, "name") || str(d, "hostname"), parentMAC: "", ssid: "",
                wired: bool(d, "is_wired") ?? true, port: null, signal: null };
    if (c.wired) { c.parentMAC = str(d, "sw_mac"); c.port = int(d, "sw_port"); }
    else {
      c.parentMAC = str(d, "ap_mac");
      const sig = int(d, "signal"), rssi = int(d, "rssi");
      if (sig != null && sig < 0) c.signal = sig; else if (rssi != null && rssi > 0) c.signal = rssi - 96;
      c.ssid = str(d, "essid");
    }
    if (!c.parentMAC) c.parentMAC = str(d, "uplink_mac");
    return c;
  }

  // Official ("integration") API: /integration/v1/sites/<id>/devices, /devices/<id>, /clients
  function integrationDevice(item, detail, macByID) {
    const d = detail || item;
    const m = str(d, "macAddress") || str(item, "macAddress"); if (!m) return null;
    const state = str(d, "state");
    const features = (Array.isArray(d.features) ? d.features : Array.isArray(item.features) ? item.features : []);
    const r = { mac: m, name: str(d, "name"), model: str(d, "model"), ip: str(d, "ipAddress"), firmware: str(d, "firmwareVersion"),
      online: !state || state.toUpperCase() === "ONLINE",
      type: features.includes("switching") && !features.includes("accessPoint") ? "switching" : features.includes("accessPoint") ? "accessPoint" : "",
      uplinkMAC: "", uplinkRemotePort: null, uplinkOwnPort: null, uplinkMbps: null, wireless: false, signal: null, ports: [], channels: "" };
    if (d.uplink && typeof d.uplink.deviceId === "string") r.uplinkMAC = macByID[d.uplink.deviceId] || "";
    const ifaces = d.interfaces && typeof d.interfaces === "object" ? d.interfaces : {};
    r.ports = dicts(ifaces, "ports").map(p => {
      const idx = int(p, "idx"); if (idx == null) return null;
      const isUp = str(p, "state").toUpperCase() === "UP";
      return { idx, name: "", up: isUp, mbps: isUp ? int(p, "speedMbps") ?? 0 : 0, poeWatts: null, uplink: false, connected: "" };
    }).filter(Boolean);
    r.channels = dicts(ifaces, "radios").map(rd => {
      const ch = int(rd, "channel"); if (!(ch > 0)) return null;
      const f = num(rd, "frequencyGHz") || 0;
      return [-f, `${f >= 5.9 ? "6 GHz" : f >= 4.9 ? "5 GHz" : "2.4 GHz"} ch ${ch}`];
    }).filter(Boolean).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(" · ");
    return r;
  }
  function integrationClient(d, macByID) {
    const m = str(d, "macAddress"); if (!m) return null;
    return { mac: m, ip: str(d, "ipAddress"), name: str(d, "name"), wired: str(d, "type").toUpperCase() !== "WIRELESS",
             parentMAC: macByID[str(d, "uplinkDeviceId")] || "", port: null, signal: null, ssid: "" };
  }
  return { str, int, dataArray, classicDevice, classicClient, integrationDevice, integrationClient };
})();

// MARK: Talking to the controller (through the Rust side; GET only; the key never comes back to the page)

class UniFiClient {
  /// `auth`: { id } for a saved controller (key from Credential Manager) or { key } while testing.
  /// The certificate remembered for this address is required; the first connection remembers what it shows.
  constructor(address, auth) { this.address = UniFiClient.normalized(address); this.auth = auth; this.log = []; this.fingerprint = UniFiStore.fingerprint(this.address); }
  /// "https://host[:port]": http:// becomes https:// (the key must not travel in the clear); any path is dropped.
  static normalized(a) {
    a = String(a || "").trim();
    if (!a) return a;
    if (/^http:\/\//i.test(a)) a = "https://" + a.slice(7);
    if (!a.includes("://")) a = "https://" + a;
    const hostport = a.slice(a.indexOf("://") + 3).split(/[/?#]/)[0].split("@").pop();
    return hostport ? "https://" + hostport : a;
  }
  async get(path) {
    try {
      const r = await window.__TAURI__.core.invoke("unifi_get", { address: this.address, path, id: this.auth.id || null, key: this.auth.key || null, fingerprint: this.fingerprint || null });
      this.log.push(`GET ${path} → ${r.status}, ${r.body.length} bytes`);
      if (!this.fingerprint && r.fingerprint) {
        this.fingerprint = r.fingerprint;
        this.log.push(`certificate SHA-256 ${r.fingerprint} (first connection: remembered, later connections must show the same one)`);
        await UniFiStore.recordFingerprint(r.fingerprint, this.address);
      }
      return r;
    } catch (e) {
      this.log.push(`GET ${path} → ${e}`);
      throw new Error(String(e));
    }
  }
  /// Finds where the API lives ("/proxy/network" on UniFi OS consoles, nothing on self-hosted) and lists the sites.
  async sites() {
    let last = 0;
    for (const prefix of ["/proxy/network", ""]) {
      const r = await this.get(prefix + "/integration/v1/sites?limit=200");
      last = r.status;
      if (r.status === 401 || r.status === 403) throw new Error("The controller refused the API key. Check it in UniFi Network › Settings › Control Plane › Integrations.");
      const list = r.status === 200 ? UniFiJSON.dataArray(r.body) : null;
      if (!list) continue;
      const sites = list.map(d => ({ id: UniFiJSON.str(d, "id"), ref: UniFiJSON.str(d, "internalReference") || "default", name: UniFiJSON.str(d, "name") }));
      this.log.push(`API at ${prefix || "/"}, ${sites.length} site(s)`);
      return { prefix, sites };
    }
    throw new Error(`That address didn't answer like a UniFi controller (${last ? "HTTP " + last : "no answer"}).`);
  }
  /// Everything the map needs from one site (`siteRef` = the short name, e.g. "default"; blank = the first site).
  async fetch(siteRef) {
    const { prefix, sites } = await this.sites();
    const site = sites.find(s => s.ref === siteRef || s.id === siteRef) || sites[0];
    if (!site) throw new Error("That address didn't answer like a UniFi controller (no sites).");
    let official = [];
    const macByID = {};
    if (site.id) {
      official = await this.pages(`${prefix}/integration/v1/sites/${site.id}/devices`);
      for (const d of official) macByID[UniFiJSON.str(d, "id")] = UniFiJSON.str(d, "macAddress");
      this.log.push(`official API: ${official.length} devices`);
    }
    const modelByMAC = new Map(official.map(d => [NetMapBuilder.mac(UniFiJSON.str(d, "macAddress")), UniFiJSON.str(d, "model")]));
    // Classic API: it has switch ports and Wi-Fi signal.
    const dr = await this.get(`${prefix}/api/s/${site.ref}/stat/device`);
    const cr = await this.get(`${prefix}/api/s/${site.ref}/stat/sta`);
    const devs = dr.status === 200 ? UniFiJSON.dataArray(dr.body) : null, stas = cr.status === 200 ? UniFiJSON.dataArray(cr.body) : null;
    if (devs && stas) {
      this.log.push(`classic API: ${devs.length} devices, ${stas.length} clients; device fields: ${fieldNames(devs)}`);
      this.log.push(`client fields: ${fieldNames(stas)}`);
      const devices = devs.map(UniFiJSON.classicDevice).filter(Boolean);
      for (const d of devices) { const m = modelByMAC.get(NetMapBuilder.mac(d.mac)); if (m) d.model = m; }
      return { devices, clients: stas.map(UniFiJSON.classicClient).filter(Boolean), api: "classic API", siteName: site.name };
    }
    if (!official.length && !site.id) throw new Error("That address didn't answer like a UniFi controller (no device list).");
    // Official API only: one more call per device for its ports and uplink.
    const devices = [];
    for (const item of official) {
      const id = UniFiJSON.str(item, "id");
      let detail = null;
      if (id) { const r = await this.get(`${prefix}/integration/v1/sites/${site.id}/devices/${id}`); if (r.status === 200) { try { detail = JSON.parse(r.body); } catch {} } }
      const d = UniFiJSON.integrationDevice(item, detail, macByID); if (d) devices.push(d);
    }
    const clients = await this.pages(`${prefix}/integration/v1/sites/${site.id}/clients`);
    this.log.push(`official API: ${clients.length} clients; client fields: ${fieldNames(clients)}`);
    return { devices, clients: clients.map(c => UniFiJSON.integrationClient(c, macByID)).filter(Boolean), api: "official API", siteName: site.name };
  }
  /// The official API pages its lists (up to 200 at a time).
  async pages(path) {
    const out = [];
    let offset = 0;
    while (offset < 5000) {
      const r = await this.get(`${path}?offset=${offset}&limit=200`);
      if (r.status === 401 || r.status === 403) throw new Error("The controller refused the API key. Check it in UniFi Network › Settings › Control Plane › Integrations.");
      const list = r.status === 200 ? UniFiJSON.dataArray(r.body) : null;
      if (!list) break;
      out.push(...list);
      let total = out.length; try { total = UniFiJSON.int(JSON.parse(r.body), "totalCount") ?? out.length; } catch {}
      if (!list.length || out.length >= total) break;
      offset += list.length;
    }
    return out;
  }
}
/// The field names in a list (never the values), for Connection Details.
const fieldNames = list => [...new Set(list.slice(0, 20).flatMap(d => Object.keys(d || {})))].sort().slice(0, 60).join(", ");

// MARK: Saved controllers (unifi.json next to data.json; the key is in Windows Credential Manager)

const UniFiStore = {
  list: [],
  async load() {
    try { const t = await window.__TAURI__.core.invoke("load_file", { name: "unifi" }); this.list = t ? JSON.parse(t) : []; } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
  },
  async save() { await window.__TAURI__.core.invoke("save_file", { name: "unifi", json: JSON.stringify(this.list, null, 2) }); },
  host(c) { try { return new URL(UniFiClient.normalized(c.address)).hostname; } catch { return ""; } },
  forOrg(orgId) { return orgId ? this.list.find(c => c.orgID === orgId) || null : null; },
  /// The controller for a scan: its organization's, else one whose address is inside the scanned range.
  forScan(orgId, inRange) { return this.forOrg(orgId) || this.list.find(c => (!c.orgID || c.orgID === orgId) && inRange(this.host(c))) || null; },
  /// Certificates seen for controllers that aren't saved yet (Test before Save), by address.
  pending: {},
  /// The certificate fingerprint remembered for a controller address, if any.
  fingerprint(address) {
    const a = UniFiClient.normalized(address);
    return this.list.find(c => UniFiClient.normalized(c.address) === a && c.certFingerprint)?.certFingerprint || this.pending[a] || null;
  },
  /// Remembers the certificate a controller showed on its first connection.
  async recordFingerprint(fp, address) {
    const a = UniFiClient.normalized(address);
    this.pending[a] = fp;
    let changed = false;
    for (const c of this.list) if (UniFiClient.normalized(c.address) === a && !c.certFingerprint) { c.certFingerprint = fp; changed = true; }
    if (changed) await this.save().catch(() => {});
  },
  /// Forgets a controller's certificate (after replacing the controller or its certificate): the next connection
  /// accepts and remembers whatever it shows.
  async forgetCertificate(id) {
    const c = this.list.find(x => x.id === id);
    if (!c) return;
    delete this.pending[UniFiClient.normalized(c.address)];
    c.certFingerprint = null;
    await this.save();
  },
  async upsert(c, key) {
    if (key) await window.__TAURI__.core.invoke("unifi_key_save", { id: c.id, key });
    c = { ...c, address: UniFiClient.normalized(c.address) };
    const old = this.list.find(x => x.id === c.id);
    if (old && UniFiClient.normalized(old.address) !== c.address) c.certFingerprint = null;   // a new address is a new certificate
    if (!c.certFingerprint) c.certFingerprint = this.pending[c.address] || null;
    const i = this.list.findIndex(x => x.id === c.id);
    if (i >= 0) this.list[i] = c; else this.list.push(c);
    await this.save();
  },
  async remove(id) {
    this.list = this.list.filter(c => c.id !== id);
    await this.save();
    await window.__TAURI__.core.invoke("unifi_key_delete", { id }).catch(() => {});
  },
  hasKey(c) { return window.__TAURI__.core.invoke("unifi_key_has", { id: c.id }).catch(() => false); },
};

// MARK: Layout (a top-down tree; more than 6 leaf children wrap into rows under a bus line)

const MAP_STYLES = {
  full: { nodeW: 210, nodeH: 62, hGap: 26, vGap: 78, chipH: 24, compact: false },
  compact: { nodeW: 104, nodeH: 36, hGap: 8, vGap: 44, chipH: 16, compact: true },
};
const MAX_PER_ROW = 6;

function mapLayout(map, showClients, style) {
  const { nodeW, nodeH, hGap } = style;
  const levelH = nodeH + style.vGap + (showClients ? style.chipH + 10 : 0);
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const kidsOf = new Map();
  const kids = id => {
    if (!kidsOf.has(id)) kidsOf.set(id, map.nodes.filter(n => n.parent === id)
      .sort((a, b) => ((a.parentPort ?? 999) - (b.parentPort ?? 999)) || a.name.localeCompare(b.name)));
    return kidsOf.get(id);
  };
  const wraps = id => { const k = kids(id); return k.length > MAX_PER_ROW && k.every(c => !kids(c.id).length); };
  const widths = new Map(), visiting = new Set();
  function width(id) {
    if (widths.has(id)) return widths.get(id);
    if (visiting.has(id)) return nodeW;
    visiting.add(id);
    const k = kids(id);
    const sum = wraps(id) ? MAX_PER_ROW * nodeW + (MAX_PER_ROW - 1) * hGap : k.reduce((t, c) => t + width(c.id), 0) + Math.max(0, k.length - 1) * hGap;
    const w = Math.max(nodeW, sum);
    widths.set(id, w);
    return w;
  }
  const centers = new Map(), wrapped = new Set();
  let maxDepth = 0;
  const put = (id, x, depth) => { centers.set(id, { x, y: 24 + nodeH / 2 + depth * levelH }); maxDepth = Math.max(maxDepth, depth); };
  function place(id, left, depth) {
    if (centers.has(id)) return;
    const w = width(id);
    put(id, left + w / 2, depth);
    const k = kids(id);
    if (wraps(id)) {
      wrapped.add(id);
      k.forEach((c, i) => {
        const row = Math.floor(i / MAX_PER_ROW), col = i % MAX_PER_ROW;
        const inRow = Math.min(MAX_PER_ROW, k.length - row * MAX_PER_ROW);
        const rowW = inRow * nodeW + (inRow - 1) * hGap;
        put(c.id, left + (w - rowW) / 2 + col * (nodeW + hGap) + nodeW / 2, depth + 1 + row);
      });
      return;
    }
    const sum = k.reduce((t, c) => t + width(c.id), 0) + Math.max(0, k.length - 1) * hGap;
    let x = left + (w - sum) / 2;
    for (const c of k) { place(c.id, x, depth + 1); x += width(c.id) + hGap; }
  }
  let left = 24;
  for (const t of map.nodes.filter(n => n.parent == null || !byId.has(n.parent))) { place(t.id, left, 0); left += width(t.id) + hGap; }
  for (const n of map.nodes) if (!centers.has(n.id)) { place(n.id, left, 0); left += width(n.id) + hGap; }
  return { style, centers, wrapped, showClients, width: Math.max(left + 24 - hGap, 300), height: 24 + (maxDepth + 1) * levelH + 24 };
}

// MARK: Drawing (SVG, so zoom stays sharp and Export can use the same drawing)

const MAP_FONT = '"Segoe UI", system-ui, sans-serif', MAP_MONO = 'Consolas, "Cascadia Mono", ui-monospace, monospace';
/// On screen the colours follow the theme; exports use a fixed light palette.
const SCREEN_PALETTE = { bg: "var(--bg)", box: "var(--panel)", text: "var(--text)", muted: "var(--muted)", line: "var(--muted)", edge: "var(--edge)",
  accent: "var(--green)", selectBg: "var(--select)", purple: "var(--map-purple)", orange: "var(--map-orange)", green: "var(--online)", red: "var(--red)", chipBg: "var(--map-chip)",
  blue: "var(--map-blue)", cyan: "var(--map-cyan)" };
const EXPORT_PALETTE = { bg: "#ffffff", box: "#f6f8fb", text: "#13202e", muted: "#5b6b7e", line: "#7b8a9c", edge: "#b9c7d6",
  accent: "#1f7a4d", selectBg: "#f6f8fb", purple: "#7c3aed", orange: "#d97706", green: "#1f9d58", red: "#d03030", chipBg: "#e3efe8", blue: "#2563eb", cyan: "#0891b2" };

let measureCtx = null;
function fitText(text, px, weight, family, maxW) {
  text = String(text || "");
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} ${px}px ${family}`;
  if (measureCtx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measureCtx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + "…";
}
const xml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const MAP_ICONS = {
  gateway: '<path d="M11 2 4 5v5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V5z"/><path d="M8 11h6M11 8v6"/>',
  switch: '<rect x="2" y="6" width="18" height="9" rx="1.5"/><path d="M5 10.5h1.5M9 10.5h1.5M13 10.5h1.5M11 15v4"/>',
  ap: '<path d="M3 9a11 11 0 0 1 16 0M6 12a6.5 6.5 0 0 1 10 0"/><circle cx="11" cy="15.5" r="1.3"/>',
  camera: '<rect x="2.5" y="6" width="12" height="10" rx="1.5"/><path d="m14.5 9.5 5-2.5v8l-5-2.5"/>',
  device: '<path d="M11 2.5 3.5 6.5v9L11 19.5l7.5-4v-9z"/><path d="M3.5 6.5 11 10.5l7.5-4M11 10.5v9"/>',
  guess: '<rect x="3" y="3" width="16" height="16" rx="2" stroke-dasharray="3 2.5"/><path d="M8.8 8.6a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.6M11 15.6v.1"/>',
  other: '<circle cx="11" cy="11" r="8.5"/><path d="M8.8 8.6a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.6M11 15.6v.1"/>',
};
const iconFor = n => (n.kind === "device" && /uvc|camera/i.test(n.model) ? "camera" : MAP_ICONS[n.kind] ? n.kind : "device");

/// The whole map as SVG text. Drawn at 1:1; zoom is the SVG's width and height.
function mapSVG(map, layout, { pal, selected, zoom = 1, pad = 8 }) {
  const st = layout.style, half = st.nodeH / 2, c = st.compact;
  const W = layout.width + pad * 2, H = layout.height + pad * 2;
  const P = (x, y) => `${(x + pad).toFixed(1)},${(y + pad).toFixed(1)}`;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * zoom}" height="${H * zoom}" viewBox="0 0 ${W} ${H}" font-family='${MAP_FONT}'>`);
  if (pal === EXPORT_PALETTE) out.push(`<rect width="${W}" height="${H}" fill="${pal.bg}"/>`);
  const stroke = (col, w, dashed) => `fill="none" style="stroke:${col}" stroke-width="${w}"${dashed ? ' stroke-dasharray="6 5"' : ""} stroke-linecap="round"`;
  // Links: a grid of children gets a trunk on the left and a bus above each row; others one curve each.
  for (const p of layout.wrapped) {
    const a = layout.centers.get(p); if (!a) continue;
    const kids = map.nodes.filter(n => n.parent === p);
    const pts = kids.map(k => layout.centers.get(k.id)).filter(Boolean);
    if (!pts.length) continue;
    const rows = [...new Set(pts.map(q => q.y))].sort((x, y) => x - y);
    const busYs = rows.map(y => y - half - (c ? 16 : 22));
    const trunkX = Math.min(...pts.map(q => q.x)) - (st.nodeW / 2 + st.hGap / 2);
    const dashed = !map.cabled;
    let d = `M${P(a.x, a.y + half)} L${P(a.x, busYs[0])} M${P(trunkX, busYs[0])} L${P(trunkX, busYs[busYs.length - 1])}`;
    rows.forEach((row, i) => {
      const xs = pts.filter(q => q.y === row).map(q => q.x);
      d += ` M${P(trunkX, busYs[i])} L${P(Math.max(...xs, a.x), busYs[i])}`;
    });
    out.push(`<path d="${d}" ${stroke(pal.line, 2, dashed)} opacity="0.75"/>`);
    // Each box's own drop from the bus is coloured by its link speed.
    for (const k of kids) {
      const b = layout.centers.get(k.id); if (!b) continue;
      const i = rows.indexOf(b.y); if (i < 0) continue;
      out.push(`<path d="M${P(b.x, busYs[i])} L${P(b.x, b.y - half)}" ${stroke(linkColor(k, pal), 2, dashed || k.wireless)}/>`);
    }
  }
  for (const n of map.nodes) {
    if (n.parent == null || layout.wrapped.has(n.parent)) continue;
    const a = layout.centers.get(n.parent), b = layout.centers.get(n.id); if (!a || !b) continue;
    const s = { x: a.x, y: a.y + half }, e = { x: b.x, y: b.y - half }, mid = (s.y + e.y) / 2;
    const col = linkColor(n, pal);
    out.push(`<path d="M${P(s.x, s.y)} C${P(s.x, mid)} ${P(e.x, mid)} ${P(e.x, e.y)}" ${stroke(col, 2, n.wireless || !map.cabled)}${col === pal.line ? ' opacity="0.75"' : ""}/>`);
  }
  if (layout.showClients) for (const n of map.nodes) {
    if (!n.clients.length) continue;
    const q = layout.centers.get(n.id); if (!q) continue;
    out.push(`<path d="M${P(q.x, q.y + half)} L${P(q.x, q.y + half + 10)}" ${stroke(pal.line, 1.5)} opacity="0.5"/>`);
  }
  // Port labels just above each box.
  const lf = c ? 8.5 : 10.5;
  for (const n of map.nodes) {
    const t = n.parent != null ? linkLabel(n) : ""; if (!t) continue;
    const q = layout.centers.get(n.id); if (!q) continue;
    const slow = slowLink(n);
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = `${slow ? 600 : 400} ${lf}px ${MAP_MONO}`;
    const w = measureCtx.measureText(t).width + 8, y = q.y - half - 14;
    out.push(`<rect x="${(q.x - w / 2 + pad).toFixed(1)}" y="${(y - lf * 0.75 + pad).toFixed(1)}" width="${w.toFixed(1)}" height="${(lf * 1.5).toFixed(1)}" rx="${(lf * 0.75).toFixed(1)}" style="fill:${pal.bg}" opacity="0.85"/>`);
    out.push(`<text x="${(q.x + pad).toFixed(1)}" y="${(y + pad).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family='${MAP_MONO}' font-size="${lf}" font-weight="${slow ? 600 : 400}" style="fill:${slow ? pal.orange : pal.muted}">${xml(t)}</text>`);
  }
  // Boxes.
  for (const n of map.nodes) {
    const q = layout.centers.get(n.id); if (!q) continue;
    const x = q.x - st.nodeW / 2 + pad, y = q.y - half + pad, sel = n.id === selected;
    const border = sel ? pal.accent : n.kind === "ap" ? pal.purple : pal.edge;
    const bw = sel ? 2.2 : n.kind === "ap" ? 1.8 : 1.2;
    out.push(`<g data-node="${xml(n.id)}" style="cursor:pointer"><title>${xml(n.name ? `${n.name} · ${n.model}` : n.model)}</title>`);
    out.push(`<rect x="${x}" y="${y}" width="${st.nodeW}" height="${st.nodeH}" rx="${c ? 7 : 9}" style="fill:${sel ? pal.selectBg : pal.box};stroke:${border}" stroke-width="${bw}"${n.guessed ? ' stroke-dasharray="5 4"' : ""}/>`);
    let tx = x + (c ? 5 : 10);
    if (!c) {
      const ic = n.kind === "ap" ? pal.purple : n.guessed ? pal.muted : pal.accent;
      out.push(`<g transform="translate(${tx},${y + 8})" fill="none" style="stroke:${ic}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${MAP_ICONS[iconFor(n)]}</g>`);
      tx += 30;
    }
    const maxW = x + st.nodeW - (c ? 5 : 9) - tx;
    const f1 = c ? 10 : 13, f2 = c ? 8.5 : 11, f3 = c ? 9 : 10.5;
    let ty = y + (c ? 3 : 8) + f1 * 0.85, nx = tx;
    if (!n.guessed) {
      const r = c ? 2.5 : 3.5, dot = !n.online ? pal.red : slowLink(n) ? pal.orange : pal.green;
      out.push(`<circle cx="${tx + r}" cy="${ty - f1 * 0.33}" r="${r}" style="fill:${dot}"/>`);
      nx += r * 2 + (c ? 3 : 5);
    }
    out.push(`<text x="${nx}" y="${ty}" font-size="${f1}" font-weight="600" style="fill:${pal.text}">${xml(fitText(n.name || n.model, f1, 600, MAP_FONT, maxW - (nx - tx)))}</text>`);
    // Compact keeps the name and the IP address only.
    if (!c || !n.ip) { ty += f2 + (c ? 3 : 5); out.push(`<text x="${tx}" y="${ty}" font-size="${f2}" style="fill:${pal.muted}">${xml(fitText(n.model, f2, 400, MAP_FONT, maxW))}</text>`); }
    if (n.ip) { ty += f3 + (c ? 3 : 4); out.push(`<text x="${tx}" y="${ty}" font-family='${MAP_MONO}' font-size="${f3}" style="fill:${pal.muted}">${xml(fitText(n.ip, f3, 400, MAP_MONO, maxW))}</text>`); }
    out.push(`</g>`);
    if (layout.showClients && n.clients.length) {
      const t = clientSummary(n), cf = c ? 9 : 11;
      measureCtx.font = `600 ${cf}px ${MAP_FONT}`;
      const w = measureCtx.measureText(t).width + (c ? 10 : 20), h = cf + (c ? 2 : 6), cy = q.y + half + 10 + st.chipH / 2;
      out.push(`<g data-node="${xml(n.id)}" data-clients="${xml(n.id)}" style="cursor:pointer"><title>Show the clients and the port each is on</title><rect x="${(q.x - w / 2 + pad).toFixed(1)}" y="${(cy - h / 2 + pad).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" style="fill:${pal.chipBg}"/>`
        + `<text x="${(q.x + pad).toFixed(1)}" y="${(cy + pad).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${cf}" font-weight="600" style="fill:${pal.accent}">${xml(t)}</text></g>`);
    }
  }
  out.push("</svg>");
  return out.join("");
}

/// Switch Ports as Excel: one row per port of every switch (and gateway with ports).
function mapPortsTable(map) {
  const rows = [];
  for (const n of map.nodes) for (const p of n.ports) rows.push([n.name, String(p.idx), p.up ? "Up" : "Down", p.mbps > 0 ? mapSpeed(p.mbps) : "", p.poeWatts != null ? `${p.poeWatts.toFixed(1)} W` : "", p.connected || ""]);
  return { header: ["Switch", "Port", "Status", "Speed", "PoE", "Connected"], rows };
}

/// A one-page PDF holding a JPEG (the map, as Export › Map as PDF).
function jpegToPDF(jpeg, w, h) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const add = x => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; add(`${n} 0 obj\n`); for (const b of [].concat(body)) add(b); add("\nendobj\n"); };
  // Page size in points: the picture at 72 dpi, halved because it was drawn at 2x.
  const pw = (w / 2).toFixed(2), ph = (h / 2).toFixed(2);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => String(offsets[n]).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

if (typeof module !== "undefined") module.exports = { NetMapBuilder, UniFiJSON, mapLayout, MAP_STYLES, linkLabel, slowLink, mapPortsTable, jpegToPDF };
