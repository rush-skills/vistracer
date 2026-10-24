<div align="center">
  <img src="assets/logo.png" alt="VisTracer Logo" width="200"/>

  # VisTracer

  [![CI](https://github.com/rush-skills/vistracer/actions/workflows/ci.yml/badge.svg)](https://github.com/rush-skills/vistracer/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
  [![Latest Release](https://img.shields.io/github/v/release/rush-skills/vistracer)](https://github.com/rush-skills/vistracer/releases/latest)

  **[vistracer.anks.in](https://vistracer.anks.in)**

  Visual traceroute desktop application built with Tauri v2 and React. VisTracer executes traceroute locally, enriches hops with GeoIP, ASN, and external registry metadata, and animates hop-to-hop routes on a 3D globe alongside an interactive hop timeline.

  ![VisTracer Screenshot](assets/screenshot.png)
</div>

## Download

Pre-built binaries are available on the [Releases](https://github.com/rush-skills/vistracer/releases/latest) page:

| Platform | Format |
|----------|--------|
| macOS    | `.dmg`: one universal DMG for Apple Silicon and Intel (releases after v1.0.0; v1.0.0 is Apple Silicon only) |
| Windows  | `.exe` (NSIS installer) |
| Linux    | `.AppImage`, `.deb` |

Releases after v1.0.0 update themselves: VisTracer checks the latest GitHub release on start and offers **Install and restart**. Downloads are signature-checked before they are installed.

## Why a Desktop App?

VisTracer is built as a native desktop application (Tauri v2 + Rust) rather than a web app because **traceroute requires native system access**. Web browsers cannot execute system commands like `traceroute` or `tracert` for security reasons. As a Tauri app, VisTracer can:

- Spawn native traceroute/tracert processes directly on your local machine
- Access system binaries with proper permissions (ICMP requires elevated privileges)
- Read and parse real-time output from the traceroute process
- Provide a true "from your network" perspective for diagnosing connectivity issues

This architecture ensures you get authentic network diagnostics from your actual location and ISP, rather than relying on remote servers or limited browser APIs.

## Core Capabilities

- Cross-platform Tauri v2 shell with Rust backend and type-safe IPC to the React frontend.
- Native traceroute execution (ICMP/UDP/TCP) via system binaries with cancellation support.
- Streaming progress updates: each hop appears as soon as its line is parsed; DNS, GeoIP and registry lookups fill it in afterwards, so a slow lookup never holds up later hops.
- Load-balanced (multipath) hops: every responder of a hop is shown with its own RTTs.
- GeoIP/ASN enrichment via local MaxMind GeoLite2 databases.
- Enrichment through Team Cymru, RDAP, RIPEstat and PeeringDB, with retry/backoff, per-provider rate limits and a 7-day cache. A failed provider never hides the GeoLite2 data.
- Hop locations from several sources (PeeringDB exchange LANs, router host names, GeoLite2), checked against the speed of light, with an honest confidence and radius per hop. Anycast addresses are marked and not drawn at a fake point.
- 3D globe (Three.js) visualising hop arcs, coloured by latency bands, plus per-hop markers and an uncertainty ring true to scale.
- Detailed hop table with RTT stats, packet loss, location and ASN metadata (including PeeringDB facility context when available).
- Snapshot and animation exports saved directly to your downloads folder (PNG/JPG/WebP for stills, WebM/GIF for animated routes).

## Getting Started

### Prerequisites

- Node.js 22+ (LTS recommended)
- npm 9+
- Access to the system `traceroute` (macOS/Linux) or `tracert` (Windows) binary.
- **GeoLite2 databases** (optional, but recommended - see below)

### GeoLite2 Databases (Optional)

VisTracer can provide rich geographic visualization and network details when MaxMind GeoLite2 databases are available. The application **will work without them**, but it falls back to public registries, so location and ASN accuracy may drift.

**Quick Setup:**
1. Create a free MaxMind account at https://www.maxmind.com/en/geolite2/signup
2. Download `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`
3. Launch VisTracer, open the settings gear beside the traceroute form, and browse to the downloaded files under **GeoIP databases**

**For detailed setup instructions**, including custom paths and troubleshooting, see [GEOLITE2_SETUP.md](./GEOLITE2_SETUP.md).

If databases are missing, a warning banner will appear in the footer. The same settings modal can be opened directly from the banner or the gear icon—no restart required.

### External Enrichment Providers

In addition to GeoLite2, VisTracer looks up each public hop address in these registry services:

| Provider | Gives | Credentials | Default |
| --- | --- | --- | --- |
| **Team Cymru** | Origin ASN, BGP prefix, registry, AS name (whois over TCP port 43) | none | on |
| **RDAP** (default `https://rdap.org/ip`) | Network name, registrant org, CIDR, country | optional custom base URL | on |
| **RIPEstat** | Announced prefix and origin ASNs from live BGP data | identifies as `VisTracer` | on |
| **PeeringDB** | Network type, peering policy, IXP and facility counts per ASN | optional API key (higher rate limit) | off |
| **Internet exchanges** | PeeringDB's public exchange list, used to place hops at an exchange. Nothing about your route is sent. | none (uses the PeeringDB key if one is saved) | on |

- Turn each provider on or off in **Integration settings** (gear icon) or with the quick toggles under the target field. The settings also hold the RDAP base URL and the PeeringDB API key.
- Only public hop addresses are sent. Private, CGNAT, link-local and documentation addresses never leave your machine.
- Answers are cached for 7 days in the app cache folder. **Force fresh lookups** skips the cache for one run.
- Calls retry with backoff on rate limits, server errors and timeouts. If a provider still fails, the hop shows "N sources failed" and the hop details list each provider with its result.
- The hop details panel shows every responder, the merged ASN/prefix/registry data, and the PeeringDB record (or why there is none).

See [docs/architecture.md](./docs/architecture.md) for the pipeline and the merge rules.

### Hop locations

GeoLite2 often puts a router at its operator's head office or in the middle of a country. VisTracer collects every location candidate for a hop and picks the best one:

| Source | Example | Typical radius |
| --- | --- | --- |
| **Exchange (IX) peering LAN** (PeeringDB) | `80.81.192.96` is on the DE-CIX Frankfurt LAN | 25–150 km |
| **Router host name** | `be2816.ccr42.ham01.atlas.cogentco.com` names Hamburg | 50 km |
| **GeoLite2 city / country** | "Bengaluru, India" or "United States" | 20–1000 km |

- **Speed of light.** Light in fibre covers about 200 km per millisecond one way, so a hop's round-trip time limits how far it can be from you. A location that the RTT makes impossible is never drawn; one that fits gets a tighter or wider radius. Locations are never moved by RTT alone.
- **Anycast.** Public DNS resolvers, the DNS root servers and some CDN networks answer from the nearest of many sites. These hops show an "anycast" tag and a notice, and get no point on the globe.
- **Confidence.** Each drawn hop has a ring on the globe with its radius in km: solid for high confidence, dashed and fainter for medium and low. The hop details show the source, confidence, radius, the RTT check, the IXP or host name that matched, and the other candidates.
- Exchange matching has its own switch (**Internet exchanges**, on by default), separate from PeeringDB. It downloads PeeringDB's public exchange list at most once a day and sends nothing about your route.

Data sources and licenses: [src-tauri/data/README.md](./src-tauri/data/README.md) (OurAirports, public domain). Rules and known limits: [docs/architecture.md#hop-locations](./docs/architecture.md#hop-locations).

### Linux: ICMP and TCP need raw sockets

`traceroute -I` (ICMP) and `-T` (TCP) need raw-socket privileges on Linux. Without them, VisTracer runs the trace again with UDP probes and shows a notice. To allow ICMP/TCP without running the app as root, give the system binary the capability once:

```bash
sudo setcap cap_net_raw+ep "$(readlink -f "$(command -v traceroute)")"
```

On macOS, TCP traces ask for your administrator password; VisTracer only runs `/usr/sbin`, `/usr/bin`, `/sbin` or `/bin` binaries that root owns with elevated rights.

### Install Dependencies

```bash
npm install
```

### Development Workflow

Run the Tauri + Vite development environment:

```bash
npm run tauri:dev
```

The command starts the Vite dev server for the frontend and compiles/launches the Rust backend.
Frontend changes benefit from hot-reload; Rust changes trigger an automatic recompile.

### Production Build

```bash
npm run build
```

### Desktop Packages

Tauri bundles native installers for each platform:

```bash
npm run tauri:build   # builds frontend + Rust backend and produces platform installer
```

Build artifacts are placed in `src-tauri/target/release/bundle/`.

> **Cross-building tip:** Creating Windows installers from macOS/Linux (or vice versa) requires the platform-specific toolchain (`xcode-select --install` on macOS, `wine`/`mono` for Windows targets, `fpm` for Debian packages). For the most reliable output, run the matching command on that operating system or inside a CI runner/VM that provides the necessary dependencies.

### Linting & Tests

```bash
npm run lint        # ESLint across renderer and shared sources
npm run typecheck   # TypeScript type check
npm run test        # Vitest unit and component tests
npm run test:e2e    # Vitest bridge/store integration tests
cd src-tauri && cargo test                               # Rust tests
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

## Project Structure

```
src/
  renderer/    React application (modules, state store, Three.js globe, hooks)
  common/      Shared TypeScript contracts (bridge, IPC types, net utils)
src-tauri/
  src/         Rust backend (commands, persistence, traceroute, geo, DNS)
assets/        Static assets (globe textures, GeoJSON, logo)
```

## GeoLite2 Database Management

Open the settings modal from the gear icon beside the traceroute form (or the footer banner, if shown) to review the current GeoLite2 status and edit paths. The modal displays the last update time along with success/error badges for each file.

- **Configure databases**: Browse to new `.mmdb` files at any time; VisTracer will reload them immediately.
- **Update databases**: Download newer versions from MaxMind and point the modal to the new paths or replace the files in place.
- **No restart required**: Changes take effect as soon as you save.

For detailed instructions on downloading, installing, and updating databases, see [GEOLITE2_SETUP.md](./GEOLITE2_SETUP.md).

**Note**: The application works without databases but provides limited information (no geographic coordinates, city names, or ASN details).

## Dynamic Day/Night Visualization

The 3D globe features a **real-time day/night terminator** that accurately reflects which parts of Earth are currently in darkness based on UTC time. This visualization:

- Updates every second to show the actual position of the sun
- Calculates solar position using declination (seasonal north-south variation ±23.5°) and hour angle (east-west rotation based on time)
- Smoothly blends between the day texture and city lights texture on the dark side
- Accurately represents seasonal variations (solstices and equinoxes) and time of day

The terminator position uses a simplified solar algorithm that provides accuracy within a few degrees—perfect for visualization. The shader compares each surface point's normal with the calculated sun direction to determine illumination.

## Snapshot & Media Export

- Click **Download export** in the footer to capture the current globe.
- Still images support PNG, JPG, and WebP. Animated exports support WebM (hardware-accelerated via `MediaRecorder`) and GIF (bundled encoder).
- Configure the dwell time per hop for animated formats; the tooltip stays on-screen with ASN, PeeringDB, and location details for each hop.
- Files are saved to your system's default download location (typically `~/Downloads` on macOS/Linux or `C:\Users\<username>\Downloads` on Windows).
- Filenames follow the pattern `vistracer-snapshot-YYYY-MM-DDTHH-MM-SS.ext` for stills and `vistracer-route-YYYY-MM-DDTHH-MM-SS.ext` for animations.
- The export button is available once a traceroute run has completed, and MP4 export is intentionally not supported (WebM/GIF cover animation needs without extra codecs).

![VisTracer Demo](assets/demo.gif)

## Known Gaps & Next Steps

- Scheduled GeoLite2 refresh (auto-download via license key works; periodic refresh is not yet automated)
- MP4 export remains out of scope; use WebM or GIF instead.
- Advanced heuristics (anycast detection, jitter visualisation, comparison view) are planned but not
  implemented in this build
- Windows `tracert` only sends ICMP probes, three per hop; the UDP/TCP choice does not apply there
- Only the first responder of a multipath hop is geolocated and sent to the registry providers; the others show their address, host name and RTTs

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, coding standards, and PR workflow.

## Additional Documentation

- [GEOLITE2_SETUP.md](./GEOLITE2_SETUP.md) - Complete guide to downloading and configuring GeoLite2 databases
- [docs/architecture.md](./docs/architecture.md) - Hop pipeline, enrichment, storage and security
- [docs/releasing.md](./docs/releasing.md) - Update signing key setup and the release workflow
- [CLAUDE.md](./CLAUDE.md) - Architecture overview and development guide for contributors
- [CHANGELOG.md](./CHANGELOG.md) - Release history
