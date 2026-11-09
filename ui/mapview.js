// The Map tab in the main window (Advanced mode): toolbar, the map, the side panel, the UniFi Controller window,
// zoom (buttons, Ctrl+wheel, trackpad pinch) and Export. Loaded before app.js; uses its helpers when called.
"use strict";

const mapUI = {
  ready: false, zoom: 1, compact: false, showClients: true, selected: null, shownKey: null, layout: null, svgBox: null,
  init() {
    if (this.ready) return;
    this.ready = true;
    this.zoom = Math.min(2, Math.max(0.3, +load("mapZoom", "1") || 1));
    this.compact = load("mapCompact", "0") === "1";
    this.showClients = load("mapShowClients", "1") === "1";
  },
};
const MAP_MIN = 0.3, MAP_MAX = 2;
const mapStyle = () => (mapUI.compact ? MAP_STYLES.compact : MAP_STYLES.full);

// MARK: Which controller, and loading the map

/// The controller for the scan on screen: its organization's, else one whose address is in the scanned range.
function mapOrgId() { return currentSite()?.orgID || ui.autoFileOrgId || null; }
function mapController() {
  return UniFiStore.forScan(mapOrgId(), host => /^\d+\.\d+\.\d+\.\d+$/.test(host) && ui.spans.length > 0 && inSpans(host, ui.spans));
}
/// A UniFi console the scan found ("UniFi OS" web page), offered as the controller's address.
function detectedController() {
  const on = ui.devices.filter(d => d.isOnline);
  return on.find(d => /unifi os/i.test(d.webTitle || "")) || on.find(d => /unifi network/i.test(d.webTitle || "")) || null;
}

/// Builds the map: from the UniFi controller and/or the managed switches that answer SNMP, otherwise from the scan alone.
/// Saved with the scan in History (and its saved scan).
async function loadMap() {
  if (ui.mapLoading || !ui.devices.length || ui.scanning) return;
  ui.mapLoading = true; ui.mapError = null; render();
  const recordId = ui.currentRecordId;
  const scan = ui.devices.filter(d => d.isOnline);
  // The gateway: this PC's router when it's in the scanned range, else the range's .1 or .254.
  let gateway = null;
  const a = currentAdapter();
  if (a) { try { const info = await invoke("connection_info", { id: a.id }); if (info?.router && inSpans(info.router, ui.spans)) gateway = info.router; } catch {} }
  if (!gateway) gateway = scan.map(d => d.ip).find(ip => [1, 254].includes(+ip.split(".")[3])) || null;
  const gatewayMAC = scan.find(d => d.ip === gateway)?.mac || null;
  // Managed switches that answered SNMP during the scan (the gateway too: on many networks it's a layer-3 core switch):
  // their MAC tables and LLDP neighbours are read alongside the UniFi controller (if any), 6 at a time, with this
  // scan's own SNMP community only.
  const candidates = scan.filter(d => !d.thisPc && (d.snmpName || d.snmpDescr))
    .map(d => ({ ip: d.ip, mac: d.mac || "", name: d.snmpName || d.name || "", descr: d.snmpDescr || "" }));
  const snmpRead = candidates.length
    ? invoke("snmp_switches", { devices: candidates, community: effSnmpCommunity(currentSite()) }).catch(e => ({ switches: [], log: [`SNMP: ${e}`] }))
    : Promise.resolve({ switches: [], log: [] });
  let unifi = null, log = "";
  const c = mapController();
  if (c) {
    const client = new UniFiClient(c.address, { id: c.id });
    try {
      const r = await client.fetch(c.site || "");
      unifi = { devices: r.devices, clients: r.clients, controller: UniFiClient.normalized(c.address),
                source: `UniFi controller (${r.api})` + (!r.siteName || r.siteName === "Default" ? "" : ` · ${r.siteName}`) };
    } catch (e) {
      ui.mapError = e.message || String(e);
    }
    log = client.log.join("\n");
  }
  const sn = await snmpRead;
  const switches = sn.switches || [];
  if ((sn.log || []).length) log += (log ? "\n" : "") + sn.log.join("\n");
  ui.mapLog = log;
  let map;
  if (unifi || switches.length) {
    const infra = new Set((unifi?.devices || []).map(d => NetMapBuilder.mac(d.mac)));
    const snmp = SNMPMapBuilder.layout(switches, gatewayMAC, infra);
    const merged = SNMPMapBuilder.merge(unifi?.devices || [], unifi?.clients || [], snmp, scan);
    map = NetMapBuilder.build(merged.devices, merged.clients, scan, gateway, unifi?.controller || "");
    const snmpPart = switches.length ? `SNMP (${switches.length} switch${switches.length === 1 ? "" : "es"})` : "";
    map.source = [unifi?.source || "", snmpPart].filter(Boolean).join(" + ");
  } else {
    map = NetMapBuilder.withoutController(scan, gateway);
  }
  ui.mapLoading = false;
  if (recordId !== ui.currentRecordId) return render();   // a newer scan came in meanwhile
  ui.netMap = map;
  if (recordId) {
    const rec = data.history.find(r => r.id === recordId);
    if (rec) rec.netMap = map;
    for (const s of data.sites) if (s.lastScan?.id === recordId) s.lastScan.netMap = map;
    persist();
  }
  render();
}

// MARK: Drawing the tab

function renderMap() {
  const el = $("mapview");
  const on = ui.tab === "map";
  el.hidden = !on;
  if (!on) return;
  mapUI.init();
  const map = ui.netMap, c = mapController();
  const z = Math.round(mapUI.zoom * 100);
  const bar = `<div class="maptools">
      <span class="mapsource">${map ? `From ${esc(map.source)} · ${esc(new Date(map.date).toLocaleTimeString(undefined, { timeStyle: "short" }))}` : "Network map"}</span>
      ${ui.mapLoading ? '<span class="spinner" aria-label="Reading the network"></span>' : ""}
      <span class="grow"></span>
      ${ui.mapLog && !ui.mapError ? '<button type="button" data-map="log" class="linkbtn" title="What the map asked the UniFi controller and the switches (SNMP)">Details</button>' : ""}
      <button type="button" data-map="controller">${c ? "UniFi Controller…" : "Connect UniFi…"}</button>
      <button type="button" data-map="refresh" title="Read the map again" ${ui.mapLoading || !ui.devices.length || ui.scanning ? "disabled" : ""}>Refresh</button>
      <div class="segmented small" role="group" aria-label="Tiles" title="Full tiles with icons, or narrower compact tiles">
        <button type="button" data-map="full" class="${mapUI.compact ? "" : "on"}">Full</button><button type="button" data-map="compact" class="${mapUI.compact ? "on" : ""}">Compact</button></div>
      <label class="check"><input type="checkbox" data-map="clients" ${mapUI.showClients ? "checked" : ""}> Clients</label>
      <button type="button" data-map="fit" title="Zoom out to show the whole map" ${map ? "" : "disabled"}>Fit</button>
      <div class="zoomer"><button type="button" data-map="out" title="Zoom out (or Ctrl+scroll, or pinch on the touchpad)" aria-label="Zoom out">−</button><button type="button" data-map="actual" title="Actual size" id="mapzoom">${z}%</button><button type="button" data-map="in" title="Zoom in (or Ctrl+scroll, or pinch on the touchpad)" aria-label="Zoom in">+</button></div>
      <button type="button" data-map="export" ${map ? "" : "disabled"}>Export…</button>
    </div>`;
  let notes = "";
  if (ui.mapError) notes += `<div class="mapnote warn"><span>⚠ ${esc(ui.mapError)}</span>${ui.mapLog ? '<button type="button" data-map="log" class="linkbtn">Connection Details</button>' : ""}</div>`;
  if (map && !map.cabled && !ui.mapLoading) notes += `<div class="mapnote"><span>No UniFi controller and no switch answered SNMP, so this only lists the Ubiquiti devices the scan found; it can’t tell how they’re cabled. Dashed lines are guesses. Managed switches of any brand are mapped when SNMP is on and the community matches (the organization’s Settings).</span><button type="button" data-map="controller">Connect UniFi…</button></div>`;
  let body;
  if (!ui.devices.length) body = `<div class="mapempty">Scan a network first. The map is built from the scan, the UniFi controller when you connect one, and managed switches that answer SNMP.</div>`;
  else if (map) body = `<div class="mapbody"><div class="mapscroll" id="mapscroll"></div><aside class="mapside" id="mapside"></aside></div>`;
  else if (ui.mapLoading) body = `<div class="mapempty"><span class="spinner"></span> Reading the network…</div>`;
  else body = `<div class="mapempty"><button type="button" class="primary" data-map="build">Build Map</button></div>`;
  // Keep the scroll position when only the toolbar or panel changes.
  const sc = $("mapscroll"), keep = sc ? [sc.scrollLeft, sc.scrollTop] : null;
  el.innerHTML = bar + notes + body;
  if (map && ui.devices.length) {
    drawMapCanvas();
    const key = `${map.date}|${mapUI.compact}`;
    if (mapUI.shownKey !== key) { mapUI.shownKey = key; requestAnimationFrame(scrollToRoot); }
    else if (keep) { $("mapscroll").scrollLeft = keep[0]; $("mapscroll").scrollTop = keep[1]; }
    renderMapSide();
  }
}

function drawMapCanvas() {
  const map = ui.netMap, sc = $("mapscroll"); if (!map || !sc) return;
  mapUI.layout = mapLayout(map, mapUI.showClients, mapStyle());
  const selected = map.nodes.some(n => n.id === mapUI.selected) ? mapUI.selected : map.nodes[0]?.id;
  // A zoom saved from before (or a wider window) may be below what Fit needs now.
  const low = mapLowestZoom();
  if (mapUI.zoom < low) { mapUI.zoom = low; const label = $("mapzoom"); if (label) label.textContent = `${Math.round(low * 100)}%`; }
  const out = document.querySelector('[data-map="out"]'); if (out) out.disabled = mapUI.zoom <= low + 0.001;
  sc.innerHTML = `<div class="mapcanvas">${mapSVG(map, mapUI.layout, { pal: SCREEN_PALETTE, selected, zoom: mapUI.zoom })}</div>`;
}
/// Shows the gateway at the top, in the middle.
function scrollToRoot() {
  const sc = $("mapscroll"), map = ui.netMap; if (!sc || !map || !mapUI.layout) return;
  const r = mapUI.layout.centers.get(map.nodes[0]?.id); if (!r) return;
  sc.scrollLeft = Math.max(0, (r.x + 8) * mapUI.zoom - sc.clientWidth / 2);
  sc.scrollTop = 0;
}

/// Zoom keeping the map point under (vx, vy) in the window where it is.
function zoomMapAt(wanted, vx, vy) {
  const sc = $("mapscroll"); if (!sc) return;
  const z = Math.min(MAP_MAX, Math.max(mapLowestZoom(), wanted));
  if (Math.abs(z - mapUI.zoom) < 0.001) return;
  const r = z / mapUI.zoom;
  const px = sc.scrollLeft + vx, py = sc.scrollTop + vy;
  mapUI.zoom = z;
  const svg = sc.querySelector("svg");
  if (svg) {   // just resize the drawing: it's vector, so it stays sharp and nothing has to be redrawn
    const [, , w, h] = svg.getAttribute("viewBox").split(" ").map(Number);
    svg.setAttribute("width", w * z); svg.setAttribute("height", h * z);
  }
  sc.scrollLeft = px * r - vx; sc.scrollTop = py * r - vy;
  const label = $("mapzoom"); if (label) label.textContent = `${Math.round(z * 100)}%`;
  const out = document.querySelector('[data-map="out"]'); if (out) out.disabled = z <= mapLowestZoom() + 0.001;
  clearTimeout(mapUI.saveZoom); mapUI.saveZoom = setTimeout(() => save("mapZoom", String(mapUI.zoom)), 400);
}
function zoomMapCenter(wanted) { const sc = $("mapscroll"); if (sc) zoomMapAt(wanted, sc.clientWidth / 2, sc.clientHeight / 2); }
/// The zoom Fit picks: the whole width in the window (30–100%). Zooming out further than that is never needed.
function mapLowestZoom() {
  const sc = $("mapscroll"); if (!sc || !mapUI.layout || !sc.clientWidth) return MAP_MIN;
  const full = mapUI.layout.width + 16;
  return Math.min(1, Math.max(MAP_MIN, Math.floor((sc.clientWidth - 8) / full * 20) / 20));
}
/// Zoom so the whole width fits, then show the top.
function fitMap() {
  const sc = $("mapscroll"); if (!sc || !mapUI.layout) return;
  zoomMapAt(mapLowestZoom(), 0, 0);
  sc.scrollLeft = 0; sc.scrollTop = 0;
}

// MARK: Side panel

function renderMapSide() {
  const el = $("mapside"), map = ui.netMap; if (!el || !map) return;
  const n = map.nodes.find(x => x.id === mapUI.selected) || map.nodes[0];
  if (!n) { el.innerHTML = ""; return; }
  const parent = map.nodes.find(x => x.id === n.parent);
  let uplink = "";
  if (parent) {
    if (n.wireless) uplink = `Wireless to ${parent.name}` + (n.signal != null ? `, ${n.signal} dBm` : "");
    else {
      uplink = parent.name + (n.parentPort != null ? ` port ${n.parentPort}` : "");
      if (n.uplinkPort != null) uplink = `Port ${n.uplinkPort} → ` + uplink;
      if (n.linkMbps > 0) uplink += " · " + mapSpeed(n.linkMbps);
    }
  }
  const rows = [["IP", n.ip], ["MAC", n.mac], ["Uplink", uplink], ["Channels", n.channels],
    ["PoE", n.poeWatts != null ? `${n.poeWatts.toFixed(1)} W in use` : ""], ["Status", n.guessed ? "Guessed" : n.online ? "Online" : "Offline"]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("");
  const scanned = n.ip && ui.devices.find(d => d.ip === n.ip);
  const ports = n.ports.length ? `<h4>Ports</h4><table class="mapports"><tr><th>Port</th><th>Speed</th><th>Connected</th></tr>${n.ports.map(p => {
      const col = p.up && p.mbps > 0 ? speedColor(p.mbps, SCREEN_PALETTE) : "";
      return `<tr class="${p.up ? "" : "down"}"><td>${p.idx}</td><td style="${col ? `color:${col}` : ""}">${p.up ? (p.mbps > 0 ? mapSpeed(p.mbps) : "Up") : "—"}</td><td>${esc(p.connected || "")}${p.poeWatts != null ? `<span class="poe"> ⚡${p.poeWatts.toFixed(1)} W</span>` : ""}</td></tr>`;
    }).join("")}</table>` : "";
  const list = (title, cs) => cs.length ? `<h4>${title} (${cs.length})</h4><div class="mapclients">${cs.map(c => `<div class="mc">
      ${c.port != null ? `<span class="p">P${c.port}</span>` : ""}<span class="n"><span>${esc(displayName(c))}</span><small>${esc([c.ip, c.ssid].filter(Boolean).join(" · "))}</small></span>
      ${c.signal != null ? `<span class="sig${c.signal < -75 ? " weak" : ""}">${c.signal} dBm</span>` : ""}</div>`).join("")}</div>` : "";
  el.innerHTML = `<h3>${esc(n.name || n.model)}</h3><div class="sub">${esc([n.model, n.firmware ? `firmware ${n.firmware}` : ""].filter(Boolean).join(" · "))}</div>
    ${n.note ? `<p class="mapwarn">⚠ ${esc(n.note)}</p>` : ""}
    <table class="kv">${rows}</table>
    ${n.ip ? `<div class="mapacts"><button type="button" data-map="web">Open in Browser</button>${scanned && advanced() ? '<button type="button" data-map="ports">Scan Ports…</button>' : ""}</div>` : ""}
    ${ports}${list("Wired", n.clients.filter(c => c.wired))}${list("Wi-Fi", n.clients.filter(c => !c.wired))}`;
}

/// Clicking the "12 wired · 3 Wi-Fi" chip under a box: its clients and the port each one is on.
function mapClientsDialog(id) {
  const n = ui.netMap?.nodes.find(x => x.id === id); if (!n) return;
  const wired = n.clients.filter(c => c.wired).sort((a, b) => ((a.port ?? 9999) - (b.port ?? 9999)) || displayName(a).localeCompare(displayName(b)));
  const wifi = n.clients.filter(c => !c.wired).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const list = (title, cs) => cs.length ? `<h4>${title} (${cs.length})</h4><table class="mapports">${cs.map(c => `<tr><td>${c.wired ? (c.port != null ? "P" + c.port : "") : (c.signal != null ? c.signal + " dBm" : "")}</td>
    <td>${esc(displayName(c))}</td><td class="mono">${esc(c.ip || "")}</td></tr>`).join("")}</table>` : "";
  const m = modal(`<h2>${esc(n.name || n.model)}</h2><div style="max-height:420px;overflow:auto">${list("Wired", wired)}${list("Wi-Fi", wifi)}</div>
    <div class="buttons"><button type="button" data-copy class="left">Copy List</button><button type="button" class="primary">Close</button></div>`, true);
  m.el.querySelector(".primary").onclick = m.close;
  m.el.querySelector("[data-copy]").onclick = () => copyText(n.clients.map(c => [c.port != null ? "P" + c.port : c.wired ? "" : "Wi-Fi", displayName(c), c.ip || "", c.mac || ""].join("\t")).join("\n"),
    `Copied ${n.clients.length} client${n.clients.length === 1 ? "" : "s"} of ${n.name || n.model}`);
}

// MARK: Clicks, wheel and pinch

function mapClick(e) {
  const chip = e.target.closest("[data-clients]");
  if (chip) { mapUI.selected = chip.dataset.clients; drawMapCanvasKeepingScroll(); renderMapSide(); return mapClientsDialog(chip.dataset.clients); }
  const nodeEl = e.target.closest("[data-node]");
  if (nodeEl) { mapUI.selected = nodeEl.dataset.node; drawMapCanvasKeepingScroll(); renderMapSide(); return; }
  const b = e.target.closest("[data-map]"); if (!b) return;
  const n = ui.netMap?.nodes.find(x => x.id === mapUI.selected) || ui.netMap?.nodes[0];
  switch (b.dataset.map) {
    case "controller": return unifiControllerDialog();
    case "refresh": case "build": return loadMap();
    case "full": case "compact": mapUI.compact = b.dataset.map === "compact"; save("mapCompact", mapUI.compact ? "1" : "0"); return renderMap();
    case "fit": return fitMap();
    case "out": return zoomMapCenter(mapUI.zoom - 0.1);
    case "in": return zoomMapCenter(mapUI.zoom + 0.1);
    case "actual": return zoomMapCenter(1);
    case "export": { e.stopPropagation(); const r = b.getBoundingClientRect(); return showMenuAt([{ label: "Map as PNG…", run: () => exportMap("png") }, { label: "Map as PDF…", run: () => exportMap("pdf") },
      { label: "Map as SVG…", run: () => exportMap("svg") }, { sep: true }, { label: "Switch Ports as Excel (.xlsx)…", run: () => exportMap("ports") }], r.left, r.bottom + 2); }
    case "log": return mapLogDialog(ui.mapLog);
    case "web": return n?.ip && act("web", `https://${n.ip}`);
    case "ports": { const d = ui.devices.find(x => x.ip === n?.ip); return d && portScanDialog(d); }
  }
}
function drawMapCanvasKeepingScroll() {
  const sc = $("mapscroll"); if (!sc) return;
  const [x, y] = [sc.scrollLeft, sc.scrollTop];
  drawMapCanvas(); sc.scrollLeft = x; sc.scrollTop = y;
}
function mapChange(e) {
  if (e.target.dataset.map === "clients") { mapUI.showClients = e.target.checked; save("mapShowClients", mapUI.showClients ? "1" : "0"); drawMapCanvasKeepingScroll(); }
}
/// Ctrl+wheel and touchpad pinch (which Windows sends as Ctrl+wheel) zoom around the pointer; plain wheel scrolls.
function mapWheel(e) {
  if (!e.ctrlKey) return;
  const sc = $("mapscroll"); if (!sc || !sc.contains(e.target)) return;
  e.preventDefault();
  const r = sc.getBoundingClientRect();
  const step = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 40 ? 0.01 : 0.0025));
  zoomMapAt(mapUI.zoom * step, e.clientX - r.left, e.clientY - r.top);
}

// MARK: Export

async function exportMap(kind) {
  const map = ui.netMap; if (!map) return;
  const stamp = map.date.slice(0, 10);
  const base = (currentSite()?.name || "network").replace(/[\\/:*?"<>|]/g, "-");
  try {
    let path;
    if (kind === "ports") {
      const t = mapPortsTable(map);
      path = await invoke("export_xlsx", { fileName: `${base} switch ports ${stamp}.xlsx`, sheet: "Switch ports", header: t.header, rows: t.rows });
    } else {
      const layout = mapLayout(map, mapUI.showClients, mapStyle());
      const svg = mapSVG(map, layout, { pal: EXPORT_PALETTE, selected: null, zoom: 1, pad: 16 });
      let bytes;
      if (kind === "svg") bytes = new TextEncoder().encode(svg);
      else {
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width * 2; canvas.height = img.height * 2;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, kind === "png" ? "image/png" : "image/jpeg", 0.92));
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (kind === "pdf") bytes = jpegToPDF(bytes, canvas.width, canvas.height);
      }
      path = await invoke("export_bytes", { fileName: `${base} map ${stamp}.${kind}`, data: Array.from(bytes), kind });
    }
    if (path) setProgress(null, `Saved ${path}`);
  } catch (e) { showError("Couldn't export the map: " + (e.message || e)); }
}

// MARK: The UniFi Controller window, and Connection Details

function mapLogDialog(text) {
  const m = modal(`<h2>What ARPradar asked the controller and the switches</h2><p class="note">No key or values, only what was asked, the field names that came back, and what each switch answered over SNMP.</p>
    <pre class="maplog">${esc(text || "")}</pre><div class="buttons"><button type="button" data-copy>Copy</button><button type="button" class="primary">OK</button></div>`, true);
  m.el.querySelector(".primary").onclick = m.close;
  m.el.querySelector("[data-copy]").onclick = () => copyText(text || "");
}

/// Connect or edit the controller for this scan (its organization's, or for scans of the network it's on).
async function unifiControllerDialog(forOrgId) {
  const orgId = forOrgId !== undefined ? forOrgId : mapOrgId();
  const existing = forOrgId !== undefined ? UniFiStore.forOrg(forOrgId) : mapController();
  const org = Orgs.org(orgId);
  const hasKey = existing ? await UniFiStore.hasKey(existing) : false;
  const det = detectedController();
  let sites = [], site = existing?.site || "", log = "";
  const m = modal(`<h2>UniFi Controller</h2>
    <p class="note" style="margin-top:0">ARPradar reads how your UniFi switches and access points are connected, and which devices are on each port and access point. It only reads; it never changes anything on the controller.</p>
    <div class="field"><label for="uc-addr">Address</label><input id="uc-addr" class="mono" placeholder="https://10.0.0.5" spellcheck="false" value="${esc(existing?.address || (det ? `https://${det.ip}` : ""))}"></div>
    <div class="field"><label for="uc-key">API key</label><input id="uc-key" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? "Saved on this PC (leave blank to keep it)" : "Paste the key"}">
      <p class="note">In UniFi Network: Settings › Control Plane › Integrations › Create API Key. It’s kept in Windows Credential Manager on this PC, never in ARPradar’s files or exports.</p></div>
    <div class="field" id="uc-sitefield" hidden><label for="uc-site">Site</label><select id="uc-site"></select></div>
    <p class="note">Used for: ${esc(org ? `every scan in ${org.name}` : "scans of the network it’s on")}</p>
    <div class="uc-test"><button type="button" id="uc-test">Test</button><span id="uc-result"></span><button type="button" id="uc-log" class="linkbtn" hidden>Details</button></div>
    <div class="buttons">${existing ? `<button type="button" id="uc-remove" class="${existing.certFingerprint ? "" : "left "}danger"${existing.certFingerprint ? ' style="margin-right:6px"' : ""}>Remove</button>` : ""}${existing?.certFingerprint ? '<button type="button" id="uc-forget" class="left" title="Use after replacing the controller or its certificate: the next connection remembers the new one.">Forget Certificate</button>' : ""}<button type="button" data-no>Cancel</button><button type="button" class="primary" id="uc-save">Save</button></div>`, true);
  const q = s => m.el.querySelector(s);
  const keyNow = () => q("#uc-key").value.trim();
  const ready = () => { const okAddr = !!q("#uc-addr").value.trim(), okKey = !!keyNow() || hasKey; q("#uc-save").disabled = !(okAddr && okKey); q("#uc-test").disabled = !(okAddr && okKey); };
  q("#uc-addr").oninput = ready; q("#uc-key").oninput = ready; ready();
  q("[data-no]").onclick = m.close;
  q("#uc-site").onchange = () => { site = q("#uc-site").value; };
  q("#uc-log").onclick = () => mapLogDialog(log);
  q("#uc-test").onclick = async () => {
    const res = q("#uc-result");
    res.className = ""; res.innerHTML = '<span class="spinner"></span>';
    q("#uc-test").disabled = true;
    const client = new UniFiClient(q("#uc-addr").value.trim(), keyNow() ? { key: keyNow() } : { id: existing.id });
    try {
      const found = await client.sites();
      sites = found.sites;
      if (!sites.some(s => s.ref === site)) site = sites[0]?.ref || "";
      q("#uc-sitefield").hidden = sites.length < 2;
      q("#uc-site").innerHTML = sites.map(s => `<option value="${esc(s.ref)}"${s.ref === site ? " selected" : ""}>${esc(s.name || s.ref)}</option>`).join("");
      const r = await client.fetch(site);
      res.className = "ok";
      res.textContent = `Connected · ${r.devices.length} UniFi devices, ${r.clients.length} clients (${r.clients.filter(c => c.wired).length} wired) · ${r.api}`;
    } catch (e) {
      res.className = "bad"; res.textContent = e.message || String(e);
    }
    log = client.log.join("\n"); q("#uc-log").hidden = !log;
    ready();
  };
  q("#uc-save").onclick = async () => {
    const c = { ...(existing || { id: newId().toUpperCase() }), address: UniFiClient.normalized(q("#uc-addr").value), site,
                siteName: sites.find(s => s.ref === site)?.name || existing?.siteName || "", orgID: orgId || null };
    try { await UniFiStore.upsert(c, keyNow() || null); } catch (e) { return (q("#uc-result").className = "bad", q("#uc-result").textContent = String(e)); }
    m.close();
    tellOrgsWindow();
    if (ui.devices.length && !ui.scanning) loadMap(); else render();
  };
  if (existing?.certFingerprint) q("#uc-forget").onclick = () => confirmBox("Forget the controller’s certificate?", "Use this after replacing the controller or its certificate. The next connection accepts and remembers the certificate it shows.", "Forget Certificate", async () => {
    await UniFiStore.forgetCertificate(existing.id); existing.certFingerprint = null; q("#uc-forget").remove();
    q("#uc-result").className = ""; q("#uc-result").textContent = "Certificate forgotten. Test or Save to connect again.";
  });
  if (existing) q("#uc-remove").onclick = () => confirmBox(`Remove the controller ${existing.address}?`, "Its API key is removed from this PC too. The map goes back to listing what the scan found.", "Remove", async () => {
    await UniFiStore.remove(existing.id); m.close(); tellOrgsWindow(); if (ui.devices.length && !ui.scanning) loadMap(); else render();
  });
}
/// The Organizations window shows whether an organization has a controller.
function tellOrgsWindow() { try { T.event.emit?.("unifi-changed", {})?.catch(() => {}); } catch {} }

function wireMapView() {
  const el = $("mapview");
  el.addEventListener("click", mapClick);
  el.addEventListener("change", mapChange);
  el.addEventListener("wheel", mapWheel, { passive: false });
}
