# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VisTracer is a Tauri v2-based visual traceroute desktop application that executes traceroute locally, enriches hop data with GeoIP/ASN metadata, and animates hop-by-hop routes on a 3D globe using Three.js. The application provides cross-platform support for macOS, Windows, and Linux, including both IPv4 and IPv6 targets.

## Development Commands

```bash
# Development with hot reload (Tauri dev server)
npm run tauri:dev

# Frontend only (Vite dev server)
npm run dev

# Production build (frontend + Tauri)
npm run tauri:build

# Frontend build only
npm run build

# Type checking
npm run typecheck

# Linting (must pass with 0 errors and 0 warnings)
npm run lint

# Testing
npm run test           # Run unit tests (39 tests across 4 files)
npm run test:e2e       # Run e2e tests (72 tests across 6 files)
npm run test:watch     # Run tests in watch mode

# Rust tests
cd src-tauri && cargo test   # 15 tests
```

**Required:** Node.js >= 22.0.0, Rust toolchain (rustup)

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on every push/PR. Lint, typecheck, test (TS + Rust), then builds Tauri platform artifacts in parallel.
- **Release** (`.github/workflows/release.yml`): Triggered by `v*` tag push. Runs CI checks, builds all platforms, creates a GitHub Release with artifacts attached.

To create a release: `git tag -a v0.3.0 -m "v0.3.0" && git push origin v0.3.0`

## Project Architecture

### Process Architecture

VisTracer follows Tauri's architecture with a Rust backend and web frontend:

- **Rust backend** (`src-tauri/`): System-level operations
  - Spawns native traceroute binaries (`traceroute`/`traceroute6` on Unix, `tracert`/`tracert -6` on Windows)
  - Manages GeoIP/ASN lookups via MaxMind databases (`maxminddb` crate)
  - Handles IPC via Tauri commands, persistence, DNS resolution, and logging
  - Auto-downloads GeoLite2 databases via MaxMind license key
  - External enrichment providers (Team Cymru, RDAP, RIPE Stat, PeeringDB)
  - Entry point: `src-tauri/src/main.rs`

- **Frontend** (`src/renderer/`): React application in WebView
  - Three.js-based 3D globe visualization
  - Zustand state management (`src/renderer/state/tracerouteStore.ts`)
  - React Query for async data (`@tanstack/react-query`)
  - UI components in `src/renderer/modules/app/components/`
  - Entry point: `src/renderer/main.tsx`

- **Common** (`src/common/`): TypeScript contracts shared between processes
  - `bridge.ts`: Tauri API bridge using `@tauri-apps/api` invoke/listen
  - `ipc.ts`: Type definitions for IPC data structures
  - `net.ts`: Network utility functions (IPv4/IPv6 private IP detection)

### IPC Communication Flow (Tauri)

The frontend communicates with the Rust backend via Tauri's command system:

1. Frontend calls methods on `window.visTracer` API (created in `src/common/bridge.ts`)
2. Bridge translates to `invoke()` calls targeting `#[tauri::command]` handlers
3. Progress events stream back via `app.emit()` and `listen()` on the frontend

Key Tauri Commands:
- `traceroute_run`: Execute traceroute with progress streaming
- `traceroute_cancel`: Cancel running traceroute by runId
- `get_recent_runs`: Retrieve recent traceroute history
- `get_geo_database_meta`: Get GeoLite2 database metadata
- `update_geo_database_paths`: Update database file paths
- `select_geo_db_file`: Open system file dialog for .mmdb selection
- `download_geo_db`: Trigger auto-download of GeoLite2 databases
- `get_settings` / `set_settings`: Read/write application settings
- `emit_telemetry`: Log telemetry events

Key Events (Tauri emit/listen):
- `vistracer:traceroute:progress`: Streamed hop progress events
- `vistracer:geo:download-progress`: GeoDB download progress

### Rust Backend Structure (`src-tauri/src/`)

- `main.rs`: Tauri app setup, command registration, state management
- `types.rs`: Shared data types (serialized to/from frontend)
- `net.rs`: IPv4/IPv6 private IP detection (mirrors `src/common/net.ts`)
- `commands/traceroute.rs`: Traceroute execution, parsing, enrichment
- `commands/dns.rs`: Reverse DNS lookups with caching
- `commands/geo.rs`: MaxMind GeoLite2 database reader management
- `commands/integrations.rs`: External enrichment providers
- `commands/geodb_downloader.rs`: MaxMind database auto-download
- `commands/persistence.rs`: In-memory store for settings, cache, runs

### Traceroute Execution Pipeline

1. **Command construction** (`src-tauri/src/commands/traceroute.rs:build_command`):
   - Platform-aware: `traceroute` on Unix with `-I` for ICMP, `tracert` on Windows
   - IPv6-aware: uses `traceroute6` on Unix, `tracert -6` on Windows
   - Spawns child process with streaming stdout via `tokio::process::Command`

2. **Line parsing** (`parse_hop_line`):
   - Regex-based extraction of hop index, IP, RTT values, and packet loss
   - Handles both IPv4 and IPv6 addresses (in parentheses, brackets, or bare)
   - Handles timeouts (`* * *`), private IPs, and various output formats

3. **Enrichment** (async per hop):
   - Reverse DNS lookup via `dns-lookup` crate with caching
   - GeoIP/ASN lookup via `maxminddb` crate
   - Optional external enrichment via Team Cymru, RDAP, RIPE Stat, and PeeringDB
   - Results cached in the in-memory `AppStore`

4. **Progress streaming**:
   - Each hop resolution triggers a `TracerouteProgressEvent` emitted to frontend
   - Frontend updates Zustand store incrementally for real-time UI updates

### Globe Visualization

The 3D globe (`src/renderer/lib/globe.ts`) uses Three.js via React Three Fiber:

- **Coordinate transformation**: `latLngToVector3` converts lat/lng to 3D Cartesian
- **Great-circle arcs**: `interpolateGreatCircle` generates smooth paths between hops
- **Arc coloring**: Each hop uses a distinct color from `hopIndexToColor` (20-color palette)
- **Day/night terminator**: Real-time solar position calculation with shader blending

### State Management

Zustand store (`src/renderer/state/tracerouteStore.ts`) manages:
- `runs`: Registry of TracerouteRun objects keyed by runId
- `currentRunId`: Active run being displayed
- `status`: Current execution state (`idle` | `running` | `success` | `error`)
- `selectedHopIndex`: Hop selected for detail view

### GeoIP Database Management

GeoLite2 databases can be configured two ways:

**Auto-download** (recommended):
1. Enter a MaxMind license key in the onboarding modal or GeoIP settings
2. Rust backend downloads and extracts `.mmdb` files from MaxMind's API
3. Databases saved to app data directory
4. Progress streamed to frontend via `vistracer:geo:download-progress` event

**Manual configuration:**
1. Use the file browser dialog to select `.mmdb` files
2. Paths stored in the in-memory AppStore
3. Database readers reloaded immediately

### External Enrichment Providers

- **Team Cymru**: IP-to-ASN mapping via TCP whois (no credentials required)
- **RDAP**: Registry owner/country data (default `https://rdap.org/ip`)
- **RIPE Stat**: Prefix and ASN holder context
- **PeeringDB**: Facility/operator details for known ASNs (optional API key)

## Testing

### TypeScript Tests (Vitest)

- **Unit tests** (`vitest.config.ts`): 39 tests across 4 files
  - `src/common/__tests__/net.test.ts` — 18 tests: IPv4/IPv6 private IP detection
  - `src/renderer/state/__tests__/tracerouteStore.test.ts` — 9 tests: store behavior
  - `src/renderer/lib/__tests__/globe.test.ts` — 7 tests: globe utility functions
  - `src/renderer/lib/__tests__/sun-calculation.test.ts` — 5 tests: solar position

- **E2E tests** (`vitest.e2e.config.ts`): 72 tests across 6 files
  - `tests/e2e/bridge.test.ts` — 17 tests: Tauri bridge invoke/listen integration
  - `tests/e2e/traceroute-flow.test.ts` — 7 tests: full traceroute lifecycle
  - `tests/e2e/store-integration.test.ts` — 15 tests: Zustand store with API
  - `tests/e2e/settings-persistence.test.ts` — 10 tests: settings round-trip
  - `tests/e2e/geodb-management.test.ts` — 7 tests: GeoDB download/configure flow
  - `tests/e2e/net-utilities.test.ts` — 16 tests: network utility functions

### Rust Tests

- 15 tests in `src-tauri/src/` covering:
  - Traceroute parsing (hop lines, latency values, IPv4/IPv6)
  - Command building (cross-platform, IPv6)
  - Request normalization
  - Network utilities (private IP detection)

## Key Implementation Details

- **Platform detection**: Rust `cfg!(target_os = ...)` for platform-specific behavior
- **Traceroute binary paths**: Unix uses `/usr/sbin/traceroute`, Windows uses `tracert` from PATH
- **IPv6 detection**: `is_ipv6()` checks for colon-separated addresses (in both TS and Rust)
- **Private IP handling**: `is_private_ip()` detects RFC1918 + link-local/ULA addresses
- **Cancellation**: Active runs tracked in `Arc<Mutex<HashMap>>`, cancel sends kill signal
- **Snapshot export**: Client-side canvas capture (no server-side `capturePage`)
- **State persistence**: In-memory `AppStore` with `Mutex` for thread-safe access

## Build & Package

```bash
# Development
npm run tauri:dev

# Production build
npm run tauri:build

# The tauri:build command produces platform-specific packages:
# - macOS: .dmg
# - Windows: .msi / .exe
# - Linux: .deb / .AppImage
```

## Dependencies

### Rust (src-tauri/Cargo.toml)
- `tauri` v2: Application framework
- `maxminddb`: GeoIP database reader
- `tokio`: Async runtime
- `reqwest`: HTTP client (for external providers, MaxMind downloads)
- `regex`: Traceroute output parsing
- `serde`/`serde_json`: Serialization
- `dns-lookup`: Reverse DNS
- `flate2`/`tar`: GeoDB archive extraction

### Frontend (package.json)
- `@tauri-apps/api`: Tauri IPC bridge
- `react` / `react-dom`: UI framework
- `three` / `@react-three/fiber` / `@react-three/drei`: 3D globe
- `zustand`: State management
- `@tanstack/react-query`: Async data fetching
