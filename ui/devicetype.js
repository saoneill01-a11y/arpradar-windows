// The Type column: what kind of thing each device is (same rules as the Mac's DeviceType.swift).
// Guessed from the UniFi map, then names and models, then the maker, then being the DHCP server
// (usually the router), then open ports. Right-click › Type sets it by hand (data.types, by MAC like comments).

const DEVICE_KINDS = {
  router: "Router", firewall: "Firewall", switch: "Switch", ap: "Wi-Fi AP", camera: "Camera", printer: "Printer",
  tv: "TV", speaker: "Speaker", computer: "Computer", server: "Server", nas: "NAS", phone: "Phone", tablet: "Tablet",
  watch: "Watch", deskPhone: "Desk phone", console: "Game console", smartHome: "Smart home", ups: "UPS", other: "Other",
};

/// Small line icons (14 px, currentColor), one per kind.
const KIND_ICONS = {
  router: '<rect x="1.5" y="8" width="11" height="4" rx="1"/><path d="M4 8V5M10 8V5M5 3.2a3 3 0 0 1 4 0"/>',
  firewall: '<path d="M7 1.5 2.5 3v4c0 2.8 2 4.6 4.5 5.5 2.5-.9 4.5-2.7 4.5-5.5V3z"/>',
  switch: '<rect x="1" y="4" width="12" height="6" rx="1"/><path d="M3.5 7h1M6 7h1M8.5 7h1"/>',
  ap: '<path d="M2 5.5a7 7 0 0 1 10 0M4 7.7a4 4 0 0 1 6 0"/><circle cx="7" cy="10" r=".9"/>',
  camera: '<rect x="1.5" y="4" width="8" height="6" rx="1"/><path d="m9.5 6 3-1.5v5L9.5 8"/>',
  printer: '<path d="M4 5V1.5h6V5M4 10H2.5V5h9v5H10"/><rect x="4" y="8" width="6" height="4.5"/>',
  tv: '<rect x="1.5" y="2.5" width="11" height="7.5" rx="1"/><path d="M5 12.5h4"/>',
  speaker: '<rect x="3" y="1.5" width="8" height="11" rx="1.5"/><circle cx="7" cy="8.5" r="2"/><circle cx="7" cy="4" r=".6"/>',
  computer: '<rect x="1.5" y="2" width="11" height="7.5" rx="1"/><path d="M5 12.5h4M7 9.5v3"/>',
  server: '<rect x="2" y="1.5" width="10" height="4.5" rx="1"/><rect x="2" y="8" width="10" height="4.5" rx="1"/><path d="M4 3.8h1M4 10.3h1"/>',
  nas: '<rect x="3" y="1.5" width="8" height="11" rx="1"/><path d="M5 4h4M5 6.5h4"/><circle cx="7" cy="10" r=".7"/>',
  phone: '<rect x="4" y="1" width="6" height="12" rx="1.3"/><path d="M6.3 11h1.4"/>',
  tablet: '<rect x="2.5" y="1" width="9" height="12" rx="1.3"/><path d="M6.3 11h1.4"/>',
  watch: '<rect x="4" y="3.5" width="6" height="7" rx="1.5"/><path d="M5 3.5 5.5 1h3L9 3.5M5 10.5l.5 2.5h3l.5-2.5"/>',
  deskPhone: '<path d="M2 5c0-1.5 2.2-2.5 5-2.5S12 3.5 12 5l-2 .8L9 4.5H5L4 5.8z"/><rect x="2.5" y="7" width="9" height="5" rx="1"/>',
  console: '<path d="M4 4h6a3 3 0 0 1 3 3.5L12.5 10a1.6 1.6 0 0 1-2.8.7L8.5 9h-3l-1.2 1.7A1.6 1.6 0 0 1 1.5 10L1 7.5A3 3 0 0 1 4 4z"/><path d="M4 6v2M3 7h2"/>',
  smartHome: '<path d="M5 9.5C4 8.6 3.5 7.6 3.5 6.3a3.5 3.5 0 0 1 7 0c0 1.3-.5 2.3-1.5 3.2V11h-4z"/><path d="M5.5 12.8h3"/>',
  ups: '<rect x="3" y="1.5" width="8" height="11" rx="1"/><path d="M7.5 3.5 5.5 7.5h3l-2 3.5"/>',
  other: '<rect x="2" y="2" width="10" height="10" rx="1.5" stroke-dasharray="2 1.5"/>',
};
const kindIcon = k => `<svg class="kind-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[k] || ""}</svg>`;

const DeviceType = (() => {
  // Names, models, descriptions. Specific kinds first: "Nintendo Switch" is a console, not a switch.
  const textRules = [
    ["console", ["xbox", "playstation", "ps4", "ps5", "nintendo"]],
    ["firewall", ["sophos", "xgs", "fortigate", "fortinet", "pfsense", "opnsense", "sonicwall", "watchguard", "firebox", "palo alto", "firewall"]],
    ["router", ["gateway", "router", "udm", "udr", "uxg", "usg", "ucg", "dream machine", "dream router", "cloud gateway",
                "edgerouter", "er-x", "mikrotik", "routeros", "fritz!box", "eero", "orbi"]],
    ["ap", ["access point", "uap", "u6", "u7", "nanohd", "flexhd", "ac lite", "ac pro", "ac lr", "eap\\d*", "wap", "ap"]],
    ["camera", ["camera", "cam", "uvc", "g3", "g4", "g5", "g6", "doorbell", "ipcam", "ipc", "hikvision", "dahua", "reolink", "amcrest", "wyze", "arlo", "blink"]],
    ["printer", ["printer", "laserjet", "officejet", "deskjet", "pagewide", "pixma", "imageclass", "maxify", "workforce",
                 "ecotank", "mfc-?\\w*", "hl-\\w+", "dcp-\\w+", "brn\\w*", "npi\\w*", "bizhub", "taskalfa", "ecosys", "imagerunner",
                 "xerox", "lexmark", "zebra", "dymo", "label printer"]],
    ["nas", ["nas", "diskstation", "ds\\d{3,4}\\+?", "rs\\d{3,4}\\+?", "synology", "qnap", "truenas", "freenas", "unraid", "readynas", "terramaster", "asustor"]],
    ["server", ["server", "cloud key", "unvr", "nvr", "esxi", "proxmox", "idrac", "ilo", "ipmi", "hyper-v", "dc\\d+", "vcenter", "pihole", "pi-hole"]],
    ["switch", ["switch", "usw", "flex mini", "catalyst", "procurve", "nexus", "edgeswitch", "gs\\d{3}\\w*", "sg\\d{3}\\w*", "cbs\\d{3}"]],
    ["tv", ["tv", "bravia", "roku", "chromecast", "fire tv", "firetv", "fire stick", "apple tv", "appletv", "shield", "vizio", "webos", "tizen", "android tv", "google tv"]],
    ["speaker", ["sonos", "homepod", "echo", "alexa", "google home", "nest mini", "nest audio", "nest hub", "speaker", "soundbar", "heos", "denon", "bose", "marantz"]],
    ["deskPhone", ["polycom", "yealink", "grandstream", "snom", "ip phone", "sip-?\\w*", "voip", "obihai", "cisco cp-\\w+"]],
    ["tablet", ["ipad", "tablet", "kindle", "fire hd", "galaxy tab"]],
    ["watch", ["watch"]],
    ["phone", ["iphone", "galaxy", "pixel", "android", "oneplus", "motorola", "moto", "phone"]],
    ["ups", ["ups", "smart-ups", "apc", "eaton", "cyberpower", "network management card"]],
    ["smartHome", ["hue", "shelly\\w*", "tasmota", "esphome", "esp32", "esp8266", "esp-\\w+", "ecobee", "nest", "thermostat", "plug", "bulb",
                   "kasa", "\\w*homeassistant\\w*", "hs\\d{3}", "kp\\d{3}", "ep\\d{2}", "myq", "wemo", "lutron", "caseta", "home assistant",
                   "hubitat", "smartthings", "tuya", "zigbee", "z-wave", "zwave", "sensor", "garage", "sprinkler", "rachio", "ring"]],
    ["computer", ["macbook", "imac", "mac mini", "mac-mini", "macmini", "mac studio", "mac pro", "desktop-\\w+", "laptop-\\w+", "laptop",
                  "desktop", "\\w+-pc", "pc", "windows", "thinkpad", "workstation", "ubuntu", "debian", "raspberry", "raspberrypi", "chromebook"]],
  ].map(([k, words]) => [k, new RegExp(`(?:^|[^a-z0-9])(?:${words.join("|")})(?:$|[^a-z0-9])`)]);

  // Makers of mostly one kind of thing. Makers of many kinds (Apple, Samsung, TP-Link, Netgear, Cisco,
  // Ubiquiti, Amazon, Google, HP) are left to the name and ports.
  const vendorRules = [
    ["printer", ["brother", "canon", "seiko epson", "epson", "lexmark", "xerox", "kyocera", "ricoh", "zebra", "konica"]],
    ["camera", ["hikvision", "dahua", "axis comm", "amcrest", "reolink", "wyze", "hanwha", "arlo", "lorex", "uniview", "vivotek", "mobotix"]],
    ["firewall", ["sophos", "fortinet", "sonicwall", "watchguard", "palo alto", "netgate", "check point"]],
    ["router", ["mikrotik", "routerboard", "avm", "eero"]],
    ["tv", ["roku", "vizio", "tcl", "hisense", "lg electronics"]],
    ["console", ["nintendo", "sony interactive"]],
    ["speaker", ["sonos", "bose", "sound united", "denon"]],
    ["nas", ["synology", "qnap", "asustor", "western digital", "terramaster"]],
    ["deskPhone", ["polycom", "yealink", "grandstream", "mitel", "avaya", "snom", "obihai"]],
    ["ups", ["american power conversion", "eaton", "cyber power"]],
    ["smartHome", ["espressif", "tuya", "shelly", "allterco", "signify", "philips lighting", "ecobee", "nest labs", "lutron", "chamberlain", "ring llc", "resideo", "honeywell home"]],
    ["server", ["vmware", "super micro", "supermicro"]],
    ["computer", ["raspberry pi", "intel corporate", "dell", "lenovo", "micro-star", "gigabyte", "asustek", "framework computer"]],
  ];

  function fromText(t) {
    if (!t) return null;
    for (const [k, rx] of textRules) if (rx.test(t)) return k;
    return null;
  }
  function fromVendor(v) {
    if (!v) return null;
    for (const [k, makers] of vendorRules) if (makers.some(m => v.includes(m))) return k;
    return null;
  }
  function fromPorts(ports) {
    const p = new Set(ports || []);
    if (p.has(9100) || p.has(631) || p.has(515)) return "printer";
    if (p.has(554)) return "camera";
    if (p.has(3389)) return "computer";
    if (p.has(5060)) return "deskPhone";
    if (p.has(8008) || p.has(8009)) return "tv";
    if (p.has(445) || p.has(139) || p.has(548) || p.has(5900)) return "computer";
    return null;
  }

  // The table asks on every redraw and sort, so guesses are remembered by their inputs.
  const cache = new Map();
  function guessWithoutMap(d, isDhcp) {
    const names = Object.values(d.names || {});
    const key = JSON.stringify([d.name, d.upnp, d.ubntModel, d.snmpName, d.webTitle, d.snmpDescr, names.sort(), d.vendor, d.openPorts, isDhcp]);
    if (cache.has(key)) return cache.get(key);
    const first = (d.snmpDescr || "").split("\n")[0];
    const text = [d.name, d.upnp, d.ubntModel, d.snmpName, d.webTitle, first, ...names].filter(Boolean).join(" | ").toLowerCase();
    const vendor = (d.vendor || "").toLowerCase();
    let k = fromText(text) || fromVendor(vendor);
    // TP-Link with nothing open is almost always a Kasa or Tapo plug, switch or bulb.
    if (!k && vendor.includes("tp-link") && !(d.openPorts || []).length && !d.name) k = "smartHome";
    if (!k && isDhcp) k = "router";
    if (!k) k = fromPorts(d.openPorts);
    if (cache.size > 20000) cache.clear();
    cache.set(key, k);
    return k;
  }

  /// The guess. `mapKind`: what the UniFi map says (router, switch, ap); `isDhcp`: it's the network's DHCP server.
  function guess(d, { mapKind = null, isDhcp = false } = {}) {
    const g = guessWithoutMap(d, isDhcp);
    // The map calls every gateway a gateway; keep "Firewall" for a Sophos or FortiGate.
    if (mapKind) return mapKind === "router" && g === "firewall" ? "firewall" : mapKind;
    return g;
  }

  return { guess, fromText, fromVendor, fromPorts };
})();

if (typeof module !== "undefined") module.exports = { DeviceType, DEVICE_KINDS };
