// Help › ARPradar Help (F1): the Mac app's help topics, written for Windows.
// Step text uses **bold** for menu items and buttons and `code` for things to type. `adv` marks a step that needs
// Advanced mode; `advancedOnly` a whole topic. When a menu name or shortcut changes, update this too.
"use strict";

const HELP_TOPICS = [
  { id: "start", title: "Getting started", lead: "Find everything on a network in about ten seconds.", steps: [
    { t: "Pick the **Network adapter** at the top (Wi-Fi, Ethernet, USB or VPN). ARPradar fills in the **IP range** for its subnet. In Basic, it uses the network this PC is on.", adv: true },
    { t: "To scan a different subnet, type it in the **IP range** box: `192.168.1.1-254`, `10.0.0.0/24`, or several separated by commas. Press Enter or **Scan**." },
    { t: "Click **Scan** (Ctrl+Enter). Click **Stop** to end early." },
    { t: "Columns: **Name**, **Type** (printer, switch, camera, TV…: a best guess from the name, maker, model and open ports), **IP**, **MAC**, **Vendor** (from the MAC address), **Description** (what the device says it is), **Open ports**, **Response** (ping time, hidden at first) and **Comment**. Right-click a column header to show or hide columns. Drag the right edge of **Name** to widen it. **View › Type Column** turns the Type column on or off (on at first). **View › Switch Port Column** (off at first) shows where each device plugs in: the UniFi switch and port, or the access point for Wi-Fi; it needs a UniFi controller (see the Map topic). Both are also in **Settings › General**." },
    { t: "Green dot: the device answered this scan. **Red dot**: seen before, but not found this time. **NEW**: the first time this saved scan has seen it. A new, unsaved scan remembers nothing, so it has no red dots or NEW badges; to compare with last time, pick the saved scan from **Saved Scans** and scan again." },
    { t: "The **Show offline** switch in the bottom bar hides the red rows. **Forget Offline…** removes them all for good (it asks first); right-click one red row › **Forget This Device** removes just that one (favorites are kept either way)." },
    { t: "The **Search** box (Ctrl+F, or File › Find Device) filters by name, type, IP, MAC, vendor, port or comment. While it hides rows, the bottom bar says how many; **Show all** clears it. It clears itself when you start a new scan or open another saved scan." },
    { t: "The first scan may bring up a Windows Firewall question. Choose **Private networks**, or names from Bonjour and NetBIOS may not come through." },
  ] },
  { id: "sites", title: "Saved scans", lead: "Save a network once and scan it again any time. Each saved scan keeps its own devices, so two clients on the same subnet never mix.", steps: [
    { t: "ARPradar always opens as a new, unsaved scan of this PC’s network. **New Scan** (next to Scan, Ctrl+N) starts over the same way; type another subnet in **IP range** to scan that instead. Then click **Scan**. After a scan the button reads **Rescan** (Ctrl+R) while the IP range is unchanged. Typing a different range while a saved scan is open scans it as a new, unsaved scan, so the saved one isn’t changed." },
    { t: "When it finishes, a bar asks to save it: **Save to Organization…**, **Save Standalone…** or **Not Now**. You can also use **File › Save Scan…** (Ctrl+S) later." },
    { t: "**Save to Organization**: pick the organization first (or **New Organization…**, which asks for its name, domains, name server and DHCP range), then a scan name like “Main office”. A scan in an organization uses the organization’s name server and DHCP range. **Save Standalone** is for a scan that doesn’t belong to anyone: it has its own name server and DHCP range." },
    { t: "**Saved Scans** (beside Search) lists saved scans under each organization, then **Standalone**. Pick one to see its devices, then click **Scan** to scan that network again and update it." },
    { t: "**Edit This Scan…** changes the name, range and organization (or **Standalone**). **Delete This Scan…** removes it. **File › Open Recent** brings back the last 5 scans, saved or not; **Clear Menu** empties the list but keeps History." },
    { t: "After a scan the status bar shows the network’s **DHCP server** and **name servers** (also as badges by those devices). They come from this PC’s DHCP lease; over a VPN, devices with the DNS port open count instead (not Apple TVs or HomePods). In an organization, a bar offers to use a name server it found when the organization’s is blank or different." },
    { t: "**Normal / Quiet** (next to the network adapter): a Quiet scan sends far less, for networks with an IDS or touchy devices. It pings a few addresses at a time, keeps 16 connections open at once, checks 5 ports per device (SMB, HTTP, HTTPS, SSH, RDP), skips web pages (read when you open a device’s details) and the knock on devices that ignore ping, and asks SNMP only when the organization has its own community. A /24 takes longer, finds fewer types, and can miss devices that ignore ping over a VPN. Set **Scan style** in an organization’s Settings to start all its scans (and surveys, without the speed test) in Quiet.", adv: true },
    { t: "**SNMP community**: the read-only community that network’s switches, printers and UPSes answer to. It belongs to the organization (or the standalone scan), so it is only ever sent on that network; a new, unsaved scan sends `public`.", adv: true },
    { t: "**Name server**: that network’s DNS server (a domain controller, Pi-hole or router, e.g. `10.0.0.5`). ARPradar asks it for device names. Handy over a VPN.", adv: true },
    { t: "**DHCP range**: the DHCP server’s pool, e.g. `10.0.0.100-10.0.0.199` (several allowed, separated by commas). Turn on **Mark outside DHCP** in the bottom bar and addresses outside the pool turn purple, so fixed addresses stand out. Exports get an **In DHCP range** column.", adv: true },
    { t: "**Saved Scans › Edit Scan List…** (Ctrl+Alt+S) shows every saved scan: edit them, move them to an organization, **Duplicate**, **Clear Devices**, or delete several at once (Ctrl+click to pick several)." },
  ] },
  { id: "share", title: "Sharing scans with a Mac", lead: "Move saved scans between ARPradar on Windows and ARPradar on a Mac, or another PC.", steps: [
    { t: "**File › Export Scans…**: tick the saved scans and save the .arpradar file somewhere the other computer can reach (OneDrive works)." },
    { t: "On the other computer: **File › Import Scans…** and pick the file. Tick the scans to bring in." },
    { t: "A scan that already exists there is **Keep both** at first (the copy gets a number after its name); choose **Replace mine** to swap it in over yours. The button says how many will replace yours. Organizations that don’t exist yet are created." },
    { t: "Each scan brings its settings, remembered devices (for offline rows and NEW badges) and last scan. Favorites, comments, History and Wake Remote PC lists stay on each computer." },
  ] },
  { id: "device", title: "Device details and right-click", lead: "Everything you can do with one device.", steps: [
    { t: "Select a device and press Ctrl+I (or double-click it) for the details panel: names, MAC, IPv6, shares, model and open ports. Drag its left edge to make it wider." },
    { t: "The details panel ends with **Actions**: Open in Browser, Shares, SSH, RDP, Scan Ports, Ping, Wake, Copy IP, Copy MAC and Copy All. The bottom bar says what was copied." },
    { t: "Right-click a device for **Open in Browser** and **Open Shares in Explorer**. Shares are listed with your Windows login, so domain PCs show theirs too." },
    { t: "**SSH in Terminal** (Windows Terminal), **Remote Desktop (RDP)** and **Screen Sharing (VNC)** (needs a VNC viewer such as TightVNC or RealVNC).", adv: true },
    { t: "**Scan Ports…** opens in its own window and checks the common ports, all 65535, or a list like `1-1024`. You can keep using the main window while it runs.", adv: true },
    { t: "**Ping** opens the Ping tool with the address filled in. **Traceroute** and **DNS Lookup** do the same in Advanced." },
    { t: "**Wake on LAN** wakes a sleeping device on this network." },
    { t: "**Save for Remote Wake…** adds the device to **File › Wake Remote PC…** (Ctrl+Shift+W), to wake it later over a VPN. ARPradar then checks for 2 minutes whether it woke up.", adv: true },
    { t: "Click the ☆ (or right-click › **Add to Favorites**) to keep a device in the **Favorites** tab." },
    { t: "Double-click the **Comment** cell and type a note. It’s saved with the device." },
    { t: "Wrong type? Right-click › **Type ▸** and pick the right one. **Automatic** goes back to the guess." },
  ] },
  { id: "orgs", title: "Organizations and site survey", lead: "Keep each client’s saved scans and test results together.", advancedOnly: true, steps: [
    { t: "**File › New Organization…** (Ctrl+Shift+N): a name, domain names, notes and a first scan." },
    { t: "**Save and Run Survey** runs Connection Info, Wi-Fi, a network scan, a speed test, DNS lookups and an expiry check for each domain, and a traceroute to 1.1.1.1. It takes about a minute. Untick any you don’t need." },
    { t: "**Saved Scans › Organizations…** (Ctrl+K) lists everything saved, newest first, with each survey’s results under it. Double-click to open one; **Edit Note…** adds a note. **Run Survey…** runs another one." },
    { t: "Every time you scan one of its saved scans, the results are added to the organization automatically." },
    { t: "Each organization has a **Settings** box: domains, name server, DHCP range and notes. Its scans use that name server and DHCP range. It also shows the DHCP server and name servers seen on its last scan." },
    { t: "On an organization’s page: **New Network Scan**, **New DNS Lookup** (its domain), **New Port Scan** (asks for an IP) and **New…** (Ping, Traceroute, Speed Test, Connection Info, Wi-Fi). Anything started there is saved to that organization automatically when it finishes; its button reads **Saves to …**, then **Saved to … ✓**. Ping and Wi-Fi keep running, so save them yourself." },
    { t: "Every tool has a **Save to Organization** button." },
    { t: "**Export Organization (Excel)…** makes one workbook: an overview sheet plus a sheet for each saved result." },
  ] },
  { id: "map", title: "Network map (UniFi and SNMP)", lead: "See how switches and access points are connected, and what’s on each port and access point.", advancedOnly: true, steps: [
    { t: "After a scan, click **Map** (its own button next to Results, Favorites and History). The gateway is at the top, then switches and access points (purple border), each with its wired and Wi-Fi clients. Click a box to see its ports and clients on the right. Click the **12 wired · 3 Wi-Fi** label under a box to list its clients and the port each one is on." },
    { t: "Pinch on the touchpad or hold **Ctrl** and scroll to zoom, or use **−** and **+**. **Fit** shows the whole width, and you can’t zoom out further than that. **Full | Compact** switches between full tiles and small ones that show just the name (cut short if needed) and IP address." },
    { t: "For the real cabling, connect the **UniFi controller** (Cloud Key, UDM, Cloud Gateway or a self-hosted Network app): click **Connect UniFi…**, enter its address and an API key. Make the key in UniFi Network under **Settings › Control Plane › Integrations › Create API Key**. ARPradar only reads; it never changes anything." },
    { t: "The key is kept in Windows Credential Manager on this PC, never in ARPradar’s files or exports." },
    { t: "ARPradar remembers the controller’s certificate the first time it connects and refuses to talk to it if the certificate changes later (that is what a man-in-the-middle looks like). If you replaced the controller or its certificate on purpose, open **UniFi Controller…** and choose **Forget Certificate**, then connect again." },
    { t: "In an organization, the controller goes in its **Settings** (UniFi controller row) and every scan in it uses it. For other scans, a controller is used when its address is inside the scanned range." },
    { t: "Labels on the lines: **P1 ⇄ P8 · 1G** means port 1 on the switch above, port 8 on this one, at 1 Gb. Line colours show the speed: **blue** 10 Gb, **light blue** 2.5 or 5 Gb, **green** 1 Gb, **orange** 100 Mb or less (on a switch or access point, usually a bad cable or jack). **Dashed** lines are wireless (mesh), or every line when there is no controller." },
    { t: "**Unmanaged switch?** appears when several devices share one switch port and none of them is UniFi: a small unmanaged switch, or a computer running virtual machines." },
    { t: "**Other brands** (Cisco, Aruba/HP, Netgear, TP-Link, Juniper and most managed switches): turn on SNMP (v2c, read-only) on the switches and put the same community in the organization’s **Settings** (or the standalone scan). ARPradar reads each switch’s MAC address table and LLDP neighbours, works out which switch plugs into which, and puts every device on its switch and port. This mixes with a UniFi controller on the same map. **Details** in the map’s top bar shows what each switch answered." },
    { t: "A switch’s uplink is the port where it sees the gateway; a device goes on the port where it was seen with the fewest others. When the gateway is a layer-3 core switch, it sits at the top of the map with its ports. Cisco switches keep a MAC table per VLAN; ARPradar reads each one (up to 64 VLANs) with the same community." },
    { t: "With no controller and no SNMP switches, the map lists the Ubiquiti devices the scan found, under the gateway, with no cabling. Ubiquiti cameras, consoles and airMAX radios tell ARPradar their name, model and firmware; adopted UniFi switches and access points don’t." },
    { t: "**Export…** saves the map as PNG, PDF or SVG, or every switch port as an Excel sheet. The map is saved with the scan, so History and Open Recent show it again." },
  ] },
  { id: "tools", title: "Tools", lead: "The Tools menu. Each opens in its own window. Right-click a device to open some of them with its address filled in.", steps: [
    { t: "**Ping** (Ctrl+1): several addresses at once, with a live chart." },
    { t: "**Traceroute** (Ctrl+2) shows each hop to an address.", adv: true },
    { t: "**DNS Lookup** (Ctrl+3). **All** checks the usual records and about 100 common names (MX, SPF, DMARC, autodiscover, portal, sso, SRV…) in one go. **Follow CNAMEs to other domains** also shows where they lead. **Find subdomains** adds every name the domain has had an HTTPS certificate for (from the public certificate logs). Pick any server, or a saved scan’s name server. Results come in a box per record type (A, AAAA, CNAME, MX, NS, TXT…), sorted by name; click a box’s heading to fold it. **Download** writes CSV or Excel (with a Type column).", adv: true },
    { t: "Type a domain or paste a web address once in the box at the top of **DNS Lookup** and click **Check all**: Look Up, Email Check, Compare Servers and Expiry all run for it. Each tab shows ✓ when done, or an orange ⚠ when something is worth a look. An IP address only runs Look Up (its name). While they run the button reads **Stop**. Double-click an answer to copy it, or use **Copy** for all of them.", adv: true },
    { t: "DNS Lookup’s other tabs: **Email Check** (SPF with its lookup count, DMARC, DKIM, MX, MTA-STS, TLS reports, DNSSEC, each with a plain-English verdict), **Compare Servers** (the same question to several servers, including the domain’s own, to spot differences), **Expiry** (domain registration and the HTTPS certificates on its usual hosts) and **Reverse Subnet** (the name of every address in a range).", adv: true },
    { t: "**Wi-Fi Signal** (Ctrl+4): signal, quality and channel. Windows hides network names until Location is allowed for desktop apps: click **Open Location Settings**." },
    { t: "**Wi-Fi Analyzer** (Ctrl+5): nearby networks and how their channels overlap.", adv: true },
    { t: "**Wi-Fi Heatmap** (Ctrl+Alt+4): load a floor plan, click where you’re standing as you walk, and ARPradar colors the map by signal, access points heard, channel overlap or ping time. Export PNG or save it to an organization. Each spot takes about 8 seconds (three Wi-Fi scans). Windows only shows nearby networks after Location is allowed for desktop apps." },
    { t: "No floor plan? **Floor Plan › From a Picture or PDF…** loads a plan of the building, or **From a Map Picture…** uses a map or satellite picture of the area that you’re allowed to use (Windows has no built-in map yet). Then **Set Scale**: click both ends of a wall you know the length of and type it." },
    { t: "On the **Map** tab each access point is one small Wi-Fi icon (its 2.4, 5 and 6 GHz radios together). A faded icon with a **?** is ARPradar’s estimate from where it was loudest; it only shows once the AP was heard at 3 spots or more. **Drag the icon to where the access point really is** and it turns solid and stays there (right-click › **Use Estimated Position** to undo). Hover over an icon for its name; click it for its details. With a UniFi controller connected, access points get their UniFi names." },
    { t: "**Click a measured spot** for what was heard there: your network’s access points and signal on each band, the one you were connected to, ping and the time. **Click an access point** for its bands, channels, best signal and how many spots heard it, with **Show Only This** and **Name…**." },
    { t: "**Highlight › Same channel** (Map tab sidebar) hides the heat colours and measured spots so only the floor plan and access points show. Pick a band (2.4, 5 or 6 GHz) and each access point gets a channel tag. A **red** tag means it shares that channel with another of your access points and both were strong (−70 dBm or better) at the same spots, so there they take turns talking and both slow down. **Green** means its channel is clear. Point at an access point to draw lines to the ones it clashes with." },
    { t: "The **Floor plan** slider (Map tab sidebar) fades the plan so the heat colours show through." },
    { t: "**Floor Plan › Lay a Floor Plan Over the Map…**: pick a picture or PDF of the building. ARPradar removes its white background and puts it on the map picture (it asks for one first if there isn’t one). Drag it onto the building, then use **Size** and **Turn** until the walls sit on the roof lines; Ctrl+scroll over the plan sizes it. **Zoom** (or Ctrl+scroll over the map) gets in close. **Plan** sets how solid the plan is and whether its lines are **Black** or **White**; **Map** fades the map picture. **Adjust Floor Plan Overlay…** lines it up again later; **Remove Floor Plan Overlay** takes it off." },
    { t: "One access point showing up twice (its 2.4 and 5 GHz radios apart)? Right-click one › **Combine With** › the other. Two access points lumped together? Right-click › **Separate Radios**. **Undo Combine or Separate** goes back to ARPradar’s own grouping. Names and placed positions carry over." },
    { t: "Zoom in on the plan with the slider under it (or − and +), with the mouse wheel, by pinching on the touchpad, or with Ctrl+scroll. Two-finger scrolling moves around. **Fit** shows the whole plan again." },
    { t: "A heatmap saves itself as you measure. The heatmap menu (top left) lists them by organization, then **Standalone**. Open one from an organization’s **Wi-Fi Heatmaps** tab to see its floor plan and measure more; **Update in <organization>** saves the new spots over its entry there. **Save as New Heatmap…** starts a separate copy (same floor plan and spots) that stays standalone until you save it to an organization." },
    { t: "**Connection Info** (Ctrl+6): DHCP server and lease, DNS, gateway and **Renew DHCP Lease…** (Windows asks for permission). Your public IP is looked up only when you click **Look Up**." },
    { t: "**Speed Test** (Ctrl+7) uses Cloudflare’s speed test servers and keeps a history. “Busy” latency is measured while downloading." },
    { t: "**Subnet Calculator** (Ctrl+8): type an address and mask; **Scan This Range** sends it to the main window.", adv: true },
  ] },
  { id: "export", title: "History and exporting", lead: "Look back at old scans and take the list with you.", steps: [
    { t: "The **History** tab keeps the last 50 scans. Pick one to look at it; go back to **Results** (or click **Open in Results**) and it stays there, so you can rescan it or export it. Right-click one › **Delete This Scan…**, or **Clear History…**; both ask first.", adv: true },
    { t: "**File › Export as CSV…** (Ctrl+E) or **Export as Excel (.xlsx)…** (Ctrl+Shift+E). Both are also under **Export…** in the bottom bar." },
    { t: "**Copy** in the bottom bar copies the whole list, ready to paste into Excel.", adv: true },
    { t: "Right-click a device for **Copy IP**, **Copy MAC** or **Copy Row**." },
  ] },
  { id: "tray", title: "Tray icon", lead: "Keep ARPradar a click away, by the clock.", steps: [
    { t: "Turn on **File › Settings… › General › Show ARPradar in the system tray**." },
    { t: "Right-click the radar icon for the current network and how many devices are online and new, **Scan Now**, **Ping…**, **Speed Test**, **Open ARPradar** and **Quit**. Click it to open the main window." },
    { t: "With **Keep running in the tray** on, closing the main window leaves ARPradar running there. Windows may tuck the icon under the ^ arrow; drag it next to the clock to keep it visible." },
  ] },
  { id: "mode", title: "Basic and Advanced", lead: "Basic keeps the window simple. Advanced shows everything.", steps: [
    { t: "Switch with **Basic | Advanced** at the top right, or **View › Advanced Mode** (Ctrl+Alt+B)." },
    { t: "Basic hides the Network adapter field, the History tab, and the MAC, Description, Open ports and Response columns." },
    { t: "It also hides SSH, RDP, VNC, Scan Ports, Save for Remote Wake, Traceroute, DNS Lookup, Wi-Fi Analyzer, Subnet Calculator, Organizations, Save to Organization, Mark outside DHCP, Copy and the expert parts of the details panel." },
    { t: "Nothing is lost: switch back and your columns and saved data are all there." },
  ] },
  { id: "appearance", title: "Appearance", lead: "Light, dark and colour themes.", steps: [
    { t: "Use **Auto / Light / Dark** in the bottom bar, or **View** › Appearance. Auto follows Windows." },
    { t: "**File › Settings…** (Ctrl+,) › **Appearance** has the theme: Radar, Ocean, Sunset, Graphite or High contrast." },
    { t: "**Row height** (Compact, Regular, Roomy) and **Text size** (Small, Medium, Large) change the device list and details panel." },
    { t: "Themes change colours only; everything stays in the same place." },
  ] },
  { id: "trouble", title: "Permissions and troubleshooting", lead: "When something doesn’t show up.", steps: [
    { t: "**Windows protected your PC** when installing: ARPradar isn’t signed yet. Click **More info › Run anyway**." },
    { t: "**Few names?** Allow ARPradar on **Private networks** when Windows Firewall asks (or in Windows Security › Firewall › Allow an app). Over a VPN, give the organization a name server (the client’s DNS server) in its **Settings**, or a standalone scan one in **Saved Scans › Edit This Scan…**." },
    { t: "**No Wi-Fi names or nearby networks?** Settings › Privacy & security › Location: turn on **Location services** and **Let desktop apps access your location**. ARPradar never reads where you are." },
    { t: "**New-device alerts**: **File › Settings… › General › Notify me about new devices**. If nothing appears, check Windows Settings › System › Notifications." },
    { t: "**No switch or printer models?** Set the **SNMP community** in the organization’s **Settings**, or for a standalone saved scan in **Saved Scans › Edit This Scan…** (a new, unsaved scan sends `public`)." },
    { t: "**Speed Test says too many tests?** Cloudflare limits how often one network may test. Wait about an hour." },
    { t: "**VNC doesn’t open?** Install a VNC viewer (TightVNC, RealVNC or UltraVNC)." },
  ] },
];

function helpTool(root) {
  document.title = "ARPradar Help";
  let selected = HELP_TOPICS[0].id, query = "";
  const plain = t => [t.title, t.lead, ...t.steps.map(s => s.t)].join(" ").replace(/\*\*|`/g, "").toLowerCase();
  const matching = () => { const w = query.toLowerCase().split(/\s+/).filter(Boolean); return HELP_TOPICS.filter(t => w.every(x => plain(t).includes(x))); };
  const styled = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, '<code class="mono">$1</code>');
  root.innerHTML = `<div class="scanlist" style="flex:1;min-height:0"><div class="scanlist-items" style="max-height:none;display:flex;flex-direction:column">
      <div style="padding:8px"><input id="hq" type="search" placeholder="Search help" style="width:100%;height:30px;border:1px solid var(--edge);border-radius:5px;background:var(--input);padding:0 8px"></div>
      <div id="hlist" style="flex:1;overflow:auto"></div></div><div id="htopic" class="scanlist-edit" style="overflow:auto;max-width:680px"></div></div>`;
  const draw = () => {
    const list = matching();
    if (!list.some(t => t.id === selected) && list[0]) selected = list[0].id;
    $("hlist").innerHTML = list.map(t => `<button type="button" data-id="${t.id}" class="${t.id === selected ? "on" : ""}">${esc(t.title)}</button>`).join("")
      || `<p class="note" style="padding:10px">No topics match “${esc(query)}”.</p>`;
    const t = list.find(x => x.id === selected);
    if (!t) { $("htopic").innerHTML = '<p class="status">Try another word.</p>'; return; }
    const adv = advanced();
    const needs = t.advancedOnly || t.steps.some(s => s.adv);
    $("htopic").innerHTML = `<h1 style="font-size:22px;margin:0">${esc(t.title)}</h1><p class="status" style="margin:0">${esc(t.lead)}</p>
      ${!adv && needs ? `<div class="callout">${t.advancedOnly ? "This needs Advanced mode." : "Steps marked ADVANCED need Advanced mode."} Switch at the top right of the main window, or press Ctrl+Alt+B.</div>` : ""}
      ${t.steps.map((s, i) => `<div style="display:flex;gap:10px;align-items:baseline"><span style="flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:color-mix(in srgb, var(--green) 18%, transparent);color:var(--green-hi)">${i + 1}</span>
        <div style="user-select:text;-webkit-user-select:text">${styled(s.t)}${!adv && (s.adv || t.advancedOnly) ? ' <span class="badge" style="border:1px solid var(--dhcp, #b07ad0);color:var(--dhcp, #b07ad0)">ADVANCED</span>' : ""}</div></div>`).join("")}`;
  };
  $("hlist").onclick = e => { const b = e.target.closest("[data-id]"); if (b) { selected = b.dataset.id; draw(); } };
  $("hq").oninput = () => { query = $("hq").value; draw(); };
  window.addEventListener("storage", e => { if (e.key === "mode") draw(); });
  draw();
  setTimeout(() => $("hq").focus(), 0);
}
