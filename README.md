# VisTracer

Visual traceroute desktop application built with Electron and React. VisTracer executes traceroute
locally, enriches hops with GeoIP and ASN metadata, and animates hop-to-hop routes on a 3D globe
alongside an interactive hop timeline.

## Core Capabilities

- Cross-platform Electron shell with type-safe IPC between the main process and React renderer.
- Native traceroute execution (ICMP/UDP/TCP) via system binaries with cancellation support.
- Streaming progress updates: hop data appears in the UI as traceroute output is parsed.
- GeoIP/ASN enrichment via local MaxMind GeoLite2 databases with persistent caching.
- 3D globe (Three.js) visualising hop arcs, coloured by latency bands, plus per-hop markers.
- Detailed hop table with RTT stats, packet loss, location and ASN metadata.
- Snapshot export (PNG) saved to the OS-specific application data directory.

## Getting Started

### Prerequisites

- Node.js 18.13+ (LTS recommended)
- npm 9+
- Access to the system `traceroute` (macOS/Linux) or `tracert` (Windows) binary.

### Install Dependencies

```bash
npm install
```

### Development Workflow

Run the Electron + Vite development environment:

```bash
npm run dev
```

The command compiles the Electron main process with `tsc`, starts Vite for the renderer, and launches
Electron once the build products are ready. Renderer changes benefit from fast-refresh.

### Production Build

```bash
npm run build
npm run start   # launches Electron against the production bundles
```

### Linting & Tests

```bash
npm run lint        # ESLint across main + renderer sources
npm run typecheck   # TypeScript project references for both processes
npm run test        # Vitest + Testing Library (renderer-focused)
```

## Project Structure

```
src/
  main/        Electron main process, IPC handlers, traceroute + geo services
  renderer/    React application (modules, state store, Three.js globe, hooks)
  common/      Shared TypeScript contracts between main and renderer
assets/        Static assets (reserved)
```

## GeoLite2 Configuration

VisTracer ships with GeoLite2 databases bundled in the `assets/` directory. Create a free MaxMind
account, download the `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` archives, and drop the unpacked
files into `assets/` (replacing the placeholders if necessary). On startup the Electron main process
automatically wires those files to the GeoIP/ASN lookup service—no manual scripting required. The
footer status shows the active database versions; if the files are absent, traceroute results fall
back to “Unknown” geo/ASN information.

## Snapshot Export

- Use the `Export snapshot` button in the footer to capture the current renderer view as a PNG.
- Files are written to `{userData}/snapshots/vistracer-<timestamp>.png` (e.g. on macOS:
  `~/Library/Application Support/VisTracer/snapshots`).

## Known Gaps & Next Steps

- GeoLite DB onboarding still runs offline; future work may add UI for refreshing or validating
  database freshness in-app.
- GIF/MP4 capture is not yet implemented (PNG only).
- Advanced heuristics (anycast detection, jitter visualisation, comparison view) are planned but not
  implemented in this build.
- Windows environments rely on `tracert`; ensure it is available on `PATH` for the Electron runtime.

Refer to `PRD.md` for the full product direction and roadmap.
