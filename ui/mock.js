// Demo mode: only when the page is opened in a plain browser (no Tauri), for checking the look.
// Stands in for the Rust side with made-up devices. Does nothing inside the real app.
"use strict";
if (!window.__TAURI__) {
  const listeners = {};
  const emitTo = (name, payload) => (listeners[name] || []).forEach(f => f({ payload }));
  const emit = payload => emitTo("scan", payload);
  const ip = n => `10.20.30.${n}`;
  const demo = [
    { n: 1, mac: "00:1A:2B:00:00:01", vendor: "Example Networks", ports: [53, 80, 443], ms: 1.2, names: { DNS: "gateway" } },
    { n: 10, mac: "00:1A:2B:00:00:0A", vendor: "Sample Storage Inc.", ports: [22, 80, 445], ms: 0.8, names: { NetBIOS: "NAS-01", Bonjour: "nas-01" } },
    { n: 21, mac: "00:1A:2B:00:00:15", vendor: "Demo Printers Ltd.", ports: [80, 631, 9100], ms: 3.4, names: { Bonjour: "Office-Printer" } },
    { n: 35, mac: "02:11:22:33:44:55", vendor: "Private address", ports: [], ms: 18, names: {} },
    { n: 42, mac: "00:1A:2B:00:00:2A", vendor: "Contoso PCs", ports: [135, 445, 3389].filter(p => p !== 135), ms: null, names: { NetBIOS: "FRONT-DESK" } },
    { n: 57, mac: "00:1A:2B:00:00:39", vendor: "Example Cameras", ports: [80, 554], ms: 2.1, names: {} },
    { n: 88, mac: "00:1A:2B:00:00:58", vendor: "Fabrikam IoT", ports: [], ms: null, names: {} },
  ];
  // A made-up UniFi site for the Map tab: a core switch on the (non-UniFi) router, a Flex Mini, eight access points.
  const um = n => `74:AC:B9:00:00:${String(n).padStart(2, "0")}`;
  const ports = (n, used) => Array.from({ length: n }, (_, i) => ({ port_idx: i + 1, up: used.includes(i + 1), speed: i + 1 === 5 ? 100 : 1000, poe_power: used.includes(i + 1) && i > 1 ? "4.2" : "0", is_uplink: i === 0 }));
  const aps = Array.from({ length: 8 }, (_, i) => ({ mac: um(10 + i), name: `AP ${["Lobby", "Front Desk", "Exam 1", "Exam 2", "Exam 3", "Break Room", "Lab", "Storage"][i]}`, model: i % 2 ? "UAL6" : "U7PG2", ip: `10.20.30.${70 + i}`, type: "uap", state: 1, version: "6.6.77",
    uplink: { uplink_mac: um(2), uplink_remote_port: 3 + i, port_idx: 1, speed: i === 2 ? 100 : 1000, type: "wire" }, radio_table_stats: [{ radio: "na", channel: 36 + i * 4 }, { radio: "ng", channel: [1, 6, 11][i % 3] }] }));
  const uniDevices = [
    { mac: um(2), name: "Core Switch", model: "US24P250", ip: "10.20.30.2", type: "usw", state: 1, version: "7.1.26", uplink: { uplink_mac: "00:1A:2B:00:00:01", uplink_remote_port: 2, port_idx: 1, speed: 1000, type: "wire" }, port_table: ports(24, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]) },
    { mac: um(3), name: "Back Office Mini", model: "USMINI", ip: "10.20.30.3", type: "usw", state: 1, version: "2.1.6", uplink: { uplink_mac: um(2), uplink_remote_port: 12, port_idx: 1, speed: 1000, type: "wire" }, port_table: ports(5, [1, 2, 3]) },
    ...aps,
  ];
  const uniClients = [
    { mac: "00:1A:2B:00:00:0A", ip: "10.20.30.10", hostname: "nas-01", is_wired: true, sw_mac: um(2), sw_port: 13 },
    { mac: "00:1A:2B:00:00:15", ip: "10.20.30.21", is_wired: true, sw_mac: um(3), sw_port: 2 },
    { mac: "00:1A:2B:00:00:2A", ip: "10.20.30.42", is_wired: true, sw_mac: um(2), sw_port: 14 },
    { mac: "00:1A:2B:00:00:2B", ip: "10.20.30.43", hostname: "vm-host-guest", is_wired: true, sw_mac: um(2), sw_port: 14 },
    { mac: "00:1A:2B:00:00:39", ip: "10.20.30.57", is_wired: true, sw_mac: um(3), sw_port: 3 },
    { mac: "00:1A:2B:00:00:05", ip: "10.20.30.5", hostname: "DEMO-PC", is_wired: false, ap_mac: um(11), signal: -58, essid: "Example-Office" },
    { mac: "02:11:22:33:44:55", ip: "10.20.30.35", is_wired: false, ap_mac: um(10), signal: -79, essid: "Example-Guest" },
  ];
  const unifiReply = path => {
    const ok = o => ({ status: 200, body: JSON.stringify(o) });
    if (path.startsWith("/proxy/network/integration/v1/sites?")) return ok({ data: [{ id: "site-1", internalReference: "default", name: "Default" }] });
    if (path.startsWith("/proxy/network/integration/v1/sites/site-1/devices")) return ok({ data: uniDevices.map((d, i) => ({ id: "dev" + i, macAddress: d.mac.toLowerCase(), model: d.model === "US24P250" ? "USW 24 PoE" : d.model === "USMINI" ? "USW Flex Mini" : d.model === "UAL6" ? "U6 Lite" : "AC Pro" })), totalCount: uniDevices.length });
    if (path === "/proxy/network/api/s/default/stat/device") return ok({ meta: { rc: "ok" }, data: uniDevices });
    if (path === "/proxy/network/api/s/default/stat/sta") return ok({ meta: { rc: "ok" }, data: uniClients });
    return { status: 404, body: "" };
  };
  let timers = [];
  const store = {};
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case "app_info": return { version: "demo", os: "browser" };
          case "list_adapters": return [{ id: "wifi|10.20.30.5", displayName: "Wi-Fi · 10.20.30.5/24", address: "10.20.30.5", prefix: 24, mac: "00:1A:2B:00:00:05", suggestedRange: "10.20.30.1-254", isDefault: true }];
          case "parse_range": {
            const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)-(\d+)$/.exec(args.text.trim());
            if (!m) throw `“${args.text}” isn’t a valid IP, range or subnet. (Demo mode only understands a.b.c.d-e.)`;
            const base = ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256;
            return [[base + +m[4], base + +m[5]]];
          }
          case "start_scan": {
            const count = 254;
            const step = (t, f) => timers.push(setTimeout(f, t));
            step(100, () => emit({ kind: "found", devices: [{ ip: ip(5), name: "DEMO-PC", mac: "00:1A:2B:00:00:05", thisPc: true }] }));
            step(300, () => emit({ kind: "progress", fraction: 0.05, text: "Pinging 254 addresses…" }));
            step(900, () => {
              const pinged = demo.filter(d => d.ms != null);
              emit({ kind: "found", devices: pinged.map(d => ({ ip: ip(d.n), thisPc: false })) });
              emit({ kind: "response", ms: Object.fromEntries(pinged.map(d => [ip(d.n), d.ms])) });
              emit({ kind: "progress", fraction: 0.35, text: "Checking devices that ignore ping…" });
            });
            step(1400, () => { emit({ kind: "found", devices: [{ ip: ip(42), thisPc: false }] }); emit({ kind: "progress", fraction: 0.6, text: "Reading MAC addresses…" }); });
            step(1800, () => {
              emit({ kind: "found", devices: [{ ip: ip(88), thisPc: false }] });
              emit({ kind: "macs", macs: Object.fromEntries(demo.map(d => [ip(d.n), { mac: d.mac, vendor: d.vendor }])) });
              emit({ kind: "progress", fraction: 0.72, text: "Checking open ports on 8 devices…" });
            });
            step(2300, () => { emit({ kind: "ports", ports: Object.fromEntries(demo.filter(d => d.ports.length).map(d => [ip(d.n), d.ports])) }); emit({ kind: "progress", fraction: 0.85, text: "Looking up names…" }); });
            step(2800, () => {
              for (const src of ["NetBIOS", "Bonjour", "DNS"])
                emit({ kind: "names", source: src, names: Object.fromEntries(demo.filter(d => d.names[src]).map(d => [ip(d.n), d.names[src]])) });
            });
            step(3000, () => {
              emit({ kind: "webTitles", titles: { [ip(1)]: "Example Router Login", [ip(10)]: "NAS-01 \u2013 Sign in", [ip(57)]: "Camera Live View" } });
              emit({ kind: "upnp", info: { [ip(21)]: { friendlyName: "Office Printer", model: "Demo Printers LX-200" } } });
              emit({ kind: "snmp", info: { [ip(1)]: { name: "gateway", descr: "Example Networks EX-1000 router, firmware 2.4", location: "Server closet" } } });
              emit({ kind: "ipv6", ipv6: { [ip(10)]: ["2001:db8::10", "fe80::21a:2bff:fe00:a"] } });
            });
            step(3200, () => emit({ kind: "finished", cancelled: false }));
            return count;
          }
          case "stop_scan": timers.forEach(clearTimeout); timers = []; setTimeout(() => emit({ kind: "finished", cancelled: true }), 50); return;
          case "load_data": return store.data ?? (() => { try { return localStorage.getItem("demo-data"); } catch { return null; } })();
          case "save_data": store.data = args.json; try { localStorage.setItem("demo-data", args.json); } catch {} return;
          case "keep_unreadable_data": return "(demo) data.unreadable.json";
          case "export_csv": case "export_xlsx": return `(demo) ${args.fileName}`;
          case "common_ports": return [[22, "SSH"], [80, "HTTP (web)"], [443, "HTTPS (web)"], [445, "SMB (file sharing)"], [631, "IPP printing"], [3389, "RDP (Remote Desktop)"], [9100, "Printer (JetDirect)"]];
          case "device_banners": await new Promise(r => setTimeout(r, 600)); return Object.fromEntries(args.ports.filter(p => [22, 80].includes(p)).map(p => [p, p === 22 ? "OpenSSH 9.6" : "nginx"]));
          case "device_web_title": return null;
          case "update_check": await new Promise(r => setTimeout(r, 500)); return { version: "1.1.0", current: "1.0.2", newer: true, whatsNew: "Quiet scan.", url: "https://github.com/example/setup.exe", sha256: "0".repeat(64) };
          case "update_download": await new Promise(r => setTimeout(r, 800)); return "C:\\Users\\demo\\Downloads\\ARPradar-1.1.0-setup.exe";
          case "update_run_installer": console.log("demo: would start the installer"); return;
          case "list_shares": await new Promise(r => setTimeout(r, 800)); return args.ip.endsWith(".10") ? { smb: [{ name: "Backups", comment: "Nightly" }, { name: "Media", comment: "" }], nfs: [], problem: null } : { smb: [], nfs: [], problem: "Needs a login" };
          case "open_device": console.log("demo open", args); return;
          case "wake_on_lan": return args.macs.length;
          case "reverse_subnet": { await new Promise(r => setTimeout(r, 400)); const base = (args.range.match(/^(\d+\.\d+\.\d+)\./) || [, "10.20.30"])[1];
            return Array.from({ length: 254 }, (_, i) => [`${base}.${i + 1}`, i % 9 === 0 ? `host-${i + 1}.example.test` : ""]); }
          case "port_scan_start": {
            const t = (ms, f) => setTimeout(f, ms);
            const open = [22, 80, 445, 8080];
            open.forEach((p, i) => t(300 * (i + 1), () => emitTo("portscan", { kind: "open", id: args.id, port: p })));
            t(1400, () => emitTo("portscan", { kind: "progress", id: args.id, done: 7, total: 7 }));
            t(1600, () => emitTo("portscan", { kind: "banners", id: args.id, banners: { 22: "OpenSSH 9.6", 80: "nginx", 8080: "Web server" } }));
            t(1700, () => emitTo("portscan", { kind: "finished", id: args.id, cancelled: false }));
            return args.mode === "all" ? 65535 : 7;
          }
          case "port_scan_stop": return;
          case "open_tool": window.open(`tool.html?tool=${args.tool}&arg=${encodeURIComponent(args.arg || "")}`, "_blank", "width=800,height=600"); return;
          case "resolve_names": return args.names.map(n => /^[\d.]+$/.test(n) ? n : n.includes(".") ? "10.20.30.99" : null);
          case "ping_round": return Object.fromEntries(args.ips.map(i => [i, Math.random() < 0.05 ? null : 2 + Math.random() * 20]));
          case "trace_start": {
            const hops = [["10.20.30.1", "gateway"], ["100.64.0.1", ""], ["*", ""], ["203.0.113.9", "edge1.example.net"], ["198.51.100.20", "core1.example.net"], ["93.184.216.34", "example.com"]];
            emitTo("trace", { run: args.run, kind: "resolved", address: "93.184.216.34" });
            hops.forEach(([a, n], i) => setTimeout(() => emitTo("trace", { run: args.run, kind: "hop", hop: { number: i + 1, address: a, name: n, ms: a === "*" ? null : 2 + i * 6 } }), 200 * (i + 1)));
            setTimeout(() => emitTo("trace", { run: args.run, kind: "done", hops: hops.length, cancelled: false }), 1500);
            return;
          }
          case "job_stop": return;
          case "dns_default_server": return "10.20.30.1";
          case "dns_lookup": {
            await new Promise(r => setTimeout(r, 50 + Math.random() * 200));
            const n = args.name, t = args.kind;
            const a = { A: n.startsWith("autodiscover") ? [{ name: n, type: "CNAME", ttl: 300, data: "autodiscover.outlook.example." }, { name: "autodiscover.outlook.example", type: "A", ttl: 60, data: "203.0.113.50" }] : n.split(".").length <= 2 || n.startsWith("www") ? [{ name: n, type: "A", ttl: 300, data: "93.184.216.34" }] : [],
              MX: [{ name: n, type: "MX", ttl: 3600, data: "10 mail.example.com." }], TXT: n.startsWith("_dmarc") ? [{ name: n, type: "TXT", ttl: 3600, data: '"v=DMARC1; p=reject"' }] : n.split(".").length <= 2 ? [{ name: n, type: "TXT", ttl: 3600, data: '"v=spf1 -all"' }] : [],
              NS: [{ name: n, type: "NS", ttl: 86400, data: "ns1.example.com." }], PTR: [{ name: "1.30.20.10.in-addr.arpa", type: "PTR", ttl: 300, data: "gateway.example.lan." }] }[t] || [];
            return { answers: a, ms: 12, server: args.server || "10.20.30.1", status: a.length ? "" : "NXDOMAIN" };
          }
          case "connection_info": return { adapter: "Wi-Fi", description: "Example Wireless Adapter", address: "10.20.30.5", prefix: 24, mask: "255.255.255.0", router: "10.20.30.1", dhcpServer: "10.20.30.1", dhcp: true, leaseLeftSecs: 70000, dns: ["10.20.30.1"], domain: "example.lan", ipv6: ["2001:db8::5", "fe80::1"], mac: "00:1A:2B:00:00:05", mtu: 1500, linkMbps: 866 };
          case "public_ip": return "203.0.113.77";
          case "renew_dhcp": return;
          case "wifi_status": return { state: "ok", ssid: "Example-Office", bssid: "00:1A:2B:AA:00:01", rssi: -55 - Math.round(Math.random() * 8), quality: 82, rxMbps: 866, txMbps: 780, channel: 44, band: "5 GHz", widthMhz: 80, security: "WPA2/WPA3 Personal", adapter: "Example Wireless Adapter" };
          case "wifi_scan": return [
            { ssid: "Example-Office", bssid: "00:1A:2B:AA:00:01", rssi: -55, channel: 44, band: "5 GHz", widthMhz: 80, security: "WPA2/WPA3 Personal", mine: true },
            { ssid: "Example-Office", bssid: "00:1A:2B:AA:00:02", rssi: -48, channel: 6, band: "2.4 GHz", widthMhz: 20, security: "WPA2/WPA3 Personal", mine: false },
            { ssid: "Neighbor-Net", bssid: "00:1A:2B:BB:00:01", rssi: -72, channel: 1, band: "2.4 GHz", widthMhz: 20, security: "WPA2 Personal", mine: false },
            { ssid: "", bssid: "00:1A:2B:CC:00:01", rssi: -81, channel: 11, band: "2.4 GHz", widthMhz: 40, security: "WPA2 Personal", mine: false },
            { ssid: "Guest", bssid: "00:1A:2B:AA:00:03", rssi: -66, channel: 149, band: "5 GHz", widthMhz: 80, security: "Open", mine: false }];
          case "open_location_settings": return;
          case "speed_start": {
            const e = p => emitTo(args.event || "speed", p);
            e({ kind: "phase", phase: "latency" });
            setTimeout(() => e({ kind: "phase", phase: "download" }), 500);
            [1, 2, 3].forEach(i => setTimeout(() => e({ kind: "live", phase: "download", mbps: 300 + i * 40 }), 500 + i * 300));
            setTimeout(() => e({ kind: "phase", phase: "upload" }), 1600);
            [1, 2].forEach(i => setTimeout(() => e({ kind: "live", phase: "upload", mbps: 20 + i * 5 }), 1600 + i * 300));
            setTimeout(() => e({ kind: "done", downMbps: 412.3, upMbps: 31.4, idleMs: 14.2, loadedMs: 48.9, server: "Cloudflare" }), 2400);
            return;
          }
          case "save_scans_file": window.__lastExport = args.content; return `(demo) ${args.fileName}`;
          case "open_scans_file": return window.__nextImport ? ["Example Clinic scans.arpradar", window.__nextImport] : null;
          case "org_action": console.log("demo org action", args); return;
          case "export_workbook": window.__lastWorkbook = args.sheets; return `(demo) ${args.fileName}`;
          case "trace_collect": return [{ number: 1, address: "10.20.30.1", name: "gateway", ms: 2 }, { number: 2, address: "203.0.113.9", name: "edge1.example.net", ms: 9 }, { number: 3, address: "1.1.1.1", name: "one.one.one.one", ms: 14 }];
          case "rdap_lookup": return { registrar: "Example Registrar, Inc.", created: "2015-03-14T00:00:00Z", expires: "2028-03-14T00:00:00Z", updated: null, nameServers: ["ns1.dnshost.example", "ns2.dnshost.example"], dnssec: false, status: [] };
          case "cert_check": return args.host.startsWith("remote") ? { host: args.host, port: 443, expires: new Date(Date.now() + 22 * 864e5).toISOString(), issuer: "Example CA", names: [args.host], coversHost: true, problem: "" }
            : args.host.startsWith("vpn") ? { host: args.host, port: 443, expires: null, issuer: "", names: [], coversHost: false, problem: "no HTTPS answer" }
            : { host: args.host, port: 443, expires: "2027-01-30T00:00:00Z", issuer: "Let's Encrypt", names: ["example.com", "www.example.com"], coversHost: true, problem: "" };
          case "find_subdomains": return [["billing.example.com", "intranet-old.example.com"], "crt.sh"];
          case "unifi_get": {
            await new Promise(r => setTimeout(r, 150));
            if (!(args.key || store["key-" + args.id])) throw "The API key isn’t saved on this PC. Open UniFi Controller… and enter it again.";
            if ((args.key || store["key-" + args.id]) === "wrong") return { status: 401, body: "" };
            return unifiReply(args.path);
          }
          case "snmp_switches": await new Promise(r => setTimeout(r, 300));
            return { switches: [], log: args.devices.map(d => `SNMP ${d.ip}: not a switch (no bridge ports)`) };
          case "unifi_key_save": store["key-" + args.id] = args.key; return;
          case "unifi_key_has": return !!store["key-" + args.id];
          case "unifi_key_delete": delete store["key-" + args.id]; return;
          case "export_bytes": window.__lastExportBytes = args; return `(demo) ${args.fileName}`;
          case "load_file": try { return localStorage.getItem("demo-" + args.name); } catch { return null; }
          case "save_file": try { localStorage.setItem("demo-" + args.name, args.json); } catch {} return;
          case "set_tray": case "tray_status": return;
          case "notify": console.log("demo notification", args.title, args.body); return;
          case "remote_wake_send": await new Promise(r => setTimeout(r, 300)); return;
          case "is_awake": return Math.random() < 0.3;
          case "scan_range_in_main": console.log("demo scan range", args.range); return;
        }
        throw `demo: unknown command ${cmd}`;
      },
    },
    event: { emit: async (name, payload) => emitTo(name, payload), listen: async (name, f) => { (listeners[name] ||= []).push(f); return () => { listeners[name] = listeners[name].filter(x => x !== f); }; } },
    window: { getCurrentWindow: () => ({ close: () => {} }) },
  };
}
