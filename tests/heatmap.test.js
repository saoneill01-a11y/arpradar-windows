// Tests for the Wi-Fi Heatmap's math (ui/heatmap.js), the same cases as the Mac's HeatmapTests, HeatmapAPTests,
// APGroupingTests, OverlayAndClashTests (clashes, background removal), HeatmapZoomTests and HeatmapSaveTests.
// Run: node tests/heatmap.test.js (no packages needed). Made-up networks and addresses only.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert/strict");

const ctx = { console, crypto: globalThis.crypto, document: { createElement: () => ({ getContext: () => ({ measureText: t => ({ width: String(t).length * 6 }) }) }) } };
vm.createContext(ctx);
for (const f of ["netmap.js", "heatmap.js", "orgs.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", f), "utf8"), ctx, { filename: f });
vm.runInContext("Object.assign(this, { Heatmap, NetMapBuilder, heatmapEntry })", ctx);
const { Heatmap: H, heatmapEntry } = ctx;
const plain = x => JSON.parse(JSON.stringify(x));
const near = (a, b, d = 0.001, msg) => assert.ok(Math.abs(a - b) <= d, msg || `${a} is not within ${d} of ${b}`);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const r = (ssid, bssid, rssi, ch, band = "5 GHz", width = 80) => ({ ssid, bssid, rssi, channel: ch, band, widthMHz: width });
let n = 0;
const spot = (x, y, readings, ping) => ({ id: `S${++n}`, x, y, date: "2026-11-11T10:00:00Z", readings, joinedSSID: "ExampleNet", joinedBSSID: "AA:00:00:00:00:01", pingMs: ping ?? null });
const filter = (ssid, extra = {}) => ({ ssid, band: "all", ...extra });

test("average keeps one per AP, strongest first", () => {
  const net = (ssid, bssid, rssi, ch, band = "5 GHz", width = 80) => ({ ssid, bssid, rssi, channel: ch, band, widthMhz: width });
  const avg = H.average([
    [net("ExampleNet", "AA:00:00:00:00:01", -50, 36), net("Neighbor", "BB:00:00:00:00:01", -80, 6, "2.4 GHz", 20)],
    [net("ExampleNet", "AA:00:00:00:00:01", -54, 36)],
    [net("ExampleNet", "AA:00:00:00:00:01", -52, 36), net("Neighbor", "BB:00:00:00:00:01", -76, 6, "2.4 GHz", 20)],
  ]);
  assert.deepEqual(plain(avg.map(a => a.bssid)), ["AA:00:00:00:00:01", "BB:00:00:00:00:01"]);
  assert.equal(avg[0].rssi, -52);
  assert.equal(avg[1].rssi, -78);
  assert.equal(avg[1].widthMHz, 20);
});

test("overlap", () => {
  assert.ok(H.overlaps(r("a", "1", -50, 1, "2.4 GHz", 20), r("b", "2", -50, 3, "2.4 GHz", 20)));
  assert.ok(!H.overlaps(r("a", "1", -50, 1, "2.4 GHz", 20), r("b", "2", -50, 6, "2.4 GHz", 20)));
  assert.ok(H.overlaps(r("a", "1", -50, 36), r("b", "2", -50, 44, "5 GHz", 20)));          // 80 MHz on 36 covers 36–48
  assert.ok(!H.overlaps(r("a", "1", -50, 36), r("b", "2", -50, 52, "5 GHz", 20)));
  assert.ok(!H.overlaps(r("a", "1", -50, 6, "2.4 GHz", 20), r("b", "2", -50, 6, "5 GHz", 20)));
});

test("values by mode", () => {
  const s = spot(10, 10, [r("ExampleNet", "AA:1", -48, 36), r("ExampleNet", "AA:2", -70, 149), r("Other", "CC:1", -60, 40, "5 GHz", 20), r("Far", "DD:1", -90, 44, "5 GHz", 20)], 12);
  const f = filter("ExampleNet");
  assert.equal(H.value(s, "signal", f), -48);
  assert.equal(H.value(s, "apCount", f), 2);
  assert.equal(H.value(s, "overlap", f), 1);           // "Other" on 40; "Far" is too quiet
  assert.equal(H.value(s, "ping", f), 12);
  assert.equal(H.value(s, "oneAP", filter("ExampleNet", { bssid: "AA:2" })), -70);
  assert.equal(H.value(s, "oneAP", filter("ExampleNet", { bssid: "ZZ:9" })), H.silent);
  assert.equal(H.value(s, "signal", filter("ExampleNet", { band: "2.4" })), H.silent);
});

test("levels and colours", () => {
  near(H.level(-67, "signal"), 0.5);
  assert.equal(H.level(-30, "signal"), 1);
  assert.equal(H.level(-99, "signal"), 0);
  assert.equal(H.level(0, "overlap"), 1);
  assert.equal(H.level(5, "overlap"), 0);
  const red = H.color(0), green = H.color(1);
  assert.ok(red[0] > red[1]); assert.ok(green[1] > green[0]);
});

test("grid matches spots and leaves far areas empty", () => {
  const g = H.gridOf([{ x: 100, y: 100, v: -50 }, { x: 300, y: 100, v: -80 }], 1000, 500, 100, 150);
  const at = (x, y) => g.values[Math.floor(y / 10) * g.cols + Math.floor(x / 10)];
  const a = at(100, 100), mid = at(200, 100), b = at(300, 100);
  assert.ok(a > mid && mid > b, `${a} ${mid} ${b}`);
  assert.ok(Math.abs(a + 50) < Math.abs(a + 80));
  near(mid, -65, 2);                                     // the cell centre is 5 px past the midpoint
  assert.equal(at(900, 450), null);
});

test("coverage", () => {
  const c = H.coverage({ cols: 4, rows: 1, values: [-50, -70, -80, null], alpha: [1, 1, 1, 0] });
  near(c.good, 1 / 3); near(c.fair, 1 / 3); near(c.poor, 1 / 3);
});

test("access point placed where loudest", () => {
  const spots = [spot(0, 0, [r("ExampleNet", "AA:1", -40, 36)]), spot(100, 0, [r("ExampleNet", "AA:1", -70, 36)]),
    spot(200, 0, [r("ExampleNet", "AA:1", -85, 36), r("Other", "CC:1", -50, 6, "2.4 GHz", 20)])];
  const aps = H.accessPoints(spots, filter("ExampleNet"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].best, -40);
  assert.equal(aps[0].spotsHeard, 3);
  assert.ok(aps[0].x < 5);
  assert.equal(H.neighborCount(spots, filter("ExampleNet")), 1);
});

test("findings", () => {
  const s = H.newSurvey("Test floor");
  s.spots = [0, 1, 2, 3, 4, 5].map(i => spot(i * 100, 0, [
    r("ExampleNet", "AA:1", i === 5 ? -82 : -50, 6, "2.4 GHz", 20), r("ExampleNet", "AA:2", -60, 6, "2.4 GHz", 20),
    r("Cafe", "CC:1", -70, 6, "2.4 GHz", 20), r("Shop", "DD:1", -75, 4, "2.4 GHz", 20)]));
  const f = filter("ExampleNet"), cov = { good: 0.8, fair: 0.1, poor: 0.1, measured: true };
  const found = H.findings(s, f, cov);
  assert.ok(!found.some(x => x.level === "bad"));         // AA:2 still gives −60 at the last spot
  assert.ok(found.some(x => x.text.includes("shares channel 6 with 2 neighbor networks")));
  assert.ok(found.some(x => x.text.includes("both on channel 6")));
  s.spots[5].readings = [r("Cafe", "CC:1", -70, 6, "2.4 GHz", 20)];
  const weak = H.findings({ ...s, id: "other" }, f, cov);
  assert.equal(weak.find(x => x.level === "bad").spot, s.spots[5].id);
  assert.ok(weak.some(x => x.text.startsWith("10% of the measured area")));
});

test("draft and names", () => {
  const s = H.newSurvey("Test floor");
  s.scale = { pixelsPerUnit: 10, metres: false };
  s.spots = [spot(100, 50, [r("ExampleNet", "AA:00:00:00:12:34", -55, 36)], 8)];
  assert.equal(H.apName(s, "AA:00:00:00:12:34", "ExampleNet"), "ExampleNet …12:34");
  s.apNames["AA:00:00:00:12:34"] = "Lobby";
  assert.equal(H.shownNetwork(s), "ExampleNet");
  const d = H.draft(s, filter("ExampleNet"), { good: 1, fair: 0, poor: 0, measured: true });
  assert.equal(d.kind, "heatmap");
  assert.equal(d.heatmapID, s.id);
  assert.equal(d.table.rows[0][1], "10, 5 ft");
  assert.equal(d.table.rows[0][2], "Lobby");
  assert.equal(d.table.rows[0][7], "8");
});

test("radios of one AP are grouped (old key)", () => {
  assert.equal(H.apKey("7A:AC:B9:12:34:56"), H.apKey("76:AC:B9:12:34:56"));
  assert.equal(H.apKey("00:11:22:33:44:50"), H.apKey("00:11:22:33:44:5F"));
  assert.notEqual(H.apKey("00:11:22:33:44:50"), H.apKey("00:11:22:33:44:60"));
  assert.notEqual(H.apKey("7A:AC:B9:12:34:56"), H.apKey("7A:AC:B9:12:35:56"));
});

test("one marker per AP and placed positions", () => {
  const rr = (bssid, rssi, band = "5 GHz") => r("Example", bssid, rssi, band === "5 GHz" ? 36 : 6, band, 20);
  const spots = [0, 1, 2, 3].map(i => spot(i * 100, 0, [rr("7A:AC:B9:12:34:56", -50 - i), rr("76:AC:B9:12:34:56", -60 - i, "2.4 GHz"), rr("02:00:00:00:00:A0", -70)]));
  const aps = H.accessPoints(spots, filter("Example"));
  assert.equal(aps.length, 2);
  const main = aps.find(a => a.key === H.apKey("7A:AC:B9:12:34:56"));
  assert.equal(main.radios, 2);
  assert.deepEqual(plain(main.bands), ["2.4 GHz", "5 GHz"]);
  assert.equal(main.best, -50);
  assert.equal(main.placed, false);
  assert.equal(main.worthShowing, true);
  const p = H.accessPoints(spots, filter("Example"), { [main.key]: { x: 777, y: 55 } }).find(a => a.key === main.key);
  assert.ok(p.placed); assert.equal(p.x, 777); assert.equal(p.y, 55);
  assert.ok(!H.accessPoints(spots.slice(0, 2), filter("Example")).every(a => a.worthShowing));
  assert.equal(H.value(spots[0], "oneAP", filter("Example", { bssid: main.key })), -50);
});

test("AP names", () => {
  const s = H.newSurvey("Floor 1");
  assert.equal(H.apName(s, "7A:AC:B9:12:34:56", "Example"), "Example …34:56");
  s.apNames["76:AC:B9:12:34:56"] = "Lobby";
  assert.equal(H.apName(s, "7A:AC:B9:12:34:56", "Example"), "Lobby");
  s.apNames[H.apKey("7A:AC:B9:12:34:56")] = "Front desk";
  assert.equal(H.apName(s, "76:AC:B9:12:34:56", "Example"), "Front desk");
  const map = { nodes: [{ id: "ap", kind: "ap", name: "Addition Hobby Room", mac: "74:AC:B9:12:34:56" }] };
  assert.equal(H.uniFiNames(map)[H.apKey("7A:AC:B9:12:34:56")], "Addition Hobby Room");
});

test("AP numbering styles", () => {
  assert.ok(H.sameAP("02:00:5E:CC:2C:71", "02:00:5E:CC:2C:73"));
  assert.ok(H.sameAP("02:00:5E:2D:B6:12", "02:00:5E:2E:B6:12"));
  assert.ok(H.sameAP("02:00:5E:AA:2E:E4", "02:00:5E:AB:2E:E4"));
  assert.ok(H.sameAP("7A:00:5E:12:34:56", "76:00:5E:12:34:56"));
  assert.ok(H.sameAP("7A:00:5E:12:34:56", "76:00:5E:12:34:57"));
  assert.ok(!H.sameAP("02:00:5E:2D:B6:12", "02:00:5E:2D:B7:40"));
  assert.ok(!H.sameAP("02:00:5E:2D:B6:12", "02:00:5E:3D:B6:12"));
  assert.ok(!H.sameAP("02:00:5E:12:34:10", "02:00:5E:12:34:60"));
  assert.ok(!H.sameAP("02:00:5E:12:34:56", "02:00:5F:12:34:56"));
});

test("six groups from thirteen radios", () => {
  const radios = ["02:00:5E:49:E9:65", "02:00:5E:49:E9:66", "02:00:5E:CC:2C:71", "02:00:5E:CC:2C:72", "02:00:5E:CC:2C:73", "02:00:5E:6B:18:64", "02:00:5E:6C:18:64",
    "02:00:5E:2D:B6:12", "02:00:5E:2E:B6:12", "02:00:5E:AA:2E:E4", "02:00:5E:AB:2E:E4", "02:00:5E:71:69:11", "02:00:5E:72:69:11"];
  const g = H.groups(radios);
  assert.equal(new Set(Object.values(g)).size, 6);
  assert.equal(g["02:00:5E:2D:B6:12"], g["02:00:5E:2E:B6:12"]);
  assert.equal(g["02:00:5E:CC:2C:71"], g["02:00:5E:CC:2C:73"]);
  assert.notEqual(g["02:00:5E:CC:2C:71"], g["02:00:5E:2D:B6:12"]);
  assert.equal(g["02:00:5E:2D:B6:12"], H.apKey("02:00:5E:2D:B6:12"));
});

test("combine and separate by hand", () => {
  const a = "02:00:5E:11:11:11", b = "02:00:5E:99:99:99";
  assert.notEqual(H.groups([a, b])[a], H.groups([a, b])[b]);
  const combined = H.groups([a, b], { [a]: "K", [b]: "K" });
  assert.equal(combined[a], "K"); assert.equal(combined[b], "K");
  const c = "02:00:5E:CC:2C:71", d = "02:00:5E:CC:2C:72";
  const sep = H.groups([c, d], { [c]: c, [d]: d });
  assert.notEqual(sep[c], sep[d]);
  const sp = (x, ra, rb) => spot(x, 0, [r("N", a, ra, 6, "2.4 GHz", 20), r("N", b, rb, 36, "5 GHz", 80)]);
  const spots = [sp(0, -50, -40), sp(100, -60, -70), sp(200, -70, -75)];
  const aps = H.accessPoints(spots, filter("N"), {}, { [a]: "K", [b]: "K" });
  assert.equal(aps.length, 1);
  assert.deepEqual(plain(aps[0].radioList), [a, b]);
  assert.deepEqual(plain(aps[0].bands), ["2.4 GHz", "5 GHz"]);
  assert.equal(H.value(spots[0], "oneAP", filter("N", { bssid: "K", radios: new Set([a, b]) })), -40);
});

test("same channel clashes", () => {
  const ap = (key, band, ch, width = 20) => ({ key, bssid: key, ssid: "N", channel: ch, band, widthMHz: width, best: -50, spotsHeard: 5, x: 0, y: 0,
    radioList: [key], bandReadings: [r("N", key, -50, ch, band, width)] });
  const rr = (key, rssi, band = "5 GHz", ch = 36, w = 80) => r("N", key, rssi, ch, band, w);
  const aps = [ap("A", "5 GHz", 36, 80), ap("B", "5 GHz", 44, 80), ap("C", "5 GHz", 149, 80), ap("E", "5 GHz", 36, 80)];
  const spots = [spot(0, 0, [rr("A", -55), rr("B", -65, "5 GHz", 44), rr("E", -85)]), spot(1, 0, [rr("A", -60), rr("B", -68, "5 GHz", 44), rr("C", -40, "5 GHz", 149)]),
    spot(2, 0, [rr("A", -80), rr("E", -50)])];
  const cs = H.channelClashes(aps, spots);
  assert.equal(cs.length, 1);
  assert.deepEqual([cs[0].a, cs[0].b].sort(), ["A", "B"]);
  assert.equal(cs[0].label, "ch 36 and 44");
  assert.equal(cs[0].spots, 2);
  assert.equal(H.channelClashes(aps, spots, -90).length, 3);
  const two = [ap("A", "2.4 GHz", 1), ap("B", "2.4 GHz", 11)];
  assert.equal(H.channelClashes(two, [spot(0, 0, [rr("A", -40, "2.4 GHz", 1, 20), rr("B", -40, "2.4 GHz", 11, 20)])]).length, 0);
});

test("white background is removed, coloured areas stay", () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 204, 204, 255, 220, 220, 220, 255]);
  H.stripBackground(px);
  assert.ok(px[3] < 13);           // paper: clear
  assert.ok(px[7] > 242);          // wall: kept
  assert.ok(px[11] > 242);         // light red: kept (coloured)
  assert.ok(px[15] > 0 && px[15] < 255);   // light grey: faded
  const w = H.whitened(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]));
  assert.deepEqual([...w], [255, 255, 255, 255, 255, 255, 255, 0]);
});

test("layout at different zooms", () => {
  const plan = { width: 1600, height: 1000 }, win = { width: 800, height: 800 };
  const fit = H.layout(plan, win, 1);
  near(fit.k, 0.5); assert.deepEqual(plain(fit.size), win); near(fit.origin.x, 0); near(fit.origin.y, 150);
  const z4 = H.layout(plan, win, 4);
  near(z4.k, 2); near(z4.size.width, 3200); near(z4.size.height, 2000); assert.deepEqual(plain(z4.origin), { x: 0, y: 0 });
  for (const z of [1, 2.5, 8]) {
    const L = H.layout(plan, win, z), sx = L.origin.x + 400 * L.k, sy = L.origin.y + 300 * L.k;
    near((sx - L.origin.x) / L.k, 400); near((sy - L.origin.y) / L.k, 300);
  }
});

test("a new plan size moves spots and scale with it", () => {
  const s = H.newSurvey("Floor 1");
  s.spots = [spot(5, 6, [])];
  s.scale = { pixelsPerUnit: 4, metres: false };
  H.rescale(s, 200, 100);
  near(s.spots[0].x, 5 * 200 / 1600); near(s.spots[0].y, 6 * 100 / 1000);
  assert.equal(s.planWidth, 200);
  near(s.scale.pixelsPerUnit, 4 * (200 / 1600 + 100 / 1000) / 2);
  near(H.pixelsPerUnit(300, 30, true), 10);
  assert.equal(H.wrap(270), -90);
});

test("saving again finds the same organization entry", () => {
  const org = "ORG", other = "OTHER", heat = "HEAT";
  const t = { header: [], rows: [] };
  const linked = { orgID: org, kind: "heatmap", title: "Wi-Fi heatmap · Floor 1", table: t, heatmapID: heat };
  const old = { orgID: org, kind: "heatmap", title: "Wi-Fi heatmap · Floor 2", table: t };
  const elsewhere = { orgID: other, kind: "heatmap", title: "Wi-Fi heatmap · Floor 1", table: t };
  const list = [elsewhere, old, linked];
  assert.equal(heatmapEntry(heat, "Wi-Fi heatmap · Floor 1 renamed", org, list), 2);
  assert.equal(heatmapEntry("NEW", "Wi-Fi heatmap · Floor 2", org, list), 1);
  assert.equal(heatmapEntry("NEW", "Wi-Fi heatmap · Floor 3", org, list), -1);
  assert.equal(heatmapEntry(heat, "x", "ANOTHER", list), -1);
});

test("older heatmap files still load", () => {
  const s = H.normalize({ id: "X", name: "Old", spots: [], overlay: { cx: 10, cy: 20, width: 300, rotation: 5, opacity: 0.8, stripped: true } });
  assert.equal(s.overlay.width, 300); assert.equal(s.overlay.white, false); assert.equal(s.overlay.mapOpacity, 1);
  assert.deepEqual(plain(s.apOverrides), {}); assert.equal(s.planWidth, 1600);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
}
console.log(`${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
