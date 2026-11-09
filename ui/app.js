// ARPradar window logic. The Rust side does the network work (start_scan sends "scan" events);
// this file keeps the devices, saved scans, favorites and history, and draws the table.
// Same rules as the Mac app's ScanModel.swift.
"use strict";

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const $ = id => document.getElementById(id);

// MARK: Small helpers

function load(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ipNum = ip => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const fmtDate = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const PORT_LABELS = { 21: "FTP", 22: "SSH", 23: "Telnet", 53: "DNS", 80: "HTTP", 443: "HTTPS", 445: "SMB", 548: "AFP", 554: "RTSP",
  631: "IPP", 3389: "RDP", 5900: "VNC", 8080: "HTTP:8080", 8443: "HTTPS:8443", 9100: "Printer" };
const portsText = d => (d.openPorts || []).map(p => PORT_LABELS[p] || p).join(" ");
const MAX_HISTORY = 50;

/// Devices are remembered by MAC address when there is one, otherwise by IP.
const keyOf = d => d.mac || d.ip;

function device(ip) {
  return { ip, name: "", mac: "", vendor: "", thisPc: false, isOnline: true, openPorts: [], responseMs: null,
           names: {}, firstSeen: null, lastSeen: null, isNew: false,
           webTitle: "", upnp: "", snmpName: "", snmpDescr: "", snmpLocation: "", ubntModel: "", ubntFirmware: "", ipv6: [], banners: {} };
}
/// One short line saying what the device is: UPnP model, then SNMP description, then web page title.
function describe(d) {
  if (d.upnp) return d.upnp;
  if (d.ubntModel) return d.ubntFirmware ? `${d.ubntModel} · ${d.ubntFirmware}` : d.ubntModel;
  const descr = (d.snmpDescr || "").split("\n")[0];
  if (descr) return descr.length > 70 ? descr.slice(0, 70) + "\u2026" : descr;
  return d.webTitle || "";
}
/// What kind of device it is (the Type column): the type set by hand (right-click › Type), else the guess.
const kindOf = d => data.types[keyOf(d)] || DeviceType.guess(d, { mapKind: mapKindOf(d), isDhcp: ui.servers.dhcp === d.ip });
const kindLabel = d => DEVICE_KINDS[kindOf(d)] || "";
/// Gateways, switches and access points on the UniFi map, by MAC (none until the map is loaded).
let mapKindsFor = null, mapKinds = new Map();
function mapKindOf(d) {
  const map = ui.netMap;
  if (!map || !d.mac) return null;
  if (mapKindsFor !== map) {
    mapKindsFor = map; mapKinds = new Map();
    for (const n of map.nodes || []) {
      const k = { gateway: "router", switch: "switch", ap: "ap" }[n.kind];
      if (k && n.mac) mapKinds.set(n.mac.toUpperCase(), k);
    }
  }
  return mapKinds.get(d.mac.toUpperCase()) || null;
}
/// Where each device plugs in (switch and port, or access point), by MAC, from the same map; rebuilt when it changes.
let linksFor = null, switchLinks = new Map();
function switchLinkOf(d) {
  if (!ui.netMap || !d.mac) return null;
  if (linksFor !== ui.netMap) { linksFor = ui.netMap; switchLinks = mapSwitchLinks(ui.netMap); }
  return switchLinks.get(NetMapBuilder.mac(d.mac)) || null;
}
/// View › Type Column (on at first) and Switch Port Column (off at first), also in Settings › General.
const showTypeColumn = () => load("showTypeColumn", "1") === "1";
const showSwitchPortColumn = () => load("showSwitchPortColumn", "0") === "1";
function setColumnSetting(key, on) { save(key, on ? "1" : "0"); try { T.event.emit?.("settings-changed", {})?.catch(() => {}); } catch {} render(); }
function setType(list, kind) {
  for (const d of list) { if (kind) data.types[keyOf(d)] = kind; else delete data.types[keyOf(d)]; }
  persist(); render();
}

/// The copy that gets saved: no NEW flag.
const clean = d => { const c = { ...d, names: { ...d.names } }; delete c.isNew; return c; };

// MARK: Saved data (data.json, through the Rust side)

let data = { version: 1, known: {}, favorites: [], comments: {}, types: {}, history: [], sites: [] };
let hadData = false;
let saveTimer = null;
/// Set when data.json is there but couldn't be read: nothing is saved until the app is reopened, so the file stays.
let dataProblem = null;
/// Saves half a second after the last change (late names, comment typing), written on a worker thread.
function persist() {
  if (dataProblem) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; invoke("save_data", { json: JSON.stringify(data) })
    .then(() => { try { T.event.emit?.("sites-changed", {})?.catch(() => {}); } catch {} })
    .catch(e => showError("Couldn't save: " + e)); }, 500);
}
/// Quitting or closing right after a change must not lose it.
window.addEventListener("beforeunload", () => { if (saveTimer && !dataProblem) { clearTimeout(saveTimer); invoke("save_data", { json: JSON.stringify(data) }).catch(() => {}); } });
async function loadData() {
  let text;
  try { text = await invoke("load_data"); }
  catch (e) {
    dataProblem = `ARPradar couldn’t read its saved data: ${e}. Nothing will be saved there until the app is reopened.`;
    return showError(dataProblem);
  }
  try {
    if (!text) return;
    hadData = true;
    const d = JSON.parse(text);
    data = { ...data, ...d };
    for (const k of ["known", "comments", "types"]) data[k] = data[k] || {};
    for (const k of ["favorites", "history", "sites"]) data[k] = Array.isArray(data[k]) ? data[k] : [];
  } catch (e) {
    // Keep the unreadable file, and don't write over it: the store is read-only until the app is reopened.
    const copy = await invoke("keep_unreadable_data").catch(() => "data.unreadable.json");
    dataProblem = `ARPradar couldn’t make sense of its saved data; a copy was kept at ${copy}. Nothing will be saved there until the app is reopened.`;
    showError(dataProblem);
  }
}

// MARK: Window state

const ui = {
  devices: [],           // Results rows: this scan's devices, then offline ones
  siteId: null,          // the app always opens as a new, unsaved scan
  servers: { dhcp: null, dns: [] },   // this network's DHCP server and name servers, found by the scan shown
  serverOffer: null,     // after a scan in an organization: a name server it could use
  autoFileOrgId: null,   // a new scan started from an organization's page: each run is filed there
  scanSiteId: null,      // the saved scan a running scan belongs to
  scanToken: 0,          // the running scan's number: events from an older scan (or after another scan was opened) are dropped
  tab: "results",
  netMap: null,          // the Map tab's map for the scan shown (saved with it in History)
  mapLoading: false, mapError: null, mapLog: "",
  currentRecordId: null, // the History record of the scan shown (its map is saved there)
  sort: { key: "ip", asc: true },
  search: "",
  scanning: false,
  spans: [],             // address spans the shown scan covered
  rangeText: "",
  selectedRecord: null,
  selection: new Set(),
  offerSave: false,
  adapters: [],
  status: "Ready",
  showDetails: load("showDetails", "0") === "1",
  preferredOrgId: null,  // "New Network Scan" from an organization: Save Scan offers it first
  surveyIdForNextScan: null,
  scanWaiters: [],       // the site survey waiting for a scan to finish
  dhcp: null,            // {text, spans} of the current saved scan's DHCP range
  hidden: new Set((() => { try { return JSON.parse(load("hiddenColumns", '["response"]')); } catch { return ["response"]; } })()),
  banners: {},           // ip -> {port: text} | "loading", read when the details panel opens
  shares: {},            // ip -> {smb, nfs, problem} | "loading"
};
let services = new Map(); // port -> what usually runs there
const site = id => data.sites.find(s => s.id === id) || null;
const currentSite = () => site(ui.siteId);
const knownFor = id => site(id)?.known || {};   // an unsaved scan remembers nothing
/// A scan in an organization uses the organization's name server and DHCP range (its own only when those are blank).
const pickSetting = (fromOrg, own) => String(fromOrg || "").trim() || String(own || "").trim();
const effNameServer = s => pickSetting(Orgs.org(s?.orgID)?.nameServer, s?.nameServer);
const effDhcpRange = s => pickSetting(Orgs.org(s?.orgID)?.dhcpRange, s?.dhcpRange);
/// The read-only SNMP community a scan sends: its organization's (or the standalone scan's own), so one network's
/// community is never sent to devices on another. A new, unsaved scan sends "public".
const effSnmpCommunity = s => (s ? pickSetting(Orgs.org(s.orgID)?.snmpCommunity, s.snmpCommunity) : "") || "public";
const inSpans = (ip, spans) => { const n = ipNum(ip); return spans.some(([lo, hi]) => n >= lo && n <= hi); };

// MARK: The Mac app's rules: offline rows, old names, NEW devices

/// Remembered devices in the scanned range that weren't found, marked offline. When two share an IP
/// (DHCP moved them), the one seen most recently wins.
function offlineRows(known, found, spans) {
  const foundKeys = new Set(found.map(keyOf));
  const usedIPs = new Set(found.map(d => d.ip));
  const out = [];
  for (const [k, d] of Object.entries(known).sort((a, b) => (b[1].lastSeen || "").localeCompare(a[1].lastSeen || ""))) {
    if (foundKeys.has(k) || usedIPs.has(d.ip) || !inSpans(d.ip, spans)) continue;
    usedIPs.add(d.ip);
    out.push({ ...d, isOnline: false, isNew: false, responseMs: null });
  }
  return out;
}
/// Fills in names this scan didn't get (UDP questions sometimes go unanswered) from the last copy.
function keepOldNames(d, old) {
  for (const [src, n] of Object.entries(old.names || {})) if (!(src in d.names)) d.names[src] = n;
  if (!d.name && old.name && !old.thisPc) d.name = old.name;
}
/// Nothing counts as new the first time a saved scan is scanned.
function newKeys(found, known) {
  if (!Object.keys(known).length) return new Set();
  return new Set(found.map(keyOf).filter(k => !known[k]));
}

// MARK: Scanning

let byIp = new Map();
let scanStarted = null;
async function startScan() {
  let s = currentSite();
  const range = $("range").value.trim();
  // A different range typed while a saved scan is open is a new, unsaved scan: the saved one isn't changed.
  if (s && range.replace(/\s+/g, "") !== String(s.range || "").replace(/\s+/g, "")) {
    ui.siteId = null; ui.preferredOrgId = s.orgID || null; ui.autoFileOrgId = null; s = null;
  }
  let spans;
  try { spans = await invoke("parse_range", { text: range }); }
  catch (e) { return showError(String(e)); }
  const ns = effNameServer(s);
  if (ns && !isIPv4(ns)) return showError(Orgs.org(s?.orgID)
    ? `The name server “${ns}” isn’t a valid IP address. Fix it in the organization’s settings (Saved Scans › Organizations…).`
    : `The name server “${ns}” isn’t a valid IP address. Fix it in Saved Scans › Edit This Scan…`);
  ui.devices = []; byIp = new Map(); ui.selection.clear(); clearSearch();
  ui.spans = spans; ui.rangeText = range; ui.scanSiteId = ui.siteId; ui.offerSave = false;
  ui.servers = { dhcp: null, dns: [] }; ui.serverOffer = null;
  ui.tab = "results";
  try {
    const token = ++ui.scanToken;
    const count = await invoke("start_scan", { range, nameServer: ns || null, snmpCommunity: effSnmpCommunity(s), token });
    setScanning(true);
    scanStarted = Date.now();
    setProgress(0.02, `Scanning ${count} addresses…`);
  } catch (e) { showError(String(e)); }
  render();
}
function stopScan() { invoke("stop_scan"); setProgress(null, "Stopping…"); }
function toggleScan() { ui.scanning ? stopScan() : startScan(); }

function onScanEvent(e) {
  if (e.token !== undefined && e.token !== ui.scanToken) return;   // from a scan that was stopped or replaced
  const get = ip => { let d = byIp.get(ip); if (!d) { d = device(ip); byIp.set(ip, d); ui.devices.push(d); } return d; };
  switch (e.kind) {
    case "found":
      for (const f of e.devices) {
        const d = get(f.ip);
        if (f.thisPc) { d.thisPc = true; d.name = f.name || d.name; d.names["This PC"] = f.name; if (f.mac) d.mac = f.mac; }
      }
      break;
    case "response": for (const [ip, ms] of Object.entries(e.ms)) get(ip).responseMs = ms; break;
    case "macs": for (const [ip, m] of Object.entries(e.macs)) { const d = get(ip); d.mac = m.mac; d.vendor = m.vendor; } break;
    case "ports": for (const [ip, p] of Object.entries(e.ports)) get(ip).openPorts = p; break;
    case "names":
      for (const [ip, n] of Object.entries(e.names)) {
        const d = byIp.get(ip); if (!d) continue;
        d.names[e.source] = n; if (!d.name) d.name = n;
      }
      break;
    case "webTitles": for (const [ip, t] of Object.entries(e.titles)) if (byIp.has(ip)) byIp.get(ip).webTitle = t; break;
    case "upnp": for (const [ip, i] of Object.entries(e.info)) if (byIp.has(ip)) byIp.get(ip).upnp = i.model; break;
    case "snmp":
      for (const [ip, i] of Object.entries(e.info)) {
        const d = byIp.get(ip); if (!d) continue;
        d.snmpName = i.name; d.snmpDescr = i.descr; d.snmpLocation = i.location;
      }
      break;
    case "ipv6": for (const [ip, list] of Object.entries(e.ipv6)) if (byIp.has(ip)) byIp.get(ip).ipv6 = list; break;
    case "ubiquiti":
      for (const [ip, i] of Object.entries(e.info)) {
        const d = byIp.get(ip); if (!d) continue;
        d.ubntModel = i.model; d.ubntFirmware = i.firmware;
      }
      break;
    case "progress": setProgress(e.fraction, e.text); return;
    case "finished": finishScan(e.cancelled); return;
  }
  scheduleRender();
}

function finishScan(cancelled) {
  setScanning(false);
  const waiters = ui.scanWaiters; ui.scanWaiters = [];
  setTimeout(() => waiters.forEach(w => w(!cancelled)), 0);
  const secs = ((Date.now() - scanStarted) / 1000).toFixed(0);
  if (cancelled) {
    setProgress(null, `Stopped · ${ui.devices.length} found`);
  } else {
    recordScan();
    const s = site(ui.scanSiteId);
    if (!s && ui.devices.some(d => d.isOnline && !d.thisPc)) ui.offerSave = true;
    const filedIn = !s ? Orgs.org(ui.autoFileOrgId)?.name : null;
    setProgress(null, `Scanned in ${secs} s${filedIn ? ` · saved in ${filedIn}` : ""}`);
    // The map (UniFi controller and/or SNMP switches) also fills the Switch port column, so build it when that's on.
    if (advanced() && (mapController() || ui.tab === "map" || showSwitchPortColumn())) setTimeout(loadMap, 0);
  }
  render();
}

/// After a full scan: remember every device, mark the new ones, add offline rows, save to History.
function recordScan() {
  const now = new Date().toISOString();
  const s = site(ui.scanSiteId);
  const before = knownFor(ui.scanSiteId);
  const online = ui.devices.filter(d => d.isOnline);
  const fresh = newKeys(online, before);
  for (const d of online) {
    const k = keyOf(d);
    d.lastSeen = now;
    const old = before[k] || (s ? data.known[k] : null);
    d.firstSeen = old?.firstSeen || now;
    if (old && old.ip === d.ip) keepOldNames(d, old);
    d.isNew = fresh.has(k);
    data.known[k] = clean(d);
    if (s) s.known[k] = clean(d);
  }
  ui.devices.push(...offlineRows(knownFor(ui.scanSiteId), online, ui.spans));
  const record = { id: newId(), date: now, range: ui.rangeText, siteName: s?.name || null, siteID: s?.id || null, devices: online.map(clean) };
  notifyNew(online.filter(d => fresh.has(keyOf(d))), s);
  data.history.unshift(record);
  ui.currentRecordId = record.id; ui.netMap = null; ui.mapError = null;
  data.history.length = Math.min(data.history.length, MAX_HISTORY);
  if (s) { s.lastScan = record; s.range = ui.rangeText; }
  persist();
  findServers(record.id, ui.scanSiteId);
  // Scans of an organization's saved scan are filed under it automatically (like the Mac app).
  if (s?.orgID && Orgs.org(s.orgID)) {
    const off = ui.devices.length - online.length;
    const summary = `${online.length} online${off ? `, ${off} offline` : ""}${fresh.size ? `, ${fresh.size} new` : ""} · ${ui.rangeText}`;
    Orgs.addItem(s.orgID, { kind: "networkScan", title: `Network scan · ${s.name}`, summary, table: scanTable(ui.devices) }, { siteName: s.name, surveyID: ui.surveyIdForNextScan || null });
  } else if (!s && Orgs.org(ui.autoFileOrgId)) {
    // A new scan started from an organization's page is filed there (delete it there if not wanted).
    const off = ui.devices.length - online.length;
    Orgs.addItem(ui.autoFileOrgId, { kind: "networkScan", title: `Network scan · ${ui.rangeText}`, summary: `${online.length} online${off ? `, ${off} offline` : ""}`, table: scanTable(ui.devices) });
  }
  ui.surveyIdForNextScan = null;
}

/// The device table as saved for an organization (the Mac's columns).
function scanTable(list) {
  const f = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";
  const dh = !!ui.dhcp;
  return { header: ["Status", "Name", "Type", "IP", ...(dh ? ["In DHCP range"] : []), "Description", "Manufacturer", "MAC address", "Open ports", "Response (ms)", "Comments", "First seen", "Last seen"],
    rows: [...list].sort((a, b) => ipNum(a.ip) - ipNum(b.ip)).map(d => [d.isOnline ? "Online" : "Offline", d.name, kindLabel(d), d.ip, ...(dh ? [inDhcpText(d)] : []), describe(d), d.vendor, d.mac, portsText(d),
      d.responseMs == null ? "" : String(Math.round(d.responseMs)), data.comments[keyOf(d)] || "", f(d.firstSeen), f(d.lastSeen)]),
    widths: [9, 26, 14, 15, ...(dh ? [14] : []), 34, 26, 19, 26, 13, 30, 17, 17], numberColumns: [dh ? 9 : 8] };
}

/// Settings › "Notify me about new devices": a Windows notification after a scan that found NEW devices.
function notifyNew(list, s) {
  if (!list.length || load("notifyNew", "0") !== "1") return;
  const where = s ? ` at ${s.name}` : "";
  const title = list.length === 1 ? `New device${where}` : `${list.length} new devices${where}`;
  const body = list.slice(0, 4).map(d => `${d.name || d.vendor || "Unknown"} (${d.ip})`).join(", ") + (list.length > 4 ? "…" : "");
  invoke("notify", { title, body }).catch(() => {});
}

// MARK: DHCP server and name servers (the Mac's NetServers)

/// The lease's DHCP server and DNS servers count only when they're in the scanned range: those are the name servers
/// the network hands out. When the lease has none there (scanning over a VPN), devices with the DNS port (53) open
/// count instead, except Apple devices: Apple TVs and HomePods answer DNS for Thread smart-home gear.
function findNetServers(devices, spans, lease) {
  const out = { dhcp: null, dns: [] };
  if (isIPv4(lease.dhcp || "") && inSpans(lease.dhcp, spans)) out.dhcp = lease.dhcp;
  for (const t of lease.dns || []) if (isIPv4(t) && inSpans(t, spans) && !out.dns.includes(t)) out.dns.push(t);
  if (!out.dns.length) out.dns = devices.filter(d => d.isOnline && (d.openPorts || []).includes(53) && !/apple/i.test(d.vendor || ""))
    .map(d => d.ip).sort((a, b) => ipNum(a) - ipNum(b));
  return out;
}
const serversEmpty = s => !s.dhcp && !s.dns.length;
const serversSummary = s => [s.dhcp && `DHCP ${s.dhcp}`, s.dns.length && `DNS ${s.dns.join(", ")}`].filter(Boolean).join(" · ");
function serverRole(ip) {
  const d = ui.servers.dhcp === ip, n = ui.servers.dns.includes(ip);
  return d && n ? "DHCP · DNS server" : d ? "DHCP server" : n ? "Name server" : null;
}
const recordServers = r => ({ dhcp: r?.dhcpServer || null, dns: Array.isArray(r?.nameServers) ? r.nameServers : [] });

/// After a scan: reads this PC's lease on the selected adapter, finds the servers and saves them with the scan.
async function findServers(recordId, scanSiteId) {
  const a = currentAdapter();
  let lease = { dhcp: "", dns: [] };
  if (a) { try { const info = await invoke("connection_info", { id: a.id }); if (info) lease = { dhcp: info.dhcp ? info.dhcpServer : "", dns: info.dns || [] }; } catch {} }
  const rec = data.history.find(r => r.id === recordId);
  const found = findNetServers(rec ? rec.devices.map(d => ({ ...d, isOnline: true })) : ui.devices, ui.spans, lease);
  for (const r of [rec, site(scanSiteId)?.lastScan].filter(x => x && x.id === recordId)) { r.dhcpServer = found.dhcp; r.nameServers = found.dns; }
  persist();
  if (ui.scanning || ui.siteId !== scanSiteId) return;
  ui.servers = found;
  noteServersForOrganization();
  render();
}

/// For a saved scan in an organization: show what was found in its Settings, and offer a name server when the
/// organization's is blank or isn't one of those found.
function noteServersForOrganization() {
  const s = currentSite(), o = Orgs.org(s?.orgID);
  if (!o || serversEmpty(ui.servers)) return;
  const sv = ui.servers;
  Orgs.mutate(d => { const x = d.orgs.find(y => y.id === o.id); if (x) { x.seenDHCPServer = sv.dhcp || ""; x.seenNameServers = [...sv.dns]; x.seenScan = s.name; x.seenDate = new Date().toISOString(); } });
  const cur = String(o.nameServer || "").trim();
  ui.serverOffer = sv.dns.length && !sv.dns.includes(cur) ? sv.dns[0] : null;
}
function useOfferedNameServer() {
  const ip = ui.serverOffer, o = Orgs.org(currentSite()?.orgID);
  ui.serverOffer = null;
  if (ip && o) Orgs.mutate(d => { const x = d.orgs.find(y => y.id === o.id); if (x) x.nameServer = ip; });
  render();
}

// MARK: File › Open Recent

const recentScans = () => { const c = load("recentClearedAt", ""); return data.history.filter(r => !c || r.date > c).slice(0, 5); };
function recentTitle(r) {
  const d = new Date(r.date);
  const when = d.toDateString() === new Date().toDateString() ? "Today " + d.toLocaleTimeString(undefined, { timeStyle: "short" }) : fmtDate(r.date);
  return `${r.siteName || "New scan (not saved)"} – ${r.range} · ${when}`;
}
/// A saved scan opens as that saved scan; an unsaved one comes back as a new scan that can still be saved.
async function openRecent(r) {
  if (ui.scanning) return;
  // Matched by id (a renamed or re-made saved scan with the same name isn't the same scan); older records by name.
  const s = r.siteID ? data.sites.find(x => x.id === r.siteID) : r.siteName && data.sites.find(x => x.name === r.siteName);
  if (s) return selectSite(s.id);
  ui.siteId = null; ui.preferredOrgId = null; ui.autoFileOrgId = null; ui.serverOffer = null; ui.tab = "results";
  await showLastScan(r);
  ui.offerSave = ui.devices.some(d => d.isOnline && !d.thisPc);
  render();
}

/// When a saved scan is picked (or File › Open Recent): its last scan, plus grey rows for remembered devices.
async function showLastScan(chosen) {
  const s = currentSite();
  ui.offerSave = false; ui.selection.clear();
  const record = chosen || (s ? s.lastScan : data.history[0]);
  ui.devices = []; byIp = new Map(); ui.servers = recordServers(record);
  ui.currentRecordId = record?.id || null; ui.netMap = record?.netMap || null; ui.mapError = null;
  if (s) $("range").value = s.range;
  if (!record) { setProgress(null, s ? `${s.name} · not scanned yet` : "Ready"); return render(); }
  try { ui.spans = await invoke("parse_range", { text: record.range }); } catch { ui.spans = []; }
  const seen = new Set();
  const found = record.devices.filter(d => !seen.has(d.ip) && seen.add(d.ip)).map(d => ({ ...d, names: { ...d.names }, isOnline: true, isNew: false }));
  ui.devices = [...found, ...offlineRows(knownFor(ui.siteId), found, ui.spans)];
  for (const d of ui.devices) byIp.set(d.ip, d);
  ui.rangeText = record.range;
  $("range").value = record.range;
  setProgress(null, s && s.lastScan?.id !== record.id ? `${s.name} · scan from ${fmtDate(record.date)} (an earlier scan)`
    : s ? `${s.name} · last scan ${fmtDate(record.date)}` : `Scan from ${fmtDate(record.date)} · not saved`);
  render();
}
/// Loads a scan from History into Results (History › Open in Results, or going back to Results with one picked).
/// A scan of a saved scan opens as that saved scan, so Rescan scans it again; an unsaved one can still be saved.
async function openHistoryRecord(r) {
  if (ui.scanning || !r) return;
  const s = r.siteID ? data.sites.find(x => x.id === r.siteID) : r.siteName && data.sites.find(x => x.name === r.siteName);
  ui.siteId = s?.id || null; ui.preferredOrgId = null; ui.autoFileOrgId = null; ui.serverOffer = null; ui.scanToken++;
  clearSearch();
  await showLastScan(r);
  ui.offerSave = !s && ui.devices.some(d => d.isOnline && !d.thisPc);
  render();
}

// MARK: Saved scans

function selectSite(id) {
  if (ui.scanning) return;
  ui.preferredOrgId = null; ui.autoFileOrgId = null; ui.serverOffer = null;
  ui.siteId = id; ui.scanToken++; clearSearch();
  showLastScan();
}
/// New Scan (next to Scan, Ctrl+N): an empty list on this PC's network, not saved. From an organization's page,
/// each finished run is filed under that organization.
function newScan(orgId) {
  if (ui.scanning) return;
  ui.siteId = null; ui.preferredOrgId = orgId || null; ui.autoFileOrgId = orgId || null; ui.scanToken++; clearSearch();
  ui.devices = []; byIp = new Map(); ui.offerSave = false; ui.selection.clear(); ui.rangeText = "";
  ui.servers = { dhcp: null, dns: [] }; ui.serverOffer = null; ui.tab = "results";
  ui.netMap = null; ui.currentRecordId = null; ui.mapError = null;
  applyAdapter();
  const o = Orgs.org(orgId);
  setProgress(null, o ? `New scan for ${o.name} · press Scan` : "New scan · press Scan");
  render();
}
function uniqueName(base) {
  const names = new Set(data.sites.map(s => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
/// Saves the current (unsaved) scan as a saved scan: it keeps the devices just found.
function createSite(fields, fromCurrent) {
  const s = { id: newId(), name: fields.name, range: fields.range, nameServer: fields.nameServer || "", dhcpRange: fields.dhcpRange || "",
              snmpCommunity: fields.snmpCommunity || "", notes: fields.notes || "", orgID: fields.orgID || null, known: {}, lastScan: null };
  if (fromCurrent) {
    for (const d of ui.devices.filter(d => d.isOnline)) s.known[keyOf(d)] = clean(d);
    const last = data.history[0];
    if (last && last.range === ui.rangeText && !last.siteName) { last.siteName = s.name; s.lastScan = last; }
  }
  data.sites.push(s);
  persist();
  return s;
}
function deleteSite(id) {
  data.sites = data.sites.filter(s => s.id !== id);
  if (ui.siteId === id) newScan();
  persist(); render();
}

// MARK: Favorites, comments, history

const isFav = d => data.favorites.includes(keyOf(d));
function toggleFav(d) {
  const k = keyOf(d);
  if (isFav(d)) data.favorites = data.favorites.filter(x => x !== k);
  else { data.favorites.push(k); if (!data.known[k]) data.known[k] = clean(d); }
  persist(); render();
}
function setComment(d, text) {
  const k = keyOf(d);
  if (text.trim()) data.comments[k] = text.trim(); else delete data.comments[k];
  persist();
}
/// Right-click › Forget This Device: stop remembering these offline devices for this saved scan (favorites are kept).
function forgetDevices(list) {
  const s = currentSite();
  const keys = new Set(list.filter(d => !d.isOnline && !data.favorites.includes(keyOf(d))).map(keyOf));
  if (!keys.size) return;
  for (const k of keys) { if (s) delete s.known[k]; else delete data.known[k]; }
  ui.devices = ui.devices.filter(d => d.isOnline || !keys.has(keyOf(d)));
  for (const d of list) if (keys.has(keyOf(d))) { byIp.delete(d.ip); ui.selection.delete(d.ip); }
  persist(); render();
}
function forgetOffline() {
  const s = currentSite();
  const gone = ui.devices.filter(d => !d.isOnline).map(keyOf);
  for (const k of gone) { if (s) delete s.known[k]; if (!data.favorites.includes(k)) delete data.known[k]; }
  ui.devices = ui.devices.filter(d => d.isOnline);
  persist(); render();
}

// MARK: What the table shows

const COLUMNS = [
  { key: "star", label: "☆", title: "Favorite", cls: "c-star frozen f0" },
  { key: "dot", label: "●", title: "Online", cls: "c-dot frozen f1", sort: d => (d.isOnline ? 0 : 1) },
  { key: "name", label: "Name", cls: "c-name frozen f2", sort: d => (d.name || "￿").toLowerCase() },
  { key: "type", label: "Type", cls: "c-type frozen f3", sort: d => kindLabel(d) || "￿" },
  { key: "ip", label: "IP", cls: "c-ip", sort: d => ipNum(d.ip) },
  { key: "switchport", label: "Switch port", cls: "c-switch", title: "Where it plugs in: the UniFi switch and port, or the access point for Wi-Fi (from the UniFi map)", sort: d => switchLinkSort(switchLinkOf(d)) },
  { key: "mac", label: "MAC", cls: "c-mac", advanced: true, sort: d => d.mac || "￿" },
  { key: "vendor", label: "Vendor", cls: "c-vendor", sort: d => (d.vendor || "￿").toLowerCase() },
  { key: "desc", label: "Description", cls: "c-desc", advanced: true, sort: d => (describe(d) || "\uffff").toLowerCase() },
  { key: "ports", label: "Open ports", cls: "c-ports", advanced: true, sort: d => portsText(d) || "￿" },
  { key: "response", label: "Response", cls: "c-response", advanced: true, sort: d => d.responseMs ?? Infinity },
  { key: "comment", label: "Comment", cls: "c-comment", sort: d => (data.comments[keyOf(d)] || "￿").toLowerCase() },
];

function tabRows() {
  if (ui.tab === "results" || ui.tab === "map") return ui.devices;
  if (ui.tab === "favorites") {
    const rows = data.favorites.map(k => {
      const live = ui.devices.find(d => keyOf(d) === k && d.isOnline);
      if (live) return live;
      const d = data.known[k];
      return d ? { ...d, isOnline: false, isNew: false } : null;
    }).filter(Boolean);
    // Two favorites can have been last seen at the same IP (DHCP moved them); the table shows one row per IP:
    // the one that's online now, else the most recently seen.
    const seen = new Set();
    return rows.sort((a, b) => (b.isOnline - a.isOnline) || String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")))
      .filter(d => !seen.has(d.ip) && seen.add(d.ip));
  }
  return data.history.find(r => r.id === ui.selectedRecord)?.devices.map(d => ({ ...d, isOnline: true })) || [];
}
function visibleRows() {
  const q = ui.search.trim().toLowerCase();
  const showOffline = $("offline").checked || ui.tab === "history";
  let rows = tabRows().filter(d => showOffline || d.isOnline);
  if (q) rows = rows.filter(d => [d.name, d.ip, d.mac, d.vendor, data.comments[keyOf(d)], portsText(d), describe(d), kindLabel(d)]
    .some(v => String(v || "").toLowerCase().includes(q)));
  const col = COLUMNS.find(c => c.key === ui.sort.key) || COLUMNS[3];
  const dir = ui.sort.asc ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    if (x === y) return ipNum(a.ip) - ipNum(b.ip);
    return (x < y ? -1 : 1) * dir;
  });
}

/// Find Device (Ctrl+F): the Search box, its text selected.
function focusSearch() { $("search").focus(); $("search").select(); }
/// The Search box empties when a new scan starts or another saved scan opens, so nothing stays hidden by surprise.
function clearSearch() { ui.search = ""; $("search").value = ""; }
/// Rows of this tab the Search box is hiding right now.
function hiddenBySearch() {
  if (!ui.search.trim()) return 0;
  const showOffline = $("offline").checked || ui.tab === "history";
  return Math.max(0, tabRows().filter(d => showOffline || d.isOnline).length - shown.length);
}

let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

// MARK: DHCP range (Mark outside DHCP, like the Mac)

const markDHCP = () => advanced() && load("markOutsideDHCP", "1") === "1" && !!ui.dhcp;
const isOutside = d => markDHCP() && !inSpans(d.ip, ui.dhcp.spans);
/// Works out the current saved scan's DHCP pool (spans) when it changes.
let dhcpFor = null;
async function refreshDHCP() {
  const text = effDhcpRange(currentSite());
  const key = `${ui.siteId}|${text}`;
  if (key === dhcpFor) return;
  dhcpFor = key;
  if (!text) { ui.dhcp = null; return render(); }
  try { ui.dhcp = { text, spans: await invoke("parse_range", { text }) }; } catch { ui.dhcp = null; }
  render();
}
const inDhcpText = d => ui.dhcp ? (inSpans(d.ip, ui.dhcp.spans) ? "Yes" : "No") : null;

let shown = [], lastRowsHtml = null;
function render() {
  const adv = advanced();
  refreshDHCP();
  // Columns: Basic hides the expert ones; right-click a header to show or hide the rest.
  const cols = COLUMNS.filter(c => (adv || !c.advanced) && !ui.hidden.has(c.key)
    && (c.key !== "type" || showTypeColumn()) && (c.key !== "switchport" || showSwitchPortColumn()));
  document.querySelector("table.devices").classList.toggle("notype", !showTypeColumn());
  $("head").innerHTML = cols.map(c => {
    const arrow = ui.sort.key === c.key ? (ui.sort.asc ? " ▴" : " ▾") : "";
    return `<th class="${c.cls}${c.sort ? " sortable" : ""}" data-key="${c.key}" title="${esc(c.title || c.label)}">${esc(c.label)}${arrow}${c.key === "name" ? '<span class="namegrip" title="Drag to widen the Name column"></span>' : ""}</th>`;
  }).join("");
  shown = visibleRows();
  const rowsHtml = shown.map((d, i) => {
    const cls = [d.isOnline ? "" : "off", ui.selection.has(d.ip) ? "sel" : ""].join(" ");
    const out = isOutside(d);
    return `<tr class="${cls}" data-i="${i}">` + cols.map(c => `<td class="${c.cls}${c.key === "ip" && out ? " outside" : ""}"${c.key === "ip" && out ? ' title="Outside the DHCP range (static or reserved)"' : ""}>${cell(c.key, d)}</td>`).join("") + "</tr>";
  }).join("");
  // The table is only rebuilt when something in it changed (scan events and other windows render often).
  if (rowsHtml !== lastRowsHtml) { $("rows").innerHTML = rowsHtml; lastRowsHtml = rowsHtml; }

  // Empty table: say why.
  const empty = !shown.length;
  $("empty").hidden = !empty;
  if (empty) {
    const range = $("range").value.trim(), s = currentSite();
    let title = s ? `${s.name} hasn’t been scanned yet.` : "Nothing scanned yet.";
    let text = range ? `Press Scan (Ctrl+Enter) to find everything on ${esc(range)}. It takes about ten seconds.<br><button type="button" class="primary" data-empty="scan">Scan</button>`
                     : "Type an IP range above, then press Scan (Ctrl+Enter).";
    if (ui.scanning) { title = "Scanning…"; text = "Devices show up here as they answer."; }
    else if (ui.tab === "favorites" && !ui.search.trim()) { title = "No favorites"; text = "Click the ☆ next to a device to keep it here."; }
    else if (ui.tab === "history" && !ui.search.trim()) { title = data.history.length ? "Pick a past scan on the left" : "No scans yet. Every finished scan is kept here."; text = ""; }
    else if (hiddenBySearch() > 0) { title = `No devices match “${ui.search.trim()}”.`; text = '<button type="button" data-empty="showall">Show All</button>'; }
    else if (tabRows().length) { title = "Every device here is offline."; text = "Turn on Show offline in the bottom bar to see them."; }
    $("empty-title").textContent = title; $("empty-text").innerHTML = text;
  }

  // Tabs, history list, save bar, Scans picker, counts.
  document.querySelectorAll("[data-tab]").forEach(b => { b.classList.toggle("on", b.dataset.tab === ui.tab); b.setAttribute("aria-selected", b.dataset.tab === ui.tab); });
  $("tab-favorites").textContent = data.favorites.length ? `Favorites (${data.favorites.length})` : "Favorites";
  $("history").hidden = ui.tab !== "history";
  $("tablewrap").hidden = ui.tab === "map";
  renderMap();
  if (ui.tab === "history") renderHistory();
  $("savebar").hidden = !(ui.offerSave && !ui.siteId && !ui.scanning && ui.tab === "results");
  $("savebar-org").hidden = !advanced();
  const offerOrg = Orgs.org(currentSite()?.orgID);
  $("serverbar").hidden = !(ui.serverOffer && offerOrg && !ui.scanning);
  if (!$("serverbar").hidden) {
    const cur = String(offerOrg.nameServer || "").trim();
    $("serverbar-text").textContent = `Found on this network: ${serversSummary(ui.servers)}. ${cur ? `${offerOrg.name} uses ${cur}.` : `${offerOrg.name}’s settings have no name server yet.`}`;
    $("serverbar-use").textContent = `Use ${ui.serverOffer} for ${offerOrg.name}`;
  }
  $("scans-name").textContent = currentSite()?.name || "Open a saved scan";
  updateScanButton();
  $("newscan").disabled = ui.scanning;
  save("currentOrgId", currentSite()?.orgID || ui.preferredOrgId || "");
  save("currentSiteName", currentSite()?.name || "");
  $("scans").disabled = ui.scanning;
  renderStatus();
  renderDetails();
}

function cell(key, d) {
  switch (key) {
    case "star": return `<button type="button" class="${isFav(d) ? "fav" : ""}" data-act="fav" aria-label="Favorite" title="Favorite">${isFav(d) ? "★" : "☆"}</button>`;
    case "dot": return `<span class="dot" title="${d.isOnline ? "Online" : "Offline"}"></span>`;
    case "name": {
      const role = ui.tab === "results" ? serverRole(d.ip) : null;
      const tags = (d.thisPc ? `<span class="badge me">This PC</span>` : "") + (d.isNew && d.isOnline ? `<span class="badge new">NEW</span>` : "")
        + (role ? `<span class="badge ${role.startsWith("DHCP") ? "dhcp" : "dns"}" title="${role.startsWith("DHCP") ? "This network’s DHCP server (from this PC’s DHCP lease)" : "A name server: one this network’s DHCP hands out, or (over a VPN) a device with the DNS port (53) open"}">${role}</span>` : "");
      const title = Object.entries(d.names || {}).map(([s, n]) => `${s}: ${n}`).join("\n");
      return `<span title="${esc(title)}">${esc(d.name)}</span>${tags}`;
    }
    case "type": {
      const k = kindOf(d);
      return k ? `<span class="kind" title="${esc(DEVICE_KINDS[k])} (${data.types[keyOf(d)] ? "set by you" : "best guess; right-click › Type to change"})">${kindIcon(k)}${esc(DEVICE_KINDS[k])}</span>` : "";
    }
    case "ip": return `<span>${esc(d.ip)}</span>`;
    case "switchport": {
      const l = switchLinkOf(d); if (!l) return "";
      const speed = !l.wireless && l.mbps > 0 ? ` <span class="speed" style="color:${speedColor(l.mbps, SCREEN_PALETTE)}">${mapSpeed(l.mbps)}</span>` : "";
      return `<span title="${esc(switchLinkHelp(l))}"><span class="via">${l.wireless ? "Wi-Fi" : "⇄"}</span> ${esc(switchLinkShort(l))}${speed}</span>`;
    }
    case "mac": return esc(d.mac);
    case "vendor": return esc(d.vendor);
    case "ports": return esc(portsText(d));
    case "desc": return `<span title="${esc(describe(d))}">${esc(describe(d))}</span>`;
    case "response": return d.responseMs == null ? "" : d.responseMs < 1 ? "&lt;1 ms" : `${Math.round(d.responseMs)} ms`;
    case "comment": return esc(data.comments[keyOf(d)] || "");
  }
  return "";
}

function renderHistory() {
  $("history-list").innerHTML = data.history.map(r =>
    `<button type="button" class="history-item${r.id === ui.selectedRecord ? " on" : ""}" data-record="${esc(r.id)}">
       ${esc(fmtDate(r.date))}<small>${esc(r.siteName ? r.siteName + " · " : "")}${esc(r.range)} · ${r.devices.length} devices</small></button>`).join("")
    || `<p style="padding:12px;color:var(--muted)">Each finished scan is kept here (the last ${MAX_HISTORY}).</p>`;
  $("history-clear").disabled = !data.history.length;
  $("history-open").disabled = !ui.selectedRecord || ui.scanning;
}

function setProgress(fraction, text) {
  $("progress").hidden = fraction == null || !ui.scanning;
  if (fraction != null) $("progress-bar").style.width = `${Math.round(fraction * 100)}%`;
  if (text) ui.status = text;
  renderStatus();
}
function renderStatus() {
  const on = ui.devices.filter(d => d.isOnline).length, off = ui.devices.length - on;
  let counts = "";
  const fresh = ui.devices.filter(d => d.isOnline && d.isNew).length;
  if (ui.tab === "results" && ui.devices.length) counts = ` · ${on} online${off ? `, ${off} offline` : ""}${fresh ? `, ${fresh} new` : ""}`;
  const sv = ui.tab === "results" && !ui.scanning && !serversEmpty(ui.servers) ? ` · ${serversSummary(ui.servers)}` : "";
  $("status").textContent = ui.status + counts + sv;
  $("status").title = sv ? "This network’s DHCP server and name servers, found by the scan" : "";
  // Mark outside DHCP: off when the saved scan has no DHCP range; a chip says how many are outside it.
  $("markdhcp").checked = load("markOutsideDHCP", "1") === "1";
  $("markdhcp").disabled = !ui.dhcp;
  $("dhcpswitch").title = ui.dhcp ? `Tint addresses outside the DHCP range ${ui.dhcp.text}` : "Set a DHCP range in the organization’s Settings (or Edit This Scan… for a standalone scan) to use this";
  const outside = markDHCP() && ui.tab === "results" ? ui.devices.filter(d => d.isOnline && !inSpans(d.ip, ui.dhcp.spans)).length : 0;
  $("dhcpchip").hidden = !markDHCP() || ui.tab !== "results";
  $("dhcpchip").textContent = ui.dhcp ? `${outside} outside ${ui.dhcp.text}` : "";
  $("forget").hidden = !($("offline").checked && off > 0 && ui.tab === "results" && !ui.scanning);
  const hidden = hiddenBySearch();
  $("searchchip").hidden = !hidden;
  $("searchchip-text").textContent = `${hidden} hidden by search`;
  updateTray(on, ui.devices.filter(d => d.isOnline && d.isNew).length);
}
let trayText = "";
function updateTray(on, fresh) {
  if (load("tray", "0") !== "1") return;
  const text = `${currentSite()?.name || "New scan"} · ${ui.scanning ? "scanning…" : `${on} online${fresh ? `, ${fresh} new` : ""}`}`;
  if (text === trayText) return;
  trayText = text;
  invoke("tray_status", { text, scanning: ui.scanning }).catch(() => {});
}
/// Tools that are busy (ping running, speed test…) make the radar sweep, like a scan does.
const busyTools = new Set();
function setBusy(key, on) { on ? busyTools.add(key) : busyTools.delete(key); document.body.classList.toggle("busy", busyTools.size > 0); }
function setScanning(on) {
  ui.scanning = on;
  document.body.classList.toggle("scanning", on);
  $("scan").classList.toggle("stop", on);
  updateScanButton();
  $("progress").hidden = !on;
}
/// The Scan button reads Rescan when the list shows a scan of the range that's typed in.
const canRescan = () => !ui.scanning && ui.devices.length > 0 && !!ui.rangeText && $("range").value.trim() === ui.rangeText.trim();
function updateScanButton() {
  const label = ui.scanning ? "Stop" : canRescan() ? "Rescan" : "Scan";
  if ($("scan-label").textContent === label) return;
  $("scan-label").textContent = label;
  $("scan-icon").innerHTML = ui.scanning ? '<rect x="2" y="2" width="8" height="8" fill="currentColor"/>'
    : label === "Rescan" ? '<path d="M10 6a4 4 0 1 1-1.2-2.85M10 1.5v2.5H7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    : '<path d="M2 1 L11 6 L2 11 Z" fill="currentColor"/>';
  $("scan").title = label === "Rescan" ? "Scan this range again (Ctrl+Enter)" : "Scan the IP range (Ctrl+Enter)";
}

// MARK: Table clicks

$("head").addEventListener("click", e => {
  const th = e.target.closest("th"); if (!th) return;
  const col = COLUMNS.find(c => c.key === th.dataset.key); if (!col?.sort) return;
  ui.sort = ui.sort.key === col.key ? { key: col.key, asc: !ui.sort.asc } : { key: col.key, asc: true };
  render();
});
$("rows").addEventListener("click", e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const d = shown[Number(tr.dataset.i)];
  if (e.target.closest("[data-act=fav]")) return toggleFav(d);
  if (e.ctrlKey || e.metaKey) ui.selection.has(d.ip) ? ui.selection.delete(d.ip) : ui.selection.add(d.ip);
  else { ui.selection.clear(); ui.selection.add(d.ip); }
  // Only re-colour the rows (a full redraw would break double-clicking a comment).
  $("rows").querySelectorAll("tr").forEach(r => r.classList.toggle("sel", ui.selection.has(shown[Number(r.dataset.i)].ip)));
  lastRowsHtml = null;   // the rows on screen changed by hand: the next render redraws them
  renderDetails();
});
// Right-click a column header: show or hide columns (star, dot, Name, Type and IP always show).
$("head").addEventListener("contextmenu", e => {
  e.preventDefault();
  const items = COLUMNS.filter(c => !["star", "dot", "name", "ip"].includes(c.key) && (advanced() || !c.advanced)).map(c =>
    c.key === "type" ? { label: "Type", checked: showTypeColumn(), run: () => setColumnSetting("showTypeColumn", !showTypeColumn()) }
    : c.key === "switchport" ? { label: "Switch port", checked: showSwitchPortColumn(), run: () => setColumnSetting("showSwitchPortColumn", !showSwitchPortColumn()) }
    : { label: c.label, checked: !ui.hidden.has(c.key),
        run: () => { ui.hidden.has(c.key) ? ui.hidden.delete(c.key) : ui.hidden.add(c.key); save("hiddenColumns", JSON.stringify([...ui.hidden])); render(); } });
  showMenuAt([{ heading: "Columns" }, ...items, { sep: true }, { label: "Show All Columns", run: () => { ui.hidden.clear(); save("hiddenColumns", "[]"); save("showTypeColumn", "1"); setColumnSetting("showSwitchPortColumn", true); } }], e.clientX, e.clientY);
});
// Drag the Name column's right edge (it stays frozen at the left) and the details panel's left edge.
function dragWidth(start, getW, setW, min, max, dir) {
  const x0 = start.clientX, w0 = getW();
  const move = ev => setW(Math.max(min, Math.min(max, w0 + (ev.clientX - x0) * dir)));
  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  document.body.style.cursor = "col-resize";
}
const setNameW = w => { document.documentElement.style.setProperty("--name-w", `${w}px`); save("nameWidth", String(Math.round(w))); };
const setDetailsW = w => { $("details").style.width = `${w}px`; save("detailsWidth", String(Math.round(w))); };
setNameW(Number(load("nameWidth", "220")) || 220);
setDetailsW(Number(load("detailsWidth", "320")) || 320);
$("head").addEventListener("mousedown", e => {
  if (!e.target.classList.contains("namegrip")) return;
  e.preventDefault(); e.stopPropagation();
  dragWidth(e, () => Number(load("nameWidth", "220")) || 220, setNameW, 140, 520, 1);
});
$("head").addEventListener("click", e => { if (e.target.classList.contains("namegrip")) e.stopImmediatePropagation(); }, true);
$("detailsgrip").addEventListener("mousedown", e => { e.preventDefault(); dragWidth(e, () => $("details").offsetWidth, setDetailsW, 240, 640, -1); });
// History: right-click a past scan to delete just that one.
$("history-list").addEventListener("contextmenu", e => {
  const b = e.target.closest("[data-record]"); if (!b) return;
  e.preventDefault();
  const r = data.history.find(x => x.id === b.dataset.record); if (!r) return;
  showMenuAt([{ label: "Open in Results", disabled: ui.scanning, run: () => { ui.selectedRecord = r.id; setTab("results"); } }, { sep: true }, { label: "Delete This Scan…", run: () => confirmBox(`Delete the scan from ${fmtDate(r.date)}?`,
    "It is removed from History. Saved scans aren’t affected. This can’t be undone.", "Delete Scan", () => {
      data.history = data.history.filter(x => x.id !== r.id);
      if (ui.selectedRecord === r.id) ui.selectedRecord = null;
      persist(); render();
    }) }], e.clientX, e.clientY);
});
$("markdhcp").addEventListener("change", () => { save("markOutsideDHCP", $("markdhcp").checked ? "1" : "0"); render(); });
$("forget").addEventListener("click", askForgetOffline);
$("copyall").addEventListener("click", () => { const list = visibleRows(); copyText([["Status", "Name", "Type", "IP", "MAC", "Vendor", "Description", "Open ports", "Comment"].join("\t"),
  ...list.map(d => [d.isOnline ? "Online" : "Offline", d.name, kindLabel(d), d.ip, d.mac, d.vendor, describe(d), portsText(d), data.comments[keyOf(d)] || ""].map(tsvCell).join("\t"))].join("\n"),
  `Copied ${list.length} row${list.length === 1 ? "" : "s"} (paste into Excel)`); });
$("searchchip-clear").addEventListener("click", () => { clearSearch(); render(); });
$("empty").addEventListener("click", e => {
  const b = e.target.closest("[data-empty]"); if (!b) return;
  if (b.dataset.empty === "scan" && !ui.scanning) startScan();
  if (b.dataset.empty === "showall") { clearSearch(); render(); }
});
$("exportbtn").addEventListener("click", e => showMenuAt([{ label: "Export as CSV…", key: "Ctrl+E", run: () => exportRows("csv") },
  { label: "Export as Excel (.xlsx)…", key: "Ctrl+Shift+E", run: () => exportRows("xlsx") }], e.clientX, e.clientY - 70));
$("rows").addEventListener("contextmenu", e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  e.preventDefault();
  const d = shown[Number(tr.dataset.i)];
  if (!ui.selection.has(d.ip)) { ui.selection.clear(); ui.selection.add(d.ip); render(); }
  showMenuAt(deviceMenu(shown.filter(x => ui.selection.has(x.ip))), e.clientX, e.clientY);
});
// No browser right-click menu anywhere else, except in text boxes (for Cut/Copy/Paste).
document.addEventListener("contextmenu", e => { if (!e.target.closest("input, textarea, .details")) e.preventDefault(); });
// Double-click a comment to write one; anywhere else on a row shows its details.
$("rows").addEventListener("dblclick", e => {
  const td = e.target.closest("td.c-comment");
  if (!td || ui.tab === "history") { if (e.target.closest("tr") && !e.target.closest("[data-act]")) setDetails(true); return; }
  const d = shown[Number(td.parentElement.dataset.i)];
  td.innerHTML = `<input type="text" value="${esc(data.comments[keyOf(d)] || "")}" aria-label="Comment">`;
  const input = td.firstChild;
  input.focus(); input.select();
  let done = false;
  const finish = keep => { if (done) return; done = true; if (keep) setComment(d, input.value); lastRowsHtml = null; render(); };
  input.addEventListener("keydown", k => { if (k.key === "Enter") finish(true); if (k.key === "Escape") finish(false); k.stopPropagation(); });
  input.addEventListener("blur", () => finish(true));
});
$("history-list").addEventListener("click", e => {
  const b = e.target.closest("[data-record]"); if (!b) return;
  ui.selectedRecord = b.dataset.record; render();
});
$("history-open").addEventListener("click", () => { if (ui.selectedRecord) setTab("results"); });
$("history-clear").addEventListener("click", () => confirmBox(`Clear all ${data.history.length} scans from History?`,
  "Saved scans and their devices aren’t affected. This can’t be undone.", "Clear History",
  () => { data.history = []; ui.selectedRecord = null; persist(); render(); }));

// MARK: Menus (File, View, Tools, Help, and the Scans picker)

function advanced() { return !document.body.classList.contains("basic"); }
const ok = d => !ui.scanning && d;
function menuItems(name) {
  const s = currentSite();
  const hasDevices = ui.devices.some(d => d.isOnline);
  if (name === "scans" || name === "file") {
    const items = name === "file" ? [
      { label: "New Scan", key: "Ctrl+N", run: () => newScan(), disabled: ui.scanning },
      { label: "Rescan", key: "Ctrl+R", run: () => startScan(), disabled: !canRescan() },
      { label: "Find Device", key: "Ctrl+F", run: () => focusSearch() },
      { label: "Save Scan…", key: "Ctrl+S", run: () => siteDialog(null, advanced() ? "org" : "standalone"), disabled: !!s || !hasDevices || ui.scanning },
      { sep: true }, { heading: "Open Recent" },
      ...recentScans().map(r => ({ label: recentTitle(r), run: () => openRecent(r), disabled: ui.scanning })),
      { label: "Clear Menu", run: () => { save("recentClearedAt", new Date().toISOString()); }, disabled: !recentScans().length },
    ] : [];
    if (name === "scans") {
      if (!data.sites.length) items.push({ label: "No saved scans yet. Save one after it finishes.", disabled: true });
      sitesByOrganization().forEach(([org, list], i) => {
        if (i) items.push({ sep: true });
        items.push({ heading: org || "Standalone" });
        for (const x of list) items.push({ label: `${x.name}  ·  ${x.range}`, checked: x.id === ui.siteId, run: () => selectSite(x.id) });
      });
    }
    items.push({ sep: true },
      { label: "Edit This Scan…", run: () => siteDialog(s), disabled: !ok(s) },
      { label: "Delete This Scan…", run: () => askDeleteSite(s), disabled: !ok(s) },
      { sep: true },
      { label: "Organizations…", key: "Ctrl+K", run: () => openTool("orgs"), hidden: !advanced() },
      { label: "Edit Scan List…", key: "Ctrl+Alt+S", run: scanListDialog });
    if (name === "file") items.splice(2, 0, { label: "New Organization…", key: "Ctrl+Shift+N", run: () => surveySetupDialog(null), hidden: !advanced() });
    if (name === "file") items.push({ sep: true },
      { label: "Export Scans…", run: exportScansDialog, disabled: !data.sites.length },
      { label: "Import Scans…", run: importScansFile, disabled: ui.scanning });
    if (name === "file") items.push({ sep: true },
      { label: "Export as CSV…", key: "Ctrl+E", run: () => exportRows("csv"), disabled: !visibleRows().length },
      { label: "Export as Excel (.xlsx)…", key: "Ctrl+Shift+E", run: () => exportRows("xlsx"), disabled: !visibleRows().length },
      { sep: true },
      { label: "Wake Remote PC…", key: "Ctrl+Shift+W", run: () => openTool("remotewake"), hidden: !advanced() },
      { label: "Settings…", key: "Ctrl+,", run: () => openTool("settings") },
      { sep: true },
      { label: "Forget Offline Devices…", run: askForgetOffline, disabled: !ok(ui.devices.some(d => !d.isOnline)) },
      { sep: true },
      { label: "Exit", key: "Alt+F4", run: () => T.window?.getCurrentWindow().close() });
    return items;
  }
  if (name === "view") {
    const look = load("appearance", "dark");
    return [
      { label: "Advanced Mode", key: "Ctrl+Alt+B", checked: advanced(), run: () => setMode(advanced() ? "basic" : "advanced") },
      { label: "Show Details", key: "Ctrl+I", checked: ui.showDetails, run: () => setDetails(!ui.showDetails) },
      ...(advanced() ? [{ label: "Mark Addresses Outside DHCP Range", checked: load("markOutsideDHCP", "1") === "1", run: () => { save("markOutsideDHCP", load("markOutsideDHCP", "1") === "1" ? "0" : "1"); render(); } }] : []),
      { label: "Show Offline Devices", checked: $("offline").checked, run: () => { $("offline").checked = !$("offline").checked; offlineChanged(); } },
      { label: "Type Column", checked: showTypeColumn(), run: () => setColumnSetting("showTypeColumn", !showTypeColumn()) },
      { label: "Switch Port Column", checked: showSwitchPortColumn(), run: () => setColumnSetting("showSwitchPortColumn", !showSwitchPortColumn()) },
      { sep: true },
      { label: "Results", checked: ui.tab === "results", run: () => setTab("results") },
      { label: "Favorites", checked: ui.tab === "favorites", run: () => setTab("favorites") },
      ...(advanced() ? [{ label: "History", checked: ui.tab === "history", run: () => setTab("history") },
                        { label: "Map", checked: ui.tab === "map", run: () => setTab("map") }] : []),
      { sep: true }, { heading: "Appearance" },
      { label: "Auto (follow Windows)", checked: look === "auto", run: () => setLook("auto") },
      { label: "Light", checked: look === "light", run: () => setLook("light") },
      { label: "Dark", checked: look === "dark", run: () => setLook("dark") },
    ];
  }
  if (name === "tools") return TOOL_LIST.filter(t => advanced() || !t.advanced).map(t => ({ label: t.label, key: `Ctrl+${t.n}`, run: () => openTool(t.tool) }));
  if (name === "help") return [{ label: "ARPradar Help", key: "F1", run: () => openTool("help") }, { sep: true }, { label: "License", run: licenseDialog }, { label: "About ARPradar", run: aboutDialog }];
  return [];
}

let openMenu = null;
function showMenu(name, anchor) {
  if (openMenu === name) return closeMenu();
  closeMenu();
  openMenu = name;
  anchor.classList.add("open");
  const r = anchor.getBoundingClientRect();
  fillMenu(menuItems(name), r.left, r.bottom + 2);
}
let lastMenuAt = [0, 0];
function showMenuAt(items, x, y) {
  lastMenuAt = [x, y];
  closeMenu();
  openMenu = "context";
  fillMenu(items, x, y);
}
function fillMenu(items, x, y) {
  items = items.filter(it => !it.hidden);
  const m = $("menu");
  m.innerHTML = items.map((it, i) => it.sep ? "<hr>" : it.heading ? `<div class="heading">${esc(it.heading)}</div>` :
    `<button type="button" role="menuitem" data-i="${i}" class="${it.checked ? "checked" : ""}" ${it.disabled ? "disabled" : ""}>${esc(it.label)}${it.key ? `<span class="key">${it.key}</span>` : ""}</button>`).join("");
  m.hidden = false;
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
  m.onclick = e => { const b = e.target.closest("button"); if (!b) return; closeMenu(); items[Number(b.dataset.i)].run?.(); };
}
function closeMenu() {
  $("menu").hidden = true; openMenu = null;
  document.querySelectorAll("[data-menu].open").forEach(b => b.classList.remove("open"));
}
document.querySelectorAll("[data-menu]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); showMenu(b.dataset.menu, b); }));
// Moving across the menu bar while a menu is open switches menus, like Windows.
document.querySelectorAll(".menubar [data-menu]").forEach(b => b.addEventListener("mouseenter", () => { if (openMenu && openMenu !== b.dataset.menu && openMenu !== "scans") showMenu(b.dataset.menu, b); }));
document.addEventListener("click", e => { if (!e.target.closest("#menu")) closeMenu(); });

// MARK: Dialogs

function modal(html, wide) {
  closeMenu();
  const back = document.createElement("div");
  back.className = "backdrop";
  back.innerHTML = `<div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  $("modal-root").appendChild(back);
  const close = () => back.remove();
  back.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  setTimeout(() => back.querySelector("input, button.primary, button")?.focus(), 0);
  return { el: back, close };
}
function showError(text) {
  const m = modal(`<h2>ARPradar</h2><p>${esc(text)}</p><div class="buttons"><button type="button" class="primary">OK</button></div>`);
  m.el.querySelector("button").onclick = m.close;
}
function confirmBox(title, text, action, run) {
  const m = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="danger">${esc(action)}</button></div>`);
  m.el.querySelector("[data-no]").onclick = m.close;
  m.el.querySelector(".danger").onclick = () => { m.close(); run(); };
}
function askDeleteSite(s) {
  if (!s) return;
  confirmBox(`Delete the saved scan “${s.name}”?`, "Its saved devices and last scan are removed. This can’t be undone. Past scans in History stay.",
    "Delete Scan", () => deleteSite(s.id));
}
function askForgetOffline() {
  const n = ui.devices.filter(d => !d.isOnline).length;
  confirmBox(`Forget the ${n} offline device${n === 1 ? "" : "s"}?`, "The red rows are removed from this saved scan’s memory, so they won’t show as offline or count as NEW next time. Favorites are kept. This can’t be undone.", "Forget Offline", forgetOffline);
}
function aboutDialog() {
  const m = modal(`<h2>ARPradar ${esc(appVersion)}</h2><p>A free network scanner. arpradar.com</p><p>Saved data stays on this PC.</p><p>© 2026 Sean O'Neill. Free software under the GNU GPL v3. Source: github.com/saoneill01-a11y/arpradar-windows</p><div class="buttons"><button type="button" data-license>License</button><button type="button" class="primary">OK</button></div>`);
  m.el.querySelector(".primary").onclick = m.close;
  m.el.querySelector("[data-license]").onclick = () => { m.close(); licenseDialog(); };
}
/// Help › License: the GPL notice and full text (ui/license.js, from NOTICE.txt), also the installer.s license page.
function licenseDialog() {
  const text = typeof LICENSE_TEXT === "string" ? LICENSE_TEXT : "© 2026 Sean O'Neill. Free software under the GNU GPL v3.";
  const m = modal(`<h2>License</h2><pre class="license">${esc(text)}</pre><div class="buttons"><button type="button" class="primary">OK</button></div>`, true);
  m.el.querySelector("button").onclick = m.close;
}

/// Save to Organization… (saveTo "org"), Save Standalone… ("standalone") or Edit This Scan… (s given).
/// A scan in an organization takes the organization's name server and DHCP range; a standalone one has its own.
function siteDialog(s, saveTo) {
  const isNew = !s;
  const standaloneOnly = isNew && saveTo === "standalone";
  const pref = [ui.preferredOrgId, currentSite()?.orgID, Orgs.list[0]?.id].find(id => id && Orgs.org(id)) || "__new";
  const v = s || { name: "", range: (ui.rangeText || $("range").value).trim(), nameServer: "", dhcpRange: "", notes: "" };
  const start = s ? (Orgs.org(s.orgID) ? s.orgID : "") : standaloneOnly ? "" : pref;
  const n = ui.devices.filter(d => d.isOnline).length;
  const m = modal(`<h2>${s ? "Edit saved scan" : standaloneOnly ? "Save Standalone" : "Save to Organization"}</h2>
    ${isNew ? `<p>The ${n} device${n === 1 ? "" : "s"} in Results are saved with it. Pick it from Saved Scans later to see them and scan that network again.</p>` : ""}
    ${standaloneOnly ? "" : `<div class="field"><label for="f-org">Organization</label><select id="f-org">
      ${isNew ? "" : `<option value="">Standalone (no organization)</option>`}
      ${Orgs.list.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}
      <option value="__new">New Organization…</option></select></div>
    <div id="f-neworg" style="display:flex;flex-direction:column;gap:10px">
      <div class="field"><label for="f-orgnew">Organization name</label><input id="f-orgnew" placeholder="e.g. Example Dental"></div>
      <div class="field"><label for="f-orgdom">Domains</label><input id="f-orgdom" class="mono" placeholder="Optional, e.g. example.com" spellcheck="false"></div></div>`}
    <div class="field"><label for="f-name">Scan name</label><input id="f-name" value="${esc(v.name)}"></div>
    <div class="field"><label for="f-range">IP range</label><input id="f-range" class="mono" value="${esc(v.range)}" placeholder="10.0.0.0/24" spellcheck="false"></div>
    <div id="f-inherit" class="inherit"></div>
    <div id="f-own" style="display:flex;flex-direction:column;gap:10px">
      <div class="field"><label for="f-ns">Name server</label><input id="f-ns" class="mono" value="${esc(v.nameServer || "")}" placeholder="Optional, e.g. 10.0.0.5" spellcheck="false">
        <span class="note">That network’s DNS server (a domain controller, Pi-hole or router). ARPradar asks it for device names. Leave blank to use this PC’s DNS.</span></div>
      <div class="field"><label for="f-dhcp">DHCP range</label><input id="f-dhcp" class="mono" value="${esc(v.dhcpRange || "")}" placeholder="Optional, e.g. 10.0.0.100-10.0.0.199" spellcheck="false">
        <span class="note">The DHCP server’s pool (several allowed, comma-separated). Addresses outside it are tinted when Mark outside DHCP is on.</span></div>
      <div class="field advanced-only"><label for="f-snmp">SNMP community</label><input id="f-snmp" class="mono" value="${esc(v.snmpCommunity || "")}" placeholder="public" spellcheck="false" autocomplete="off">
        <span class="note">Read-only community for asking switches, printers and UPSes their name and model. Only sent on this scan’s network.</span></div>
      <p class="note" id="f-newnote" style="margin:0">These become the new organization’s settings, used by all its scans.</p></div>
    ${isNew ? "" : `<div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" placeholder="VPN name, contact…">${esc(v.notes || "")}</textarea></div>`}
    <div class="error" id="f-error"></div>
    <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary">${isNew ? "Save" : "Done"}</button></div>`);
  const q = sel => m.el.querySelector(sel);
  q("[data-no]").onclick = m.close;
  if (q("#f-org")) q("#f-org").value = start;
  const picked = () => q("#f-org") ? q("#f-org").value : "";
  const update = () => {
    const pick = picked(), org = Orgs.org(pick);
    if (q("#f-neworg")) q("#f-neworg").hidden = pick !== "__new";
    q("#f-own").hidden = !!org;
    q("#f-newnote").hidden = pick !== "__new";
    q("#f-name").placeholder = pick && pick !== "" ? "e.g. Main office" : "e.g. Home";
    q("#f-inherit").hidden = !org;
    if (org) {
      const line = (label, value, blank) => `<div class="field"><span class="label">${label}</span><div><span class="${value ? "mono" : ""}">${esc(value || blank)}</span> <span class="note">from ${esc(org.name)}</span></div></div>`;
      q("#f-inherit").innerHTML = line("Name server", String(org.nameServer || "").trim(), "This PC’s DNS") + line("DHCP range", String(org.dhcpRange || "").trim(), "Not set") + line("SNMP community", String(org.snmpCommunity || "").trim(), "public")
        + `<p class="note" style="margin:0">Change these in the organization’s settings. <button type="button" class="linkbtn" id="f-openorg">Open ${esc(org.name)}…</button></p>`;
      q("#f-openorg").onclick = () => openTool("orgs", org.id);
    }
  };
  if (q("#f-org")) q("#f-org").onchange = update;
  update();
  setTimeout(() => (picked() === "__new" ? q("#f-orgnew") : q("#f-name")).focus(), 0);
  const submit = async () => {
    const pick = picked(), org = Orgs.org(pick);
    const f = { name: q("#f-name").value.trim(), range: q("#f-range").value.trim(), nameServer: q("#f-ns").value.trim(),
                dhcpRange: q("#f-dhcp").value.trim(), snmpCommunity: q("#f-snmp").value.trim(), notes: q("#f-notes") ? q("#f-notes").value : (s?.notes || "") };
    const err = await checkSiteFields(f, s, !org);
    if (err) return (q("#f-error").textContent = err);
    if (pick === "__new") {
      const nm = q("#f-orgnew").value.trim();
      if (!nm) return (q("#f-error").textContent = "Give the new organization a name.");
      const ns = f.nameServer, dh = f.dhcpRange, sc = f.snmpCommunity, doms = Orgs.parseDomains(q("#f-orgdom").value);
      f.orgID = await Orgs.mutate(d => {
        const o = { id: Orgs.newId(), name: Orgs.uniqueName(nm, d.orgs), domains: doms, nameServer: ns, dhcpRange: dh, snmpCommunity: sc, notes: "", created: new Date().toISOString() };
        d.orgs.push(o); return o.id;
      });
      f.nameServer = ""; f.dhcpRange = ""; f.snmpCommunity = "";
    } else {
      f.orgID = org ? org.id : null;
      if (isNew && org) { f.nameServer = ""; f.dhcpRange = ""; f.snmpCommunity = ""; }   // a new scan in an organization uses its settings
    }
    if (isNew) {
      const x = createSite(f, true);
      ui.siteId = x.id; ui.offerSave = false; ui.autoFileOrgId = null;
      setProgress(null, `Saved as “${x.name}”`);
      noteServersForOrganization();
    } else {
      const renamed = s.name !== f.name;
      Object.assign(s, f);
      if (renamed && s.lastScan) s.lastScan.siteName = f.name;
      persist();
      if (s.id === ui.siteId) $("range").value = s.range;
    }
    m.close(); render();
  };
  q(".primary").onclick = submit;
  m.el.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName === "INPUT") submit(); });
}
async function checkSiteFields(f, s, ownSettings = true) {
  if (!f.name) return "Give it a name.";
  if (data.sites.some(x => x.name.toLowerCase() === f.name.toLowerCase() && x !== s)) return "There’s already a saved scan with that name.";
  try { await invoke("parse_range", { text: f.range }); } catch (e) { return String(e); }
  if (!ownSettings) return "";
  if (f.nameServer && !/^\d{1,3}(\.\d{1,3}){3}$/.test(f.nameServer)) return "The name server should be an IP address, like 10.0.0.10.";
  if (f.dhcpRange) { try { await invoke("parse_range", { text: f.dhcpRange }); } catch { return "That DHCP range isn’t valid. Use start-end, e.g. 10.0.0.100-199."; } }
  return "";
}

/// Edit Scan List: every saved scan, with delete, duplicate, clear devices and live editing.
function scanListDialog() {
  let picked = new Set(ui.siteId ? [ui.siteId] : data.sites[0] ? [data.sites[0].id] : []);
  const m = modal(`<h2>Scan List</h2><div class="sl-sort">Sort by <div class="segmented small"><button type="button" data-sort="name">Name</button><button type="button" data-sort="org">Organization</button></div></div><div class="scanlist"><div class="scanlist-items" id="sl-items"></div><div class="scanlist-edit" id="sl-edit"></div></div>
    <div class="buttons"><button type="button" id="sl-new" class="left">New Scan</button><button type="button" id="sl-dup">Duplicate</button>
    <button type="button" id="sl-clear">Clear Devices…</button><button type="button" id="sl-del">Delete…</button><button type="button" class="primary" id="sl-done">Done</button></div>`, true);
  const q = sel => m.el.querySelector(sel);
  const orgName = s => Orgs.org(s.orgID)?.name || "";
  const label = s => `${esc(s.name)}<small>${esc(orgName(s) || "Standalone")} · ${esc(s.range)} · ${Object.keys(s.known).length} devices</small>`;
  // Sort by name, or by organization (grouped under headings, standalone scans last).
  let sortBy = load("scanListSort", "name");
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const byOrg = (a, b) => (!orgName(a) - !orgName(b)) || orgName(a).localeCompare(orgName(b), undefined, { sensitivity: "base" }) || byName(a, b);
  const sorted = () => [...data.sites].sort(sortBy === "org" ? byOrg : byName);
  const draw = () => {
    picked = new Set([...picked].filter(site));
    m.el.querySelectorAll("[data-sort]").forEach(b => b.classList.toggle("on", b.dataset.sort === sortBy));
    let lastOrg = null;
    q("#sl-items").innerHTML = sorted().map(s => {
      const head = sortBy === "org" && orgName(s) !== lastOrg ? `<div class="sl-group">${esc(orgName(s) || "Standalone")}</div>` : "";
      lastOrg = orgName(s);
      return head + `<button type="button" data-id="${esc(s.id)}" class="${picked.has(s.id) ? "on" : ""}">${label(s)}</button>`;
    }).join("") || `<p style="padding:12px">No saved scans yet.</p>`;
    const one = picked.size === 1 ? site([...picked][0]) : null;
    q("#sl-edit").innerHTML = one ? `
      <div class="field"><label for="sl-name">Name</label><input id="sl-name" value="${esc(one.name)}"></div>
      <div class="field"><label for="sl-range">IP range</label><input id="sl-range" class="mono" value="${esc(one.range)}" spellcheck="false"></div>
      <div class="field"><label for="sl-org">Organization</label>${orgSelect("sl-org", one.orgID || "", false)}</div>
      <div class="field advanced-only"><label for="sl-ns">Name server (optional)</label><input id="sl-ns" class="mono" value="${esc(one.nameServer)}" spellcheck="false"></div>
      <div class="field advanced-only"><label for="sl-dhcp">DHCP range (optional)</label><input id="sl-dhcp" class="mono" value="${esc(one.dhcpRange || "")}" placeholder="e.g. 10.0.0.100-10.0.0.199" spellcheck="false"></div>
      <div class="field advanced-only"><label for="sl-snmp">SNMP community</label><input id="sl-snmp" class="mono" value="${esc(one.snmpCommunity || "")}" placeholder="public" spellcheck="false" autocomplete="off"></div>
      <div class="field"><label for="sl-notes">Notes</label><textarea id="sl-notes">${esc(one.notes)}</textarea></div>
      <p>${one.lastScan ? "Last scan " + esc(fmtDate(one.lastScan.date)) : "Not scanned yet"}</p><div class="error" id="sl-error"></div>`
      : `<p>${picked.size ? `${picked.size} saved scans selected.` : "Pick a saved scan on the left. Ctrl+click picks several."}</p>`;
    q("#sl-dup").disabled = !one; q("#sl-clear").disabled = !picked.size; q("#sl-del").disabled = !picked.size;
    q("#sl-edit").oninput = null;
    if (one) {
      let t;
      q("#sl-edit").oninput = () => { clearTimeout(t); t = setTimeout(async () => {
        const f = { name: q("#sl-name").value.trim(), range: q("#sl-range").value.trim(), nameServer: q("#sl-ns").value.trim(), notes: q("#sl-notes").value, orgID: q("#sl-org").value || null, dhcpRange: q("#sl-dhcp").value.trim(), snmpCommunity: q("#sl-snmp").value.trim() };
        const err = await checkSiteFields(f, one);
        q("#sl-error").textContent = err;
        if (err) return;
        if (one.name !== f.name && one.lastScan) one.lastScan.siteName = f.name;
        Object.assign(one, f); persist(); render();
        const item = q(`#sl-items [data-id="${CSS.escape(one.id)}"]`);
        if (item) item.innerHTML = label(one);
      }, 500); };
    }
  };
  m.el.querySelectorAll("[data-sort]").forEach(b => b.onclick = () => { sortBy = b.dataset.sort; save("scanListSort", sortBy); draw(); });
  q("#sl-items").onclick = e => {
    const b = e.target.closest("[data-id]"); if (!b) return;
    if (e.ctrlKey || e.metaKey) picked.has(b.dataset.id) ? picked.delete(b.dataset.id) : picked.add(b.dataset.id);
    else picked = new Set([b.dataset.id]);
    draw();
  };
  q("#sl-new").onclick = () => { const s = createSite({ name: uniqueName("New scan"), range: $("range").value.trim() || "192.168.1.1-254" }, false); picked = new Set([s.id]); draw(); render(); };
  q("#sl-dup").onclick = () => {
    const one = site([...picked][0]);
    const copy = { ...structuredClone(one), id: newId(), name: uniqueName(one.name + " copy") };
    data.sites.push(copy); persist(); picked = new Set([copy.id]); draw(); render();
  };
  q("#sl-clear").onclick = () => confirmBox("Clear their saved devices?", "Offline rows and NEW badges start over from the next scan. This can’t be undone.", "Clear Devices", () => {
    for (const id of picked) { const s = site(id); if (s) { s.known = {}; s.lastScan = null; } }
    persist(); draw(); if (picked.has(ui.siteId)) showLastScan();
  });
  q("#sl-del").onclick = () => confirmBox(`Delete ${picked.size} saved scan${picked.size === 1 ? "" : "s"}?`, "Their saved devices and last scans are removed. This can’t be undone. Past scans in History stay.", "Delete", () => {
    for (const id of picked) deleteSite(id);
    picked = new Set(); draw();
  });
  q("#sl-done").onclick = m.close;
  draw();
}

// MARK: Tools (each opens in its own window)

const TOOL_LIST = [
  { n: 1, tool: "ping", label: "Ping…" }, { n: 2, tool: "trace", label: "Traceroute…", advanced: true },
  { n: 3, tool: "dns", label: "DNS Lookup…", advanced: true }, { n: 4, tool: "wifi", label: "Wi-Fi Signal" },
  { n: 5, tool: "analyzer", label: "Wi-Fi Analyzer", advanced: true }, { n: 6, tool: "connection", label: "Connection Info" },
  { n: 7, tool: "speed", label: "Speed Test" }, { n: 8, tool: "subnet", label: "Subnet Calculator", advanced: true },
];
function openTool(tool, arg) { invoke("open_tool", { tool, arg: arg ?? null }).catch(e => showError(String(e))); }

// MARK: Details panel, right-click menu, actions

function setDetails(on) { ui.showDetails = on; save("showDetails", on ? "1" : "0"); renderDetails(); }
const NAME_SOURCES = ["NetBIOS", "Bonjour", "DNS", "UPnP", "SNMP", "UniFi"];
const ipv6Kind = a => /^fe[89ab]/i.test(a) ? "Link" : /^f[cd]/i.test(a) ? "Local" : "Global";
const selectedDevice = () => ui.selection.size === 1 ? shown.find(d => ui.selection.has(d.ip)) : null;

function renderDetails() {
  const el = $("details");
  const show = ui.showDetails && ui.tab !== "map";   // the Map tab has its own side panel
  el.hidden = !show;
  $("detailsgrip").hidden = !show;
  if (!show) return;
  const d = selectedDevice();
  if (!d) { el.innerHTML = `<p class="none">${ui.selection.size > 1 ? `${ui.selection.size} devices selected.` : "Select a device to see its details."}</p>`; return; }
  if (d.isOnline && ui.tab !== "history") loadExtras(d);
  const adv = advanced();
  const rows = (list, mono) => {
    const shownRows = list.filter(r => r[1]);
    return shownRows.length ? `<dl>${shownRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ""}>${esc(v)}</dd>`).join("")}</dl>` : "";
  };
  const section = (title, body, empty) => body ? `<h4>${title}</h4>${body}` : empty ? `<h4>${title}</h4><p class="none">${empty}</p>` : "";
  const sub = [d.ip, d.isOnline ? "online" : "offline", d.isOnline && d.responseMs != null ? `${Math.round(d.responseMs)} ms` : ""].filter(Boolean).join(" · ");
  const banners = typeof ui.banners[d.ip] === "object" ? ui.banners[d.ip] : d.banners || {};
  let html = `<h3>${esc(d.name || "(no name)")}${d.isNew && d.isOnline ? '<span class="badge new">NEW</span>' : ""}</h3>
    <div class="sub"><span class="dot${d.isOnline ? "" : " off"}"></span>${esc(sub)}</div>`;
  if (adv && ui.dhcp) html += inSpans(d.ip, ui.dhcp.spans) ? '<span class="dhcpnote note">Inside DHCP range</span>' : '<span class="dhcpnote out">Outside DHCP range (static or reserved)</span>';
  html += rows([["Type", kindLabel(d)], ["MAC", d.mac], ["Maker", d.vendor], ["First seen", d.firstSeen ? fmtDate(d.firstSeen) : ""],
                ["Last seen", d.isOnline ? "This scan" : d.lastSeen ? fmtDate(d.lastSeen) : ""], ["Comment", data.comments[keyOf(d)] || ""]]);
  const link = switchLinkOf(d);
  if (link) html += section("PLUGGED INTO", rows(link.wireless
    ? [["Access point", link.device], ["Network", link.ssid], ["Signal", link.signal != null ? `${link.signal} dBm` : ""]]
    : [["Switch", link.device], ["Port", link.port != null ? String(link.port) : ""], ["Speed", link.mbps > 0 ? mapSpeed(link.mbps) : ""],
       ["Note", link.viaUnmanaged ? "Behind an unmanaged switch on that port" : ""]]));
  if (adv && d.ipv6?.length) html += section("IPv6", rows(d.ipv6.map(a => [ipv6Kind(a), a]), true));
  html += sharesSection(d);
  if (adv) {
    html += section("NAMES", rows(NAME_SOURCES.map(s => [s, d.names?.[s] || ""])));
    html += section("WHAT IT IS", rows([["Web page", d.webTitle], ["UPnP", d.upnp], ["SNMP name", d.snmpName], ["SNMP", d.snmpDescr], ["Location", d.snmpLocation], ["Ubiquiti", d.ubntModel], ["Firmware", d.ubntFirmware]]),
                    "Nothing answered (web page, UPnP, SNMP, Ubiquiti).");
    const loading = ui.banners[d.ip] === "loading";
    html += section("OPEN PORTS", rows((d.openPorts || []).map(p => [String(p), [services.get(p) || "unknown service", banners[p]].filter(Boolean).join(" · ")])),
                    "None of the usual ports are open.") + (loading ? '<p class="none">Reading what answers…</p>' : "");
  } else {
    html += section("WHAT IT IS", rows([["Web page", d.webTitle], ["Model", d.snmpDescr || describe(d)]]));
  }
  // Actions: the same things as the right-click menu.
  const p = d.openPorts || [], off = !d.isOnline ? " disabled" : "";
  const web = p.some(x => [80, 443, 8080, 8443].includes(x)), shares = p.some(x => [139, 445].includes(x));
  const btn = (key, label, title, extra = "") => `<button type="button" data-do="${key}" title="${esc(title)}"${extra}>${label}</button>`;
  html += section("ACTIONS", `<div class="actions">`
    + btn("web", "Open in Browser", web ? "Open its web page" : "No web port was seen open; tries http:// anyway", off)
    + btn("shares", "Shares", shares ? "Open its shared folders in File Explorer" : "No file-sharing port was seen open", off)
    + (adv ? btn("ssh", "SSH", "SSH in Terminal", off) + btn("rdp", "RDP", "Remote Desktop", off) + btn("ports", "Scan Ports…", "Opens in its own window", off) : "")
    + btn("ping", "Ping", "Ping it in the Ping tool")
    + btn("wake", "Wake", "Wake on LAN", d.mac ? "" : " disabled")
    + btn("copyip", "Copy IP", "Copy its IP address") + btn("copymac", "Copy MAC", "Copy its MAC address", d.mac ? "" : " disabled")
    + btn("copy", "Copy All", "Copy everything shown here") + `</div>`);
  el.innerHTML = html;
  el.onclick = e => {
    const b = e.target.closest("[data-do], [data-share]"); if (!b) return;
    if (b.dataset.share) return act("share", `${d.ip}\\${b.dataset.share}`);
    const name = d.name || d.ip;
    ({ web: () => act("web", webUrl(d)), shares: () => act("shares", d.ip), ssh: () => act("ssh", d.ip), rdp: () => act("rdp", d.ip),
       ports: () => portScanDialog(d), ping: () => openTool("ping", d.ip), wake: () => wake([d]),
       copyip: () => copyText(d.ip, `Copied ${d.ip}`), copymac: () => copyText(d.mac, `Copied ${d.mac}`),
       copy: () => copyText(detailsText(d), `Copied the details of ${name}`) }[b.dataset.do] || (() => {}))();
  };
}

function sharesSection(d) {
  if (!d.isOnline || !(d.openPorts || []).some(p => [139, 445, 2049].includes(p))) return "";
  const info = ui.shares[d.ip];
  if (!info || info === "loading") return `<h4>SHARES</h4><p class="none">Listing shares…</p>`;
  let body = info.smb.map(s => `<dt>${esc(s.name)}</dt><dd><button type="button" class="linkbtn" data-share="${esc(s.name)}" title="Open \\\\${esc(d.ip)}\\${esc(s.name)}">Open</button>${s.comment ? ` · ${esc(s.comment)}` : ""}</dd>`).join("")
    + info.nfs.map(p => `<dt>NFS</dt><dd class="mono">${esc(p)}</dd>`).join("");
  if (body) body = `<dl>${body}</dl>`;
  if (!info.smb.length && info.problem) body += `<p class="none">${esc(info.problem)} · <button type="button" class="linkbtn" data-do="shares">Open in Explorer</button></p>`;
  return `<h4>SHARES</h4>${body || '<p class="none">No shared folders.</p>'}`;
}

/// Banners and shares are read when the panel shows a device (not during the scan), once per device.
function loadExtras(d) {
  const ip = d.ip;
  if (advanced() && !(ip in ui.banners) && d.openPorts?.length) {
    ui.banners[ip] = "loading";
    invoke("device_banners", { ip, ports: d.openPorts }).then(b => { ui.banners[ip] = b; if (byIp.get(ip)) byIp.get(ip).banners = b; renderDetails(); })
      .catch(() => { ui.banners[ip] = {}; renderDetails(); });
  }
  if (!(ip in ui.shares) && (d.openPorts || []).some(p => [139, 445, 2049].includes(p))) {
    ui.shares[ip] = "loading";
    invoke("list_shares", { ip }).then(s => { ui.shares[ip] = s; renderDetails(); })
      .catch(e => { ui.shares[ip] = { smb: [], nfs: [], problem: String(e) }; renderDetails(); });
  }
}

function detailsText(d) {
  const lines = [`${d.name || "(no name)"} – ${d.ip} · ${d.isOnline ? "online" : "offline"}`];
  const b = typeof ui.banners[d.ip] === "object" ? ui.banners[d.ip] : d.banners || {};
  const all = [["Type", kindLabel(d)], ["MAC", d.mac], ["Maker", d.vendor], ...NAME_SOURCES.map(s => [`${s} name`, d.names?.[s] || ""]),
    ["Web page", d.webTitle], ["UPnP", d.upnp], ["SNMP name", d.snmpName], ["SNMP", d.snmpDescr], ["Location", d.snmpLocation], ["Ubiquiti", d.ubntModel], ["Firmware", d.ubntFirmware],
    ...(d.openPorts || []).map(p => [`Port ${p}`, [services.get(p), b[p]].filter(Boolean).join(" · ")])];
  const link = switchLinkOf(d);
  if (link) lines.push(`Plugged into: ${switchLinkHelp(link)}`);
  lines.push(...(d.ipv6 || []).map(a => `IPv6 (${ipv6Kind(a)}): ${a}`));
  const sh = ui.shares[d.ip];
  if (sh && sh !== "loading") lines.push(...sh.smb.map(s => `Share: ${s.name}${s.comment ? ` – ${s.comment}` : ""}`), ...sh.nfs.map(p => `NFS export: ${p}`));
  lines.push(...all.filter(r => r[1]).map(([k, v]) => `${k}: ${v}`));
  return lines.join("\n");
}

/// Copies, then says what was copied in the status bar ("Copied 10.0.0.5").
async function copyText(text, note = "Copied") {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  setProgress(null, note);
}

function webUrl(d, port) {
  const p = d.openPorts || [];
  if (port) return `${[443, 8443, 4443, 7443, 9443, 5001, 8843].includes(port) ? "https" : "http"}://${d.ip}${[80, 443].includes(port) ? "" : ":" + port}`;
  if (p.includes(443)) return `https://${d.ip}`;
  if (p.includes(80)) return `http://${d.ip}`;
  if (p.includes(8443)) return `https://${d.ip}:8443`;
  if (p.includes(8080)) return `http://${d.ip}:8080`;
  return `http://${d.ip}`;
}
function act(kind, target) { invoke("open_device", { kind, target }).catch(e => showError(String(e))); }

function deviceMenu(picked) {
  const items = [];
  const adv = advanced();
  if (picked.length === 1) {
    const d = picked[0];
    items.push({ label: "Open in Browser", run: () => act("web", webUrl(d)) },
               { label: "Open Shares in Explorer", run: () => act("shares", d.ip) });
    if (adv) items.push({ label: "SSH in Terminal", run: () => act("ssh", d.ip) },
                        { label: "Remote Desktop (RDP)", run: () => act("rdp", d.ip) },
                        { label: "Screen Sharing (VNC)", run: () => act("vnc", d.ip) });
    items.push({ sep: true });
    if (adv) items.push({ label: "Scan Ports…", run: () => portScanDialog(d) });
    items.push({ label: "Ping", run: () => openTool("ping", d.ip) });
    if (adv) items.push({ label: "Traceroute", run: () => openTool("trace", d.ip) }, { label: "DNS Lookup", run: () => openTool("dns", d.ip) });
    if (adv) items.push({ label: "Save for Remote Wake…", run: () => saveForRemoteWake(d), disabled: !d.mac });
    items.push({ label: "Show Details", key: "Ctrl+I", run: () => setDetails(true) }, { sep: true });
  }
  const allFav = picked.every(isFav);
  const what = picked.length === 1 ? "" : ` (${picked.length})`;
  items.push(
    { label: picked.length > 1 ? `Wake on LAN (${picked.length})` : "Wake on LAN", disabled: picked.every(d => !d.mac), run: () => wake(picked) },
    { label: allFav ? "Remove from Favorites" : "Add to Favorites", run: () => setFavorites(picked, !allFav) },
    { label: "Type ▸", run: () => setTimeout(() => showMenuAt(typeMenu(picked), ...lastMenuAt), 0) },
    { sep: true },
    { label: "Copy IP", run: () => copyText(picked.map(d => d.ip).join("\n"), `Copied IP${what}`) },
    { label: "Copy MAC", run: () => copyText(picked.map(d => d.mac).join("\n"), `Copied MAC${what}`) },
    { label: "Copy Row", run: () => copyText(picked.map(d => [d.name, kindLabel(d), d.ip, d.mac, d.vendor, describe(d), portsText(d), data.comments[keyOf(d)] || ""].map(tsvCell).join("\t")).join("\n"), `Copied row${what}`) });
  const offline = picked.filter(d => !d.isOnline);
  if (ui.tab === "results" && offline.length) items.push({ sep: true }, { label: offline.length === 1 ? "Forget This Device" : `Forget ${offline.length} Offline Devices`, run: () => forgetDevices(offline) });
  return items;
}
/// Right-click › Type: Automatic goes back to the guess.
function typeMenu(picked) {
  const set = picked.map(d => data.types[keyOf(d)] || null);
  const auto = picked.length === 1 ? DeviceType.guess(picked[0], { mapKind: mapKindOf(picked[0]), isDhcp: ui.servers.dhcp === picked[0].ip }) : null;
  return [{ heading: "Type" },
    { label: "Automatic" + (auto ? ` (${DEVICE_KINDS[auto]})` : ""), checked: set.every(x => !x), run: () => setType(picked, null) },
    { sep: true },
    ...Object.entries(DEVICE_KINDS).map(([k, label]) => ({ label, checked: set.every(x => x === k), run: () => setType(picked, k) }))];
}
/// Right-click › Save for Remote Wake…: adds the device to the Wake Remote PC list (or finds it there) and opens it.
async function saveForRemoteWake(d) {
  let list = [];
  try { list = JSON.parse(await invoke("load_file", { name: "remote-wake" }) || "[]"); } catch {}
  let t = list.find(x => d.mac && x.mac === d.mac);
  if (!t) {
    const a = ui.adapters.find(a => { const p = a.prefix, m = p === 0 ? 0 : (~0 << (32 - p)) >>> 0; return ((ipNum(a.address) & m) >>> 0) === ((ipNum(d.ip) & m) >>> 0); });
    t = { id: newId().toUpperCase(), name: d.name, site: currentSite()?.name || "", mac: d.mac, ip: d.ip, prefix: a ? a.prefix : 24,
          sendToIP: true, sendToBroadcast: true, useRelay: false, relay: "", port: 9, checkAfter: true };
    list.push(t);
    await invoke("save_file", { name: "remote-wake", json: JSON.stringify(list, null, 2) }).catch(e => showError(String(e)));
  }
  openTool("remotewake", t.id);
}

function setFavorites(list, on) {
  for (const d of list) {
    const k = keyOf(d);
    if (on && !data.favorites.includes(k)) { data.favorites.push(k); if (!data.known[k]) data.known[k] = clean(d); }
    if (!on) data.favorites = data.favorites.filter(x => x !== k);
  }
  persist(); render();
}
async function wake(list) {
  try {
    const n = await invoke("wake_on_lan", { macs: list.map(d => d.mac).filter(Boolean) });
    setProgress(null, `Wake-on-LAN sent to ${n} device${n === 1 ? "" : "s"}`);
  } catch (e) { showError(String(e)); }
}

// MARK: Scan Ports

/// Scan Ports… opens in its own window (one per device), so the main window stays usable while it runs.
/// autoOrg: started from an organization's page, so each finished scan is filed there.
function portScanDialog(d, autoOrg) {
  if (autoOrg) OrgLaunch.mark(autoOrg);
  const arg = JSON.stringify({ ip: d.ip, name: d.name || "", site: currentSite()?.name || "" });
  invoke("open_tool", { tool: "ports", arg }).catch(e => showError(String(e)));
}
/// The table's Open ports column only shows the usual 15; the details panel shows every port found here.
function addPortScan(d, open, banners) {
  const live = byIp.get(d.ip) || d;
  live.openPorts = [...new Set([...(live.openPorts || []), ...open])].sort((a, b) => a - b);
  live.banners = { ...(live.banners || {}), ...banners };
  ui.banners[d.ip] = live.banners;
  // Remember them with the saved copies of this device (same IP only: two devices can share a MAC).
  const k = keyOf(live);
  for (const store of [data.known, currentSite()?.known].filter(Boolean)) {
    if (store[k]?.ip === live.ip) store[k] = { ...store[k], openPorts: live.openPorts, banners: live.banners };
  }
  persist(); render();
}

// MARK: Organizations: actions from other windows, and the site survey (the Mac's SurveySetupView / SurveyRunner)

function newScanForOrg(orgId) { if (ui.scanning) return showError("Wait for the scan to finish first."); newScan(orgId); }
/// The organization page's New Port Scan: ask for an address, then scan it (saved there when it finishes).
function portScanForOrg(orgId) {
  const o = Orgs.org(orgId); if (!o) return;
  const m = modal(`<h2>New port scan · ${esc(o.name)}</h2><div class="field"><label for="ps-ip">IP address</label><input id="ps-ip" class="mono" placeholder="10.0.0.10" spellcheck="false"></div>
    <p class="note" style="margin:0">When it finishes it’s saved to ${esc(o.name)}.</p><div class="error" id="ps-err"></div>
    <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary">Next…</button></div>`);
  const q = sel => m.el.querySelector(sel);
  q("[data-no]").onclick = m.close;
  const go = () => {
    const ip = q("#ps-ip").value.trim();
    if (!isIPv4(ip)) return (q("#ps-err").textContent = "Type an IP address, like 10.0.0.10.");
    m.close();
    const known = byIp.get(ip);
    portScanDialog(known || { ...device(ip), name: "" }, orgId);
  };
  q(".primary").onclick = go;
  q("#ps-ip").onkeydown = e => { if (e.key === "Enter") go(); };
}
function detachOrg(orgId) { for (const s of data.sites) if (s.orgID === orgId) s.orgID = null; persist(); render(); }
/// Starts a scan of `range` and resolves true when it finishes (false if stopped).
function runScanAwait(range) {
  if (ui.scanning) return Promise.resolve(false);
  $("range").value = range;
  return new Promise(res => { ui.scanWaiters.push(res); startScan().then(() => { if (!ui.scanning) { ui.scanWaiters = ui.scanWaiters.filter(w => w !== res); res(false); } }); });
}

const SURVEY_STEPS = [
  ["connection", "Connection Info (DHCP, DNS, gateway, public IP)", "Connection Info"],
  ["wifi", "Wi-Fi signal and nearby networks", "Wi-Fi"],
  ["scan", "Network scan", "Network scan"],
  ["speed", "Speed test", "Speed test"],
  ["dns", "DNS lookup (All) for each domain", "DNS lookups"],
  ["expiry", "Domain registration and HTTPS certificate expiry for each domain", "Expiry"],
  ["trace", "Traceroute to 1.1.1.1", "Traceroute to 1.1.1.1"],
];

/// orgId null = File › New Organization…; otherwise the organization's Run Survey….
async function surveySetupDialog(orgId) {
  await Orgs.load();
  const org = Orgs.org(orgId);
  const orgSites = org ? data.sites.filter(s => s.orgID === org.id).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const adapter = currentAdapter();
  const curSite = currentSite();
  const startSite = curSite && org && curSite.orgID === org.id ? curSite.id : orgSites[0]?.id || "";
  const m = modal(`<h2>${org ? `Run a site survey · ${esc(org.name)}` : "New organization"}</h2>
    ${org ? "" : `<div class="field"><label for="sv-name">Name</label><input id="sv-name" placeholder="Client A, Head office, Lincoln High…"></div>
      <div class="field"><label for="sv-domains">Domain name(s)</label><input id="sv-domains" class="mono" placeholder="example.com, example.org" spellcheck="false"></div>
      <div class="field"><label for="sv-notes">Notes</label><textarea id="sv-notes"></textarea></div>`}
    ${orgSites.length ? `<div class="field"><label for="sv-site">Scan</label><select id="sv-site" style="height:30px;border:1px solid var(--edge);border-radius:5px;background:var(--input)">
      ${orgSites.map(s => `<option value="${esc(s.id)}" ${s.id === startSite ? "selected" : ""}>${esc(s.name)} – ${esc(s.range)}</option>`).join("")}<option value="">New scan (this network)</option></select></div>` : ""}
    <div id="sv-new" style="display:flex;flex-direction:column;gap:10px">
      <div class="field"><label for="sv-sname">Scan name</label><input id="sv-sname" value="${orgSites.length ? "" : "Main office"}" placeholder="Main office"></div>
      <div class="field"><label for="sv-range">IP range</label><input id="sv-range" class="mono" value="${esc(adapter?.suggestedRange || $("range").value)}" spellcheck="false"></div>
      <div class="field"><label for="sv-ns">Name server (optional)</label><input id="sv-ns" class="mono" placeholder="e.g. the domain controller" spellcheck="false"></div>
      <div class="field"><label for="sv-dhcp">DHCP range (optional)</label><input id="sv-dhcp" class="mono" placeholder="e.g. 10.0.0.100-10.0.0.199" spellcheck="false"></div></div>
    <div class="field"><span class="label">Survey</span>${SURVEY_STEPS.map(([k, label]) => `<label class="check"><input type="checkbox" data-step="${k}" checked> ${label}</label>`).join("")}</div>
    <p class="note" id="sv-note" style="margin:0;font-size:12px"></p>
    <div class="error" id="sv-error"></div>
    <div class="buttons"><button type="button" data-no>Cancel</button>${org ? "" : '<button type="button" id="sv-save">Save Only</button>'}<button type="button" class="primary" id="sv-go">${org ? "Run Survey" : "Save and Run Survey"}</button></div>`, true);
  const q = sel => m.el.querySelector(sel);
  const steps = () => [...m.el.querySelectorAll("[data-step]")].filter(c => c.checked).map(c => c.dataset.step);
  const refresh = () => {
    q("#sv-new").hidden = !!(q("#sv-site") && q("#sv-site").value);
    const doms = org ? org.domains : Orgs.parseDomains(q("#sv-domains")?.value || "");
    const notes = [];
    if (steps().includes("dns") && !doms.length) notes.push("No domain names, so the DNS lookups will be skipped.");
    if (steps().includes("expiry") && doms.length) notes.push("Expiry asks rdap.org for each domain\u2019s registration.");
    if (steps().includes("connection")) notes.push("Connection Info looks up the public IP address once, at api.ipify.org.");
    if (steps().includes("speed")) notes.push("The speed test uses Cloudflare’s speed test servers.");
    q("#sv-note").textContent = notes.join(" ");
    q("#sv-go").disabled = !steps().length || ui.scanning || surveyRunning;
  };
  m.el.addEventListener("input", refresh); m.el.addEventListener("change", refresh); refresh();
  q("[data-no]").onclick = m.close;
  /// Makes the organization and/or saved scan; returns [orgId, siteId] or null with an error shown.
  const commit = async () => {
    const err = t => { q("#sv-error").textContent = t; return null; };
    let siteId = q("#sv-site")?.value || "";
    let fields = null;
    if (!siteId) {
      fields = { name: q("#sv-sname").value.trim(), range: q("#sv-range").value.trim(), nameServer: q("#sv-ns").value.trim(), notes: "" };
      if (!fields.name) return err("Give the scan a name.");
      try { await invoke("parse_range", { text: fields.range }); } catch (e) { return err(String(e)); }
      if (fields.nameServer && !isIPv4(fields.nameServer)) return err("The name server must be an IP address.");
      const dhcp = q("#sv-dhcp").value.trim();
      if (dhcp) { try { await invoke("parse_range", { text: dhcp }); } catch { return err("That DHCP range isn’t valid. Use start-end, e.g. 10.0.0.100-199."); } }
      fields.dhcpRange = dhcp;
    }
    let oid = org?.id;
    if (!oid) {
      const name = q("#sv-name").value.trim();
      if (!name) return err("Give the organization a name.");
      oid = await Orgs.mutate(d => {
        const o = { id: Orgs.newId(), name: Orgs.uniqueName(name, d.orgs), domains: Orgs.parseDomains(q("#sv-domains").value), notes: q("#sv-notes").value.trim(),
                    nameServer: fields?.nameServer || "", dhcpRange: fields?.dhcpRange || "", created: new Date().toISOString() };
        d.orgs.push(o); return o.id;
      });
    }
    if (!siteId) {
      // Saved scan names are shared across organizations, so add the organization's name when needed.
      const taken = data.sites.some(s => s.name.toLowerCase() === fields.name.toLowerCase());
      // A new organization keeps the name server and DHCP range itself; an existing one's scan keeps them as a fallback.
      const own = org ? fields : { ...fields, nameServer: "", dhcpRange: "" };
      const s = createSite({ ...own, name: uniqueName(taken ? `${Orgs.org(oid)?.name} – ${fields.name}` : fields.name), orgID: oid }, false);
      persist();
      siteId = s.id;
    }
    return [oid, siteId];
  };
  if (q("#sv-save")) q("#sv-save").onclick = async () => { const r = await commit(); if (r) { m.close(); selectSite(r[1]); } };
  q("#sv-go").onclick = async () => {
    const st = steps(); const r = await commit();
    if (!r) return;
    m.close();
    runSurvey(r[0], r[1], st);
  };
}

/// The organization with a blank name server / DHCP range filled from its first saved scan (by name) that has one.
function filledFromScans(o, sites) {
  const mine = sites.filter(x => x.orgID === o.id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const first = k => mine.map(x => String(x[k] || "").trim()).find(Boolean) || "";
  return { nameServer: String(o.nameServer || "").trim() || first("nameServer"), dhcpRange: String(o.dhcpRange || "").trim() || first("dhcpRange") };
}
function isIPv4(t) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(t) && t.split(".").every(o => Number(o) <= 255); }

let surveyRunning = false, surveyStop = false, surveyView = null;
async function runSurvey(orgId, siteId, kinds) {
  if (surveyRunning) return;
  const site0 = site(siteId);
  if (!site0) return;
  surveyRunning = true; surveyStop = false;
  setBusy("survey", true);
  const surveyId = Orgs.newId();
  const steps = SURVEY_STEPS.filter(([k]) => kinds.includes(k)).map(([k, , short]) => ({ k, short, state: "waiting", text: "" }));
  const orgN = Orgs.org(orgId)?.name || "";
  const draw = () => {
    if (!surveyView || !document.body.contains(surveyView.el)) {
      surveyView = modal(`<h2>Site survey · ${esc(orgN)}${site0.name !== orgN ? `, ${esc(site0.name)}` : ""}</h2><div id="su-steps"></div>
        <div class="buttons"><button type="button" id="su-stop">Stop</button><button type="button" id="su-org">Open Organization</button><button type="button" class="primary" id="su-close">Close</button></div>`, true);
      surveyView.el.querySelector("#su-stop").onclick = () => { surveyStop = true; if (ui.scanning) stopScan(); invoke("job_stop", { key: "survey-speed" }); };
      surveyView.el.querySelector("#su-org").onclick = () => openTool("orgs");
      surveyView.el.querySelector("#su-close").onclick = () => surveyView.close();
    }
    const icon = { waiting: "○", running: "…", done: "✓", failed: "✗", skipped: "–" };
    const cls = { done: "color:var(--green-hi)", failed: "color:var(--red)", skipped: "color:var(--muted)", running: "", waiting: "color:var(--muted)" };
    surveyView.el.querySelector("#su-steps").innerHTML = steps.map(s => `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">
      <span style="width:18px;${cls[s.state]}">${icon[s.state]}</span><b style="width:170px">${esc(s.short)}</b><span style="flex:1;${cls[s.state]}">${esc(s.state === "running" ? "working…" : s.text)}</span></div>`).join("")
      + (surveyRunning ? "" : `<p class="note" style="margin-top:10px">Done. The results are saved under ${esc(orgN)} (Organizations, Ctrl+K).</p>`);
    surveyView.el.querySelector("#su-stop").hidden = !surveyRunning;
  };
  const set = (s, state, text = "") => { s.state = state; s.text = text; draw(); };
  const file = d => d && Orgs.addItem(orgId, d, { siteName: site0.name, surveyID: surveyId });
  draw();
  for (const s of steps) {
    if (surveyStop) { set(s, "skipped", "stopped"); continue; }
    set(s, "running");
    try {
      if (s.k === "connection") {
        const a = currentAdapter() || ui.adapters[0];
        if (!a) { set(s, "failed", "no network connection"); continue; }
        const info = await invoke("connection_info", { id: a.id });
        const pub = await invoke("public_ip").catch(() => "");
        await file(Drafts.connection(connectionRows(info, pub), a.displayName));
        set(s, "done", [`DHCP ${info?.dhcpServer || "—"}`, `gateway ${info?.router || "—"}`, pub && `public ${pub}`].filter(Boolean).join(", "));
      } else if (s.k === "wifi") {
        const st = await invoke("wifi_status").catch(() => ({ state: "unsupported" }));
        let nets = [], problem = "";
        try { nets = await invoke("wifi_scan"); } catch (e) { problem = String(e) === "location" ? "Windows is hiding Wi-Fi details (Location is off for apps)" : String(e); }
        const sig = wifiRows(st);
        if (!sig.length && !nets.length) { set(s, "skipped", problem || "Wi-Fi not connected"); continue; }
        await file(Drafts.wifiNetworks(nets, sig));
        set(s, "done", `${sig.length ? `${st.rssi} dBm on channel ${st.channel}` : "not connected"}, ${nets.length} networks nearby`);
      } else if (s.k === "scan") {
        if (surveyView) surveyView.el.style.display = "none";   // show the scan itself
        selectSite(siteId);
        await new Promise(r => setTimeout(r, 300));
        ui.surveyIdForNextScan = surveyId;
        const ok = await runScanAwait(site(siteId)?.range || site0.range);
        if (surveyView) surveyView.el.style.display = "";
        set(s, ok ? "done" : "failed", ok ? `${ui.devices.filter(d => d.isOnline).length} online · ${site0.range}` : surveyStop ? "stopped" : "didn’t finish");
      } else if (s.k === "speed") {
        const r = await new Promise(res => {
          let un = null;
          T.event.listen("survey-speed", e => { const ev = e.payload; if (ev.kind === "done" || ev.kind === "failed") { un?.(); res(ev); } }).then(f => { un = f; invoke("speed_start", { event: "survey-speed" }); });
        });
        if (r.kind === "done") {
          await file(Drafts.speed({ down: r.downMbps, up: r.upMbps, idle: r.idleMs, loaded: r.loadedMs, date: new Date().toISOString() }, site0.name));
          set(s, "done", `${Math.round(r.downMbps)} down / ${Math.round(r.upMbps)} up Mb/s, ${Math.round(r.idleMs)} ms`);
        } else set(s, "failed", r.message);
      } else if (s.k === "dns") {
        const domains = Orgs.org(orgId)?.domains || [];
        if (!domains.length) { set(s, "skipped", "no domain names"); continue; }
        const parts = [];
        for (const dom of domains) {
          if (surveyStop) break;
          const qs = allQueriesFor(dom);
          const results = new Array(qs.length); let next = 0;
          await Promise.all(Array.from({ length: 16 }, async () => {
            while (next < qs.length && !surveyStop) {
              const i = next++;
              try { const r = await invoke("dns_lookup", { name: qs[i][0], kind: qs[i][1], server: effNameServer(site0) }); results[i] = { asked: qs[i][0], answers: r.answers }; }
              catch { results[i] = { asked: qs[i][0], answers: [] }; }
            }
          }));
          const rows = results.filter(Boolean).flatMap(g => arrangeDns(g.answers, g.asked, true));
          await file(Drafts.dns(dom, "All", effNameServer(site0), rows));
          parts.push(`${dom}: ${rows.filter(a => !a.depth).length}`);
        }
        set(s, "done", parts.join(", ") + " records");
      } else if (s.k === "expiry") {
        const domains = Orgs.org(orgId)?.domains || [];
        if (!domains.length) { set(s, "skipped", "no domain names"); continue; }
        const parts = [];
        for (const dom of domains) {
          if (surveyStop) break;
          const res = await expiryCheck(dom, effNameServer(site0));
          await file(Drafts.expiry(dom, expiryRows(res)));
          const dates = [res.reg.ok ? res.reg.r.expires : null, ...res.certs.map(c => c.expires)].filter(Boolean).sort();
          const soon = dates[0] ? daysLeft(dates[0]) : null;
          parts.push(`${dom}: ${soon == null ? "nothing found" : soon < 0 ? "something has EXPIRED" : `soonest in ${soon} days`}`);
        }
        set(s, "done", parts.join(", "));
      } else if (s.k === "trace") {
        const hops = await invoke("trace_collect", { target: "1.1.1.1" }).catch(() => []);
        await file(Drafts.traceroute("1.1.1.1", hops));
        set(s, hops.length ? "done" : "failed", hops.length ? `${hops.length} hops` : "no answer");
      }
    } catch (e) { set(s, "failed", String(e)); }
  }
  const ok = steps.filter(s => s.state === "done").length;
  await Orgs.addItem(orgId, { kind: "survey", title: `Site survey · ${site0.name}`, summary: `${ok} of ${steps.length} checks${surveyStop ? " (stopped)" : ""}`,
    table: { header: ["Check", "Result"], rows: steps.map(s => [s.short, s.state === "done" ? "✓ " + s.text : s.state === "failed" ? "✗ " + s.text : s.state === "skipped" ? "skipped: " + s.text : ""]), widths: [22, 90] } },
    { siteName: site0.name, surveyID: surveyId });
  surveyRunning = false;
  setBusy("survey", false);
  draw();
}

// DNS "All" questions and CNAME arranging (same as the DNS Lookup window's).
function allQueriesFor(name) {
  const n = name.trim().replace(/^\.+|\.+$/g, "");
  const txt = ["_dmarc", "_mta-sts", "_smtp._tls", "default._bimi", "selector1._domainkey", "selector2._domainkey", "google._domainkey", "k1._domainkey", "default._domainkey", "s1._domainkey", "s2._domainkey"];
  const hosts = DNS_COMMON_HOSTS;
  const srv = ["_ldap._tcp", "_kerberos._tcp", "_kerberos._udp", "_kpasswd._tcp", "_gc._tcp", "_ldap._tcp.dc._msdcs", "_autodiscover._tcp", "_sip._tls", "_sipfederationtls._tcp", "_xmpp-client._tcp", "_caldavs._tcp", "_carddavs._tcp", "_imaps._tcp", "_submission._tcp"];
  return [...["A", "AAAA", "CNAME", "MX", "NS", "SOA", "TXT", "CAA"].map(t => [n, t]), ...txt.map(x => [`${x}.${n}`, "TXT"]), ...hosts.map(x => [`${x}.${n}`, "A"]), ...srv.map(x => [`${x}.${n}`, "SRV"])];
}
function arrangeDns(answers, asked, follow) {
  const norm = x => x.toLowerCase().replace(/^\.+|\.+$/g, "");
  const depth = new Map([[norm(asked), 0]]); const out = [];
  for (const a of answers) {
    const d = depth.get(norm(a.name)); if (d === undefined) continue;
    if (d === 0 || follow) out.push({ ...a, depth: d });
    if (a.type === "CNAME" && !depth.has(norm(a.data))) depth.set(norm(a.data), d + 1);
  }
  return out;
}

// MARK: Export / Import Scans (.arpradar files, shared with the Mac app; format in docs/arpradar-file.md)

const orgName = s => Orgs.org(s?.orgID)?.name || "";
/// A <select> of organizations: Standalone, each organization, and (optionally) New organization….
function orgSelect(id, value, allowNew) {
  return `<select id="${id}" style="height:30px;border:1px solid var(--edge);border-radius:5px;background:var(--input);padding:0 6px">
    <option value="" ${!value ? "selected" : ""}>Standalone (no organization)</option>
    ${Orgs.list.map(o => `<option value="${esc(o.id)}" ${o.id === value ? "selected" : ""}>${esc(o.name)}</option>`).join("")}
    ${allowNew ? `<option value="__new" ${value === "__new" ? "selected" : ""}>New organization…</option>` : ""}</select>`;
}
/// Saved scans grouped by organization name (alphabetical), standalone scans last.
function sitesByOrganization(list = data.sites) {
  const groups = new Map();
  for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    const k = orgName(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === "") - (b[0] === "") || a[0].localeCompare(b[0]));
}

const TRANSFER_FIELDS = ["name", "vendor", "webTitle", "upnp", "snmpName", "snmpDescr", "snmpLocation"];
function toTransfer(d) {
  const out = { ip: d.ip, mac: d.mac || "" };
  for (const f of TRANSFER_FIELDS) out[f] = d[f] || "";
  return { ...out, names: { ...(d.names || {}) }, openPorts: d.openPorts || [], firstSeen: d.firstSeen || null, lastSeen: d.lastSeen || null,
           ipv6: d.ipv6 || [], banners: { ...(d.banners || {}) }, thisComputer: !!d.thisPc };
}
function fromTransfer(x) {
  if (!x || typeof x.ip !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(x.ip)) return null;
  const d = device(x.ip);
  delete d.isNew;
  for (const f of TRANSFER_FIELDS) if (typeof x[f] === "string") d[f] = x[f];
  if (typeof x.mac === "string") d.mac = x.mac.toUpperCase();
  if (x.names && typeof x.names === "object") d.names = Object.fromEntries(Object.entries(x.names).filter(([, v]) => typeof v === "string"));
  if (Array.isArray(x.openPorts)) d.openPorts = x.openPorts.filter(Number.isInteger);
  if (Array.isArray(x.ipv6)) d.ipv6 = x.ipv6.filter(a => typeof a === "string");
  if (x.banners && typeof x.banners === "object") d.banners = Object.fromEntries(Object.entries(x.banners).filter(([, v]) => typeof v === "string"));
  const date = v => typeof v === "string" && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
  d.firstSeen = date(x.firstSeen); d.lastSeen = date(x.lastSeen);
  d.thisPc = !!x.thisComputer;
  return d;
}

function exportScansDialog() {
  let picked = new Set(data.sites.map(s => s.id));
  const m = modal(`<h2>Export Scans</h2><p>Saves the ticked scans to one .arpradar file. Open it with File › Import Scans… in ARPradar on another Mac or PC.</p>
    <div class="scanlist-items" id="ex-list" style="width:auto;max-height:340px"></div>
    <p class="note" style="margin:0;font-size:12px">Each scan brings its settings, remembered devices (for offline rows and NEW badges) and last scan. Favorites, comments and History stay on this computer.</p>
    <div class="error" id="ex-error"></div>
    <div class="buttons"><span class="left" id="ex-count" style="color:var(--muted);align-self:center"></span><button type="button" data-no>Cancel</button><button type="button" class="primary" id="ex-go">Export…</button></div>`, true);
  const q = sel => m.el.querySelector(sel);
  const draw = () => {
    const all = picked.size === data.sites.length;
    q("#ex-list").innerHTML = `<label class="check" style="padding:8px 12px;font-weight:600;border-bottom:1px solid var(--line)"><input type="checkbox" data-all ${all ? "checked" : ""}> All saved scans (${data.sites.length})</label>`
      + sitesByOrganization().map(([org, list]) => `<div style="padding:8px 12px 2px;font-size:11px;font-weight:600;color:var(--muted)">${esc((org || "Standalone").toUpperCase())}</div>`
        + list.map(s => `<label class="check" style="padding:5px 12px 5px 28px"><input type="checkbox" data-id="${esc(s.id)}" ${picked.has(s.id) ? "checked" : ""}><span style="flex:1">${esc(s.name)}</span>
            <span class="mono" style="color:var(--muted);font-size:12px">${esc(s.range)}</span><span style="color:var(--muted);width:90px;text-align:right">${Object.keys(s.known).length} devices</span></label>`).join("")).join("");
    q("#ex-count").textContent = `${picked.size} of ${data.sites.length} selected`;
    q("#ex-go").disabled = !picked.size;
  };
  q("#ex-list").onchange = e => {
    if (e.target.dataset.all !== undefined) picked = e.target.checked ? new Set(data.sites.map(s => s.id)) : new Set();
    else if (e.target.dataset.id) e.target.checked ? picked.add(e.target.dataset.id) : picked.delete(e.target.dataset.id);
    draw();
  };
  q("[data-no]").onclick = m.close;
  q("#ex-go").onclick = async () => {
    const scans = data.sites.filter(s => picked.has(s.id)).map(s => ({
      name: s.name, organization: orgName(s) || null, range: s.range, nameServer: s.nameServer || "", dhcpRange: s.dhcpRange || "", notes: s.notes || "",
      devices: Object.values(s.known).map(toTransfer),
      lastScan: s.lastScan ? { date: s.lastScan.date, range: s.lastScan.range, devices: s.lastScan.devices.map(toTransfer) } : null,
    }));
    const file = { format: "arpradar-scans", version: 1, exported: new Date().toISOString(), app: `ARPradar ${appVersion} for Windows`, scans };
    const orgs = [...new Set(scans.map(x => x.organization).filter(Boolean))];
    const base = (scans.length === 1 ? scans[0].name : orgs.length === 1 ? orgs[0] : "ARPradar") + " scans";
    try {
      const path = await invoke("save_scans_file", { fileName: base.replace(/[\\/:*?"<>|]/g, "-") + ".arpradar", content: JSON.stringify(file, null, 1) });
      if (path) { m.close(); setProgress(null, `Exported ${scans.length} saved scan${scans.length === 1 ? "" : "s"} to ${path}`); }
    } catch (e) { q("#ex-error").textContent = String(e); }
  };
  draw();
}

async function importScansFile() {
  let picked;
  try { picked = await invoke("open_scans_file"); } catch (e) { return showError(String(e)); }
  if (!picked) return;
  const [fileName, text] = picked;
  let file;
  try { file = JSON.parse(text); } catch { return showError(`“${fileName}” isn’t an ARPradar scans file.`); }
  if (file?.format !== "arpradar-scans" || !Array.isArray(file.scans)) return showError(`“${fileName}” isn’t an ARPradar scans file.`);
  if (file.version > 1) return showError("That file comes from a newer ARPradar. Update this one, then try again.");
  const scans = file.scans.filter(x => x && typeof x.name === "string" && x.name.trim() && typeof x.range === "string");
  if (!scans.length) return showError(`“${fileName}” has no saved scans in it.`);
  importScansDialog(fileName, file, scans);
}

function importScansDialog(fileName, file, scans) {
  const exists = x => data.sites.find(s => s.name === x.name.trim());
  // Ticked: everything new; scans that already exist start unticked-safe as "Replace mine".
  // Keep both is the default for a clash: nothing of yours is overwritten unless you choose it.
  const rows = scans.map((x, i) => ({ i, x, on: true, action: exists(x) ? "keep" : "new" }));
  const when = file.exported && !isNaN(Date.parse(file.exported)) ? ` · exported ${fmtDate(file.exported)}` : "";
  const m = modal(`<h2>Import Scans</h2><p>${esc(fileName)}${file.app ? ` · from ${esc(file.app)}` : ""}${esc(when)}</p>
    <div class="tablebox" style="max-height:340px;border:1px solid var(--edge);border-radius:6px;overflow:auto;background:var(--bg)"><table class="ports-table"><thead><tr>
      <th style="width:28px"><input type="checkbox" id="im-all" checked aria-label="All"></th><th>Saved scan</th><th>Range</th><th style="text-align:right">Devices</th><th>Here already?</th></tr></thead><tbody id="im-rows"></tbody></table></div>
    <p class="note" id="im-note" style="margin:0;font-size:12px"></p>
    <div class="buttons"><span class="left" id="im-count" style="color:var(--muted);align-self:center"></span><button type="button" data-no>Cancel</button><button type="button" class="primary" id="im-go">Import</button></div>`, true);
  const q = sel => m.el.querySelector(sel);
  const draw = () => {
    q("#im-rows").innerHTML = rows.map(r => `<tr><td><input type="checkbox" data-i="${r.i}" ${r.on ? "checked" : ""} aria-label="${esc(r.x.name)}"></td>
      <td>${esc(r.x.name)}<br><small style="color:var(--muted)">${esc(r.x.organization || "Standalone")}</small></td>
      <td class="mono" style="color:var(--muted)">${esc(r.x.range)}</td><td style="text-align:right">${Array.isArray(r.x.devices) ? r.x.devices.length : 0}</td>
      <td>${r.action === "new" ? '<span style="color:var(--green-hi)">New</span>' : `<select data-act="${r.i}" style="height:26px;border:1px solid var(--edge);border-radius:5px;background:var(--input)">
        <option value="keep" ${r.action === "keep" ? "selected" : ""}>Keep both</option><option value="replace" ${r.action === "replace" ? "selected" : ""}>Replace mine</option></select>`}</td></tr>`).join("");
    const n = rows.filter(r => r.on).length;
    q("#im-count").textContent = `${n} of ${rows.length} selected`;
    const replacing = rows.filter(r => r.on && r.action === "replace").length;
    q("#im-go").textContent = replacing ? `Import ${n} (${replacing} replace${replacing === 1 ? "s" : ""} mine)` : `Import ${n}`;
    q("#im-go").disabled = !n;
    q("#im-all").checked = n === rows.length;
    const clash = rows.filter(r => r.action !== "new").map(r => `“${r.x.name}”`);
    q("#im-note").textContent = clash.length ? `${clash.join(", ")} already ${clash.length === 1 ? "exists" : "exist"} here. Keep both (the default) adds the imported one with a number after its name; Replace mine swaps it in over yours (its devices and last scan), which can’t be undone. Organizations that don’t exist yet are created.` : "";
  };
  q("#im-rows").onchange = e => {
    if (e.target.dataset.i !== undefined) rows[Number(e.target.dataset.i)].on = e.target.checked;
    if (e.target.dataset.act !== undefined) rows[Number(e.target.dataset.act)].action = e.target.value;
    draw();
  };
  q("#im-all").onchange = e => { rows.forEach(r => (r.on = e.target.checked)); draw(); };
  q("[data-no]").onclick = m.close;
  q("#im-go").onclick = async () => {
    const wanted = [...new Set(rows.filter(r => r.on).map(r => typeof r.x.organization === "string" ? r.x.organization.trim() : "").filter(Boolean))];
    const orgIds = await Orgs.mutate(d => Object.fromEntries(wanted.map(n => [n.toLowerCase(), Orgs.ensureIn(d, n)])));
    let added = 0, replaced = 0, current = false;
    for (const r of rows.filter(r => r.on)) {
      const x = r.x, name = x.name.trim();
      const devices = (Array.isArray(x.devices) ? x.devices : []).map(fromTransfer).filter(Boolean);
      const known = {};
      for (const d of devices) known[keyOf(d)] = d;
      const ls = x.lastScan && Array.isArray(x.lastScan.devices) ? x.lastScan : null;
      const str = v => typeof v === "string" ? v.trim() : "";
      const fields = { range: str(x.range), nameServer: str(x.nameServer), dhcpRange: str(x.dhcpRange), notes: typeof x.notes === "string" ? x.notes : "",
                       orgID: orgIds[str(x.organization).toLowerCase()] || null, known };
      const old = r.action === "replace" ? exists(x) : null;
      const target = old || { id: newId(), orgID: null };
      Object.assign(target, fields, { name: old ? old.name : uniqueName(name) });
      target.lastScan = ls ? { id: newId(), date: !isNaN(Date.parse(ls.date)) ? new Date(ls.date).toISOString() : new Date().toISOString(),
        range: str(ls.range) || target.range, siteName: target.name, devices: ls.devices.map(fromTransfer).filter(Boolean) } : null;
      if (old) { replaced++; if (old.id === ui.siteId) current = true; } else { data.sites.push(target); added++; }
      // Favorites need a remembered copy of each device too.
      for (const [k, d] of Object.entries(known)) if (!data.known[k]) data.known[k] = d;
    }
    persist(); m.close();
    setProgress(null, `Imported ${added + replaced} saved scan${added + replaced === 1 ? "" : "s"}${replaced ? ` (${replaced} replaced)` : ""}`);
    if (current) showLastScan(); else render();
  };
  draw();
}

// MARK: Export

async function exportRows(kind) {
  const rows = visibleRows();
  if (!rows.length) return;
  const header = ["Status", "Name", "Type", "IP", ...(ui.dhcp ? ["In DHCP range"] : []), "MAC", "Vendor", "Description", "Open ports", "Response (ms)", "Comment", "Favorite", "New", "First seen", "Last seen"];
  const table = rows.map(d => [d.isOnline ? "Online" : "Offline", d.name, kindLabel(d), d.ip, ...(ui.dhcp ? [inDhcpText(d)] : []), d.mac, d.vendor, describe(d), portsText(d),
    d.responseMs == null ? "" : d.responseMs.toFixed(1), data.comments[keyOf(d)] || "", isFav(d) ? "Yes" : "", d.isNew ? "Yes" : "",
    d.firstSeen ? fmtDate(d.firstSeen) : "", d.lastSeen ? fmtDate(d.lastSeen) : ""]);
  const base = (currentSite()?.name || "ARPradar scan") + " " + new Date().toISOString().slice(0, 10);
  const safe = base.replace(/[\\/:*?"<>|]/g, "-");
  try {
    let path;
    if (kind === "csv") {
      const text = csvText(header, table);
      path = await invoke("export_csv", { fileName: safe + ".csv", content: text });
    } else {
      path = await invoke("export_xlsx", { fileName: safe + ".xlsx", sheet: "Devices", header, rows: table });
    }
    if (path) setProgress(null, `Exported ${rows.length} devices to ${path}`);
  } catch (e) { showError("Couldn't export: " + e); }
}

// MARK: Switches: appearance, mode, offline, tabs, adapters

function setLook(look) {
  save("appearance", look);
  window.applyLook?.();
  document.querySelectorAll("[data-look]").forEach(b => b.classList.toggle("on", b.dataset.look === look));
  try { T.event.emit?.("settings-changed", {})?.catch(() => {}); } catch {}
}
function setMode(mode) {
  document.body.classList.toggle("basic", mode === "basic");
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  save("mode", mode);
  if (mode === "basic" && (ui.tab === "history" || ui.tab === "map")) ui.tab = "results";
  render();
}
function setTab(tab) {
  const old = ui.tab;
  ui.tab = tab; ui.selection.clear();
  // A scan picked in History stays in Results when you go back there.
  const picked = old === "history" && (tab === "results" || tab === "map") && ui.selectedRecord !== ui.currentRecordId
    ? data.history.find(r => r.id === ui.selectedRecord) : null;
  if (picked && !ui.scanning) return openHistoryRecord(picked).then(() => { if (tab === "map" && !ui.netMap && ui.devices.length) loadMap(); });
  render();
  if (tab === "map" && !ui.netMap && ui.devices.length && !ui.scanning) loadMap();
}
function offlineChanged() { save("showOffline", $("offline").checked ? "1" : "0"); render(); }

const currentAdapter = () => ui.adapters.find(a => a.id === $("adapter").value);
async function refreshAdapters() {
  try { ui.adapters = await invoke("list_adapters"); } catch { ui.adapters = []; }
  const keep = load("adapter", "");
  $("adapter").innerHTML = ui.adapters.map(a => `<option value="${esc(a.id)}">${esc(a.displayName)}</option>`).join("") || "<option>No network adapters found</option>";
  if (ui.adapters.some(a => a.id === keep)) $("adapter").value = keep;
}
function applyAdapter() {
  const a = currentAdapter();
  if (a) $("range").value = a.suggestedRange;
  render();
}

document.querySelectorAll("[data-look]").forEach(b => b.addEventListener("click", () => setLook(b.dataset.look)));
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("offline").addEventListener("change", offlineChanged);
$("adapter").addEventListener("change", () => { save("adapter", $("adapter").value); if (!currentSite()) applyAdapter(); });
// Refresh reads the adapter list again. The IP range only changes when the adapter does (or the box is empty),
// so a range typed by hand survives a refresh.
$("adapter-refresh").addEventListener("click", async () => {
  const before = $("adapter").value;
  await refreshAdapters();
  if (!currentSite() && ($("adapter").value !== before || !$("range").value.trim())) applyAdapter(); else render();
});
$("search").addEventListener("input", () => { ui.search = $("search").value; render(); });
$("range").addEventListener("input", () => { updateScanButton(); if (!shown.length) render(); });
$("range").addEventListener("keydown", e => { if (e.key === "Enter" && !ui.scanning) startScan(); });
$("scan").addEventListener("click", toggleScan);
$("savebar-save").addEventListener("click", () => siteDialog(null, "standalone"));
$("savebar-org").addEventListener("click", () => siteDialog(null, "org"));
$("savebar-no").addEventListener("click", () => { ui.offerSave = false; render(); });
$("serverbar-use").addEventListener("click", useOfferedNameServer);
$("serverbar-no").addEventListener("click", () => { ui.serverOffer = null; render(); });
$("newscan").addEventListener("click", () => newScan());

// Keyboard shortcuts (Windows style: Ctrl where the Mac uses Cmd).
document.addEventListener("keydown", e => {
  if (e.key === "Escape") return closeMenu();
  if (e.key === "F1") { e.preventDefault(); return openTool("help"); }
  if ($("modal-root").children.length) return;
  const k = e.key.toLowerCase();
  const act = (e.ctrlKey && k === "enter") ? toggleScan
    : (e.ctrlKey && e.altKey && k === "s") ? scanListDialog
    : (e.ctrlKey && e.altKey && k === "b") ? () => setMode(advanced() ? "basic" : "advanced")
    : (e.ctrlKey && e.shiftKey && k === "e") ? () => exportRows("xlsx")
    : (e.ctrlKey && !e.shiftKey && !e.altKey && k === "e") ? () => exportRows("csv")
    : (e.ctrlKey && !e.altKey && k === "s") ? () => { if (!currentSite() && ui.devices.some(d => d.isOnline) && !ui.scanning) siteDialog(null, advanced() ? "org" : "standalone"); }
    : (e.ctrlKey && k === "k") ? () => { if (advanced()) openTool("orgs"); }
    : (e.ctrlKey && e.shiftKey && k === "n") ? () => { if (advanced()) surveySetupDialog(null); }
    : (e.ctrlKey && k === "n") ? () => newScan()
    : (e.ctrlKey && k === ",") ? () => openTool("settings")
    : (e.ctrlKey && e.shiftKey && k === "w") ? () => { if (advanced()) openTool("remotewake"); }
    : (e.ctrlKey && k === "f") ? focusSearch
    : (e.ctrlKey && !e.shiftKey && !e.altKey && k === "r") ? () => { if (canRescan()) startScan(); }
    : (e.ctrlKey && k === "i") ? () => setDetails(!ui.showDetails)
    : (e.ctrlKey && !e.altKey && /^[1-8]$/.test(k)) ? () => { const t = TOOL_LIST[Number(k) - 1]; if (advanced() || !t.advanced) openTool(t.tool); }
    : null;
  if (act) { e.preventDefault(); act(); }
});

// MARK: Start

let appVersion = "";
(async () => {
  setLook(load("appearance", "dark"));
  $("offline").checked = load("showOffline", "1") === "1";
  try { const info = await invoke("app_info"); appVersion = info.version; } catch {}
  await loadData();
  await Orgs.load();
  if (Orgs.problem && !dataProblem) showError(Orgs.problem);
  // v0.6 kept an organization's name on each saved scan; move those to real organizations once.
  const named = data.sites.filter(s => s.organization && !s.orgID);
  if (named.length) {
    const ids = await Orgs.mutate(d => Object.fromEntries(named.map(s => [s.organization, Orgs.ensureIn(d, s.organization)])));
    for (const s of named) { s.orgID = ids[s.organization]; delete s.organization; }
    persist();
  }
  // Once: an organization with no name server or DHCP range takes them from its first saved scan (by name) that has one.
  if (load("orgSettingsFromScans", "") !== "1") {
    if (Orgs.list.length && data.sites.some(x => x.orgID)) await Orgs.mutate(d => { for (const o of d.orgs) Object.assign(o, filledFromScans(o, data.sites)); }).catch(() => {});
    save("orgSettingsFromScans", "1");
  }
  // Once: the SNMP community used to be one setting sent to every network scanned. It now belongs to each organization
  // and standalone saved scan; the old value is copied to what exists now, and new scans send "public".
  let oldCommunity = null;
  try { oldCommunity = localStorage.getItem("snmpCommunity"); } catch {}
  if (oldCommunity !== null) {
    let c = oldCommunity; try { c = JSON.parse(oldCommunity); } catch {}
    c = String(c || "").trim();
    if (c && c !== "public") {
      await Orgs.mutate(d => { for (const o of d.orgs) if (!String(o.snmpCommunity || "").trim()) o.snmpCommunity = c; }).catch(() => {});
      for (const x of data.sites) if (!x.orgID && !String(x.snmpCommunity || "").trim()) x.snmpCommunity = c;
      persist();
    }
    try { localStorage.removeItem("snmpCommunity"); } catch {}
  }
  Orgs.onChange(() => render());
  try { services = new Map(await invoke("common_ports")); } catch {}
  // First launch: Advanced if there's saved data already, else Basic (like the Mac app).
  setMode(load("mode", hadData ? "advanced" : "basic"));
  await refreshAdapters();
  await T.event.listen("scan", e => onScanEvent(e.payload));
  // A Scan Ports window finished: its open ports and banners go with the device.
  await T.event.listen("portscan-done", e => { const d = byIp.get(e.payload?.ip); if (d) addPortScan(d, e.payload.open || [], e.payload.banners || {}); });
  await UniFiStore.load();
  wireMapView();
  await T.event.listen("tray-scan", () => toggleScan());
  await T.event.listen("org-action", e => {
    const { action, value } = e.payload;
    if (action === "new-org") surveySetupDialog(null);
    if (action === "run-survey") surveySetupDialog(value);
    if (action === "open-site") selectSite(value);
    if (action === "new-scan-for-org") newScanForOrg(value);
    if (action === "port-scan-for-org") portScanForOrg(value);
    if (action === "detach-org") detachOrg(value);
    if (action === "unifi-setup") unifiControllerDialog(value || null);
  });
  await T.event.listen("activity", e => setBusy(e.payload.key, e.payload.on));
  await T.event.listen("settings-changed", () => {
    window.applyLook?.();
    document.querySelectorAll("[data-look]").forEach(b => b.classList.toggle("on", b.dataset.look === load("appearance", "dark")));
    render();
  });
  invoke("set_tray", { on: load("tray", "0") === "1", keepRunning: load("trayKeep", "1") === "1" }).catch(() => {});
  // Subnet Calculator's "Scan This Range".
  await T.event.listen("scan-range", e => { if (ui.scanning) return; newScan(); $("range").value = e.payload; startScan(); });
  // Always opens as a new, unsaved scan of this PC's network; a saved scan is only used when picked.
  newScan();
})();
