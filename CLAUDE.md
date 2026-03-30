# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VisTracer is an Electron-based visual traceroute desktop application that executes traceroute locally, enriches hop data with GeoIP/ASN metadata, and animates hop-by-hop routes on a 3D globe using Three.js. The application provides cross-platform support for macOS, Windows, and Linux, including both IPv4 and IPv6 targets.

## Development Commands

```bash
# Development with hot reload (runs main process compiler, Vite dev server, and Electron)
npm run dev

# Production build
npm run build
npm run start          # Launch production build

# Platform packaging
npm run package        # All platforms
npm run package:mac    # macOS DMG
npm run package:win    # Windows NSIS
npm run package:linux  # Linux AppImage + deb

# Type checking (both processes)
npm run typecheck

# Linting (must pass with 0 errors and 0 warnings)
npm run lint

# Testing
npm run test           # Run all tests (62 tests across 5 files)
npm run test:watch     # Run tests in watch mode
```

**Required:** Node.js >= 22.0.0

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on every push/PR. Lint, typecheck, test (Node 22 + 25.x matrix), then builds platform artifacts (macOS DMG, Windows NSIS, Linux AppImage/deb) in parallel.
- **Release** (`.github/workflows/release.yml`): Triggered by `v*` tag push. Runs CI checks, builds all platforms, creates a GitHub Release with artifacts attached.
- Actions use `checkout@v6`, `setup-node@v6`, `upload-artifact@v7`, `download-artifact@v8` (Node 24 compatible).

To create a release: `git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0`

## Project Architecture

### Process Architecture

VisTracer follows Electron's multi-process model:

- **Main process** (`src/main/`): Node.js environment handling system-level operations
  - Spawns native traceroute binaries (`traceroute`/`traceroute6` on Unix, `tracert`/`tracert -6` on Windows)
  - Manages GeoIP/ASN lookups via local MaxMind GeoLite2 databases
  - Handles IPC communication, persistence, DNS resolution, and logging
  - Auto-downloads GeoLite2 databases via MaxMind license key (`src/main/services/geodb-downloader.ts`)
  - Entry point: `src/main/main.ts`

- **Renderer process** (`src/renderer/`): React application in browser context
  - Three.js-based 3D globe visualization
  - Zustand state management (`src/renderer/state/tracerouteStore.ts`)
  - React Query for async data (`@tanstack/react-query`)
  - UI components in `src/renderer/modules/app/components/`
  - Entry point: `src/renderer/main.tsx`

- **Common** (`src/common/`): TypeScript contracts shared between processes
  - `bridge.ts`: Type-safe API surface exposed to renderer via preload
  - `ipc.ts`: IPC channel definitions and data types
  - `net.ts`: Network utility functions (IPv4/IPv6 private IP detection)

### IPC Communication Flow

The renderer communicates with the main process via type-safe IPC channels:

1. Renderer calls methods on `window.visTracer` API (defined in `src/common/bridge.ts`)
2. Preload script (`src/main/preload.ts`) bridges calls to IPC channels
3. IPC handlers in `src/main/services/ipc.ts` process requests
4. Progress events stream back via `IPC_CHANNELS.TRACEROUTE_PROGRESS`

Key IPC operations:
- `TRACEROUTE_RUN`: Execute traceroute with progress streaming
- `TRACEROUTE_CANCEL`: Cancel running traceroute by runId
- `RECENT_RUNS`: Retrieve recent traceroute history
- `GEO_DB_META`: Get GeoLite2 database metadata
- `GEO_DB_DOWNLOAD`: Trigger auto-download of GeoLite2 databases with license key
- `GEO_DB_DOWNLOAD_PROGRESS`: Stream download progress events
- `SNAPSHOT_EXPORT`: Capture renderer view as PNG/JPG/WebP
- `ANIMATION_EXPORT`: Record animated route as WebM or GIF

### Traceroute Execution Pipeline

1. **Command construction** (`src/main/services/traceroute.ts:buildCommand`):
   - Platform-aware: `traceroute` on Unix with `-I` for ICMP, `tracert` on Windows
   - IPv6-aware: uses `traceroute6` on Unix, `tracert -6` on Windows for IPv6 targets
   - Spawns child process with streaming stdout

2. **Line parsing** (`parseHopLine`):
   - Regex-based extraction of hop index, IP, RTT values, and packet loss
   - Handles both IPv4 and IPv6 addresses (in parentheses, brackets, or bare)
   - Handles timeouts (`* * *`), private IPs, and various output formats

3. **Enrichment** (async per hop):
   - Reverse DNS lookup via `src/main/services/dns.ts` with caching
   - GeoIP/ASN lookup via `src/main/services/geo.ts` using MaxMind readers (supports both IPv4 and IPv6)
   - Optional external enrichment via Team Cymru, RDAP, RIPE Stat, and PeeringDB
   - Results cached in electron-store to minimize database queries

4. **Progress streaming**:
   - Each hop resolution triggers a `TracerouteProgressEvent` sent to renderer
   - Renderer updates Zustand store incrementally for real-time UI updates

### Globe Visualization

The 3D globe (`src/renderer/lib/globe.ts`) uses Three.js via React Three Fiber:

- **Coordinate transformation**: `latLngToVector3` converts lat/lng to 3D Cartesian
- **Great-circle arcs**: `interpolateGreatCircle` generates smooth paths between hops
- **Arc coloring**: Each hop uses a distinct color from `hopIndexToColor` (20-color palette)
- **Arc descriptors**: `buildArcDescriptors` creates renderable arc data from hop list
- **Day/night terminator**: Real-time solar position calculation with declination (+/-23.5 degree seasonal variation) and hour angle, updating every second. Shader blends day texture with city lights texture on dark side.

Rendering is handled by `@react-three/fiber` and `@react-three/drei` in `src/renderer/modules/app/components/GlobeViewport.tsx`.

### State Management

Zustand store (`src/renderer/state/tracerouteStore.ts`) manages:
- `runs`: Registry of TracerouteRun objects keyed by runId
- `currentRunId`: Active run being displayed
- `status`: Current execution state (`idle` | `running` | `success` | `error`)
- `selectedHopIndex`: Hop selected for detail view

Key store actions:
- `startRun`: Initiates traceroute and handles completion
- `handleProgress`: Merges incremental hop updates from IPC events
- `cancelRun`: Cancels active traceroute
- `setSelectedHop`: Updates hop selection for detail pane

### GeoIP Database Management

GeoLite2 databases can be configured two ways:

**Auto-download** (recommended):
1. Enter a MaxMind license key in the onboarding modal or GeoIP settings
2. `src/main/services/geodb-downloader.ts` downloads and extracts `.mmdb` files from MaxMind's API
3. Databases are saved to `app.getPath('userData')/databases/`
4. Progress streamed to renderer via `GEO_DB_DOWNLOAD_PROGRESS` IPC channel

**Manual configuration:**
1. `src/main/services/persistence.ts:configureGeoDatabaseDefaults` sets database paths
2. Databases expected in `assets/GeoLite2-City.mmdb` and `assets/GeoLite2-ASN.mmdb`
3. Settings modal allows browsing to custom `.mmdb` files with immediate reload (no restart required)

If missing, geo/ASN lookups return undefined (graceful degradation). Database paths stored in electron-store under `geo.cityDbPath` and `geo.asnDbPath`. IP lookups are cached in electron-store to avoid repeated database queries. Use `forceRefresh: true` in request options to bypass cache.

### External Enrichment Providers

VisTracer supports optional external enrichment providers to supplement MaxMind GeoLite2 data:

- **Team Cymru**: IP-to-ASN mapping via whois (no credentials required)
- **RDAP**: Registry owner/country data (default `https://rdap.org/ip`, optional custom base URL)
- **RIPE Stat**: Prefix and ASN holder context (identifies as `VisTracer`)
- **PeeringDB**: Facility/operator details for known ASNs (optional API key for higher rate limits)

Providers can be toggled via the Integrations section in the UI. Credentials are configurable in the settings modal. All lookups are logged to the Electron console for debugging.

### TypeScript Project References

The project uses TypeScript project references for incremental builds:

- `tsconfig.base.json`: Shared compiler options
- `tsconfig.main.json`: Main process configuration (target Node.js)
- `tsconfig.renderer.json`: Renderer process configuration (target ES2020)

Path aliases are configured:
- `@common/`: Maps to `src/common/`
- `@renderer/`: Maps to `src/renderer/`
- `@assets/`: Maps to `assets/`

Use `tsc-alias` to resolve path aliases after compilation.

## Testing

Tests use Vitest with separate projects for different environments:

- **Configuration**: `vitest.config.ts` defines two projects:
  - `node` project: runs `src/main/**/*.test.ts` and `src/common/**/*.test.ts` in Node environment
  - `renderer` project: runs `src/renderer/**/*.test.ts` in jsdom environment with React plugin
- **Setup file**: `vitest.setup.ts` (renderer project only)

Test files:
- `src/main/services/__tests__/traceroute.test.ts` — 23 tests: `parseHopLine` (Unix/Windows/IPv6 formats, timeouts), `parseLatencyValues`, `buildCommand`
- `src/common/__tests__/net.test.ts` — 18 tests: `isPrivateIpv4`, `isPrivateIpv6`, `isIpv6`, `isPrivateIp`
- `src/renderer/state/__tests__/tracerouteStore.test.ts` — 9 tests: `handleProgress`, `setSelectedHop`, `cancelRun`
- `src/renderer/lib/__tests__/globe.test.ts` — 7 tests: `latencyToColor`, `buildArcDescriptors`, `latLngToVector3`
- `src/renderer/lib/__tests__/sun-calculation.test.ts` — 5 tests: solar position calculations

## Key Implementation Details

- **Platform detection**: Use `os.platform()` to differentiate between macOS/Linux/Windows
- **Traceroute binary paths**: Unix uses `/usr/sbin/traceroute` (IPv4) and `/usr/sbin/traceroute6` (IPv6), Windows uses `tracert` from PATH with `-6` flag for IPv6
- **IPv6 detection**: `isIpv6()` in `src/common/net.ts` checks for colon-separated addresses
- **Private IP handling**: `isPrivateIp()` in `src/common/net.ts` detects RFC1918 (IPv4) and link-local/ULA (IPv6) addresses (no geo lookup for private IPs)
- **Cancellation**: Active runs tracked in Map; cancel sends SIGINT to child process
- **Snapshot export**: Uses Electron's `webContents.capturePage()` to capture still images (PNG/JPG/WebP), saves to system downloads folder (`~/Downloads`)
- **Animation export**: WebM uses hardware-accelerated `MediaRecorder`, GIF uses bundled encoder. Files saved to downloads folder with pattern `vistracer-route-YYYY-MM-DDTHH-MM-SS.ext`. Configurable dwell time per hop with tooltips showing ASN/PeeringDB/location details.
- **TopBar protocol badge**: Shows IPv4 (blue) or IPv6 (purple) badge based on target address format

## Known Limitations

- Scheduled GeoLite2 refresh not implemented (auto-download is one-time via license key)
- Provider rate-limit handling and retry UX for external enrichment APIs not yet implemented
- MP4 export intentionally not supported (WebM/GIF cover animation needs without extra codecs)
- Advanced heuristics (anycast detection, jitter visualization, comparison view) planned but not implemented
- Windows relies on `tracert` being available on PATH
