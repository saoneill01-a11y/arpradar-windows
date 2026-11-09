# The .arpradar file (File › Export Scans… / Import Scans…)

Shared by ARPradar for Mac and ARPradar for Windows, so saved scans can move between them. Plain JSON, UTF-8.
Both apps write exactly this; both read it and ignore keys they don't know (so later versions can add keys).

```json
{
  "format": "arpradar-scans",
  "version": 1,
  "exported": "2026-11-06T21:40:00Z",
  "app": "ARPradar 0.6.0 for Windows",
  "scans": [
    {
      "name": "Main office",
      "organization": "Example Clinic",
      "range": "10.20.30.1-254",
      "nameServer": "10.20.30.10",
      "dhcpRange": "10.20.30.100-199",
      "notes": "VPN: Example Clinic",
      "devices": [ DEVICE, ... ],
      "lastScan": { "date": "2026-11-06T21:30:00Z", "range": "10.20.30.1-254", "devices": [ DEVICE, ... ] }
    }
  ]
}
```

- `organization`: the organization's name, or `null` (or left out) for a standalone scan. Matched by name on import (created when
  missing).
- `devices`: every device the saved scan remembers (gives offline rows and NEW badges).
- `lastScan`: may be `null`.
- Dates are ISO 8601 in UTC (`2026-11-06T21:30:00Z`; fractions of a second allowed).

DEVICE:

```json
{
  "ip": "10.20.30.10", "mac": "00:1A:2B:00:00:0A", "name": "NAS-01", "vendor": "Sample Storage Inc.",
  "names": { "NetBIOS": "NAS-01", "Bonjour": "nas-01" },
  "openPorts": [22, 80, 445],
  "firstSeen": "2026-11-01T10:00:00Z", "lastSeen": "2026-11-06T21:30:00Z",
  "webTitle": "", "upnp": "", "snmpName": "", "snmpDescr": "", "snmpLocation": "",
  "ipv6": ["2001:db8::10"],
  "banners": { "22": "OpenSSH 9.6" },
  "thisComputer": false
}
```

Only `ip` is required; anything missing or `null` means empty (the Mac app leaves empty values out, the Windows
app writes them). The Mac's `isThisMac` and Windows' `thisPc` are both
`thisComputer` here. Favorites, comments, History and Wake Remote PC lists are not part of the file.
