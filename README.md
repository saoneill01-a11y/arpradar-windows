# ARPradar for Windows

The Windows version of [ARPradar](https://arpradar.com), a free network scanner. It finds every device on a
network and names it: maker, type, open ports, shares, web pages. Save scans per client or site, rescan later and
see what changed, draw a network map from a UniFi controller, and use the built-in Ping, Traceroute, DNS and Wi-Fi
tools. The Mac version is in [arpspy](https://github.com/saoneill01-a11y/arpspy).

Built with [Tauri 2](https://tauri.app): a Rust engine (`src-tauri/`) with the window drawn as a web page (`ui/`).
Built by a network engineer with [Claude Code](https://claude.com/claude-code).

## Download

Get the installer from [arpradar.com](https://arpradar.com). Windows 10 and 11, 64-bit.

## Build it

GitHub Actions builds the installer on every change (`.github/workflows/build.yml`): open the latest **Build** run
and download **ARPradar-Windows-installer**. To build on a Windows PC yourself you need
[Rust](https://rustup.rs), [Node.js](https://nodejs.org) and the Tauri prerequisites, then:

```
npm install
npx tauri build
```

`ui/mock.js` is a demo backend: serve the `ui/` folder with any web server and open it in a browser to try the
window with made-up data.

## License

ARPradar is free software under the [GNU General Public License v3.0 or later](LICENSE.txt). Copyright (C) 2026
Sean O'Neill. `NOTICE.txt` is the text the installer and Help › License show.

ARPradar sends traffic to the devices it scans. Use it only on networks you own or have permission to scan.
