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
npm run test           # Run unit + component tests (75 tests across 9 files)
npm run test:e2e       # Run e2e tests (72 tests across 6 files)
npm run test:watch     # Run tests in watch mode

# Rust
cd src-tauri && cargo test                                # 144 tests (+1 ignored real-traceroute smoke test)
cd src-tauri && cargo clippy --all-targets -- -D warnings # must be clean
```

**Required:** Node.js >= 22.0.0, Rust toolchain (rustup)

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on every push/PR. Lint, typecheck, test (TS + Rust), clippy, then builds Tauri platform artifacts in parallel (macOS universal DMG, Windows, Linux). CI builds create no updater artifacts and need no secrets.
- **Release** (`.github/workflows/release.yml`): Triggered by `v*` tag push. Preflight checks (real updater pubkey, signing secrets, tag = app version), draft release, signed builds via `tauri-apps/tauri-action@v1` with `src-tauri/tauri.updater.conf.json`, then publish after `latest.json` has all four platforms.

Release steps and the one-time signing key setup: [docs/releasing.md](./docs/releasing.md).

## Project Architecture

### Process Architecture

VisTracer follows Tauri's architecture with a Rust backend and web frontend:

- **Rust backend** (`src-tauri/`): System-level operations
  - Spawns native traceroute binaries found via PATH (`traceroute`/`traceroute6`/`tcptraceroute` on Unix, `tracert` on Windows)
  - Manages GeoIP/ASN lookups via MaxMind databases (`maxminddb` crate)
  - Handles IPC via Tauri commands, persistence, DNS resolution, and logging
  - Auto-downloads GeoLite2 databases via MaxMind license key
  - External enrichment providers (Team Cymru, RDAP, RIPE Stat, PeeringDB, PeeringDB IX list)
  - Hop location estimates (`geoloc/`): IX LAN, host name hint, GeoLite2; speed-of-light check; anycast
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
- `get_app_info`: App version and whether the updater public key is configured

Key Events (Tauri emit/listen):
- `vistracer:traceroute:progress`: Streamed hop progress events
- `vistracer:geo:download-progress`: GeoDB download progress

### Rust Backend Structure (`src-tauri/src/`)

- `main.rs`: Tauri app setup, command registration, state management
- `types.rs`: Shared data types (serialized to/from frontend)
- `net.rs`: Private IP detection (mirrors `src/common/net.ts`) and `is_publicly_routable` (gate for provider lookups)
- `commands/traceroute.rs`: Run orchestration: spawn, reader task, `select!` loop, lookup tasks, cancel, Linux UDP fallback
- `commands/traceroute_command.rs`: Binary lookup (`SystemLocator`, trusted lookup for elevated runs), per-platform arguments, target validation
- `commands/traceroute_parse.rs`: Line parser (all responders per hop, continuation lines, Windows layout)
- `commands/run_state.rs`: Per-run hop state; renders `HopResolution`s and emits only changed hops
- `commands/lookup.rs`: Per-address lookup worker (`HopLookup` trait): reverse DNS + GeoLite2 + providers
- `commands/integrations.rs`: Provider parsers, `EnrichmentService` (cache, limits, retry), `merge_asn`
- `commands/enrichment_cache.rs`: TTL cache and `ProviderCache` (shared by lookups and the IX download, write lock from snapshot to rename), persisted to `$APPCACHE/enrichment-cache.json`
- `commands/ix_list.rs`: PeeringDB IX list download in a detached task, stale-while-refresh, 24 h TTL
- `commands/retry.rs`: `ProviderError`, backoff with jitter, `with_retry`
- `commands/dns.rs`: Reverse DNS on the blocking pool with timeout and caching
- `commands/geo.rs`: MaxMind GeoLite2 readers and local lookup
- `commands/app_info.rs`: App version and updater key state
- `commands/geodb_downloader.rs`: MaxMind database auto-download
- `commands/persistence.rs`: In-memory store for settings, DNS cache, runs; settings validation
- `geoloc/estimate.rs`: per-run location of every hop: candidates, RTT bound, reference hop, anycast, precedence
- `geoloc/rtt.rs`: speed-of-light check (infeasible / tightened / widened / feasible); never moves an estimate
- `geoloc/hostname.rs` + `geoloc/places.rs`: location hints in router host names; bundled airport table `data/airports.csv` (OurAirports, public domain; see `data/README.md`)
- `geoloc/ixp.rs`: PeeringDB IX dataset (ixpfx, ixlan, ix, ixfac, fac) and IX LAN lookup
- `geoloc/prefix.rs`: IPv4/IPv6 prefix table (sorted ranges, most specific match)
- `geoloc/anycast.rs`: documented anycast prefixes and anycast operator ASNs

### Traceroute Execution Pipeline

Full description and mermaid diagram: [docs/architecture.md](./docs/architecture.md).

1. **Plan** (`traceroute_command.rs`): find the binary via PATH plus fallbacks; macOS TCP needs root and only uses a root-owned binary in `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`. Linux TCP uses `tcptraceroute` (IPv4) or `traceroute -T`.
2. **Read** (`traceroute.rs`): a reader task forwards lines over a channel; the run loop parses each line and emits the hop immediately (`lookupState: "pending"`).
3. **Look up** (`lookup.rs`): each new address gets a task (max 8 per run): reverse DNS, GeoLite2, then providers through `EnrichmentService`. Finished lookups emit hop updates. A slow lookup never delays later hops.
4. **Fallback**: on Linux, a permission error for ICMP/TCP before any hop reruns the trace with UDP and adds a notice to `summary.notices`.
5. **Locate** (`geoloc/estimate.rs`): every render estimates `HopLocation` for all hops; a new hop can change earlier ones (RTT bound) and re-emit them.
6. **Finish**: after the process exits and lookups finish, emit the completed run and persist the provider cache.

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
- **PeeringDB**: Network type, policy, IXP/facility counts for known ASNs (optional API key, `Authorization: Api-Key`)

- **PeeringDB IX list** (`peeringdb-ix`, own switch `ixMatching`, on by default and independent of the PeeringDB switch; old settings files load with it on): five list requests 2 s apart in a background task, cached 24 h in the provider cache and written to disk when the download ends; a list up to 7 days old is served at once while a refresh runs; lookups wait (max 25 s, else `skipped`) only when there is no list; not refetched by "Force fresh" (PeeringDB allows one identical large anonymous request per hour); 15 min backoff after a failure; a 429 is not retried and backs off max(1 h, Retry-After), capped at 24 h (in memory only)

Each call: cache (7 days; RDAP keyed by base URL) → wait up to 25 s for a provider slot (else `skipped`, not a failure) → cache and circuit-breaker check → `with_retry` (429/5xx/timeouts, backoff + jitter). Failures become `status: "error"`, count toward the breaker (3 in a row pause the provider for 60 s) and never drop GeoLite2 data. Only publicly routable addresses are sent. Parsers are tested against real responses in `src-tauri/fixtures/providers/`.

### Hop locations

Each `HopResolution` carries `location: HopLocation` (`best`, `alternatives`, `ixp`, `hostnameHint`, `anycast`, `isRttReference`); `geo` stays the raw GeoLite2 record. Draw from `location.best` (`hopPosition` in `src/renderer/lib/globe.ts`), never from `geo`. Precedence: feasible → confidence → IXP > host name > GeoLite2 city > country → smaller radius. The RTT reference only rules out weaker candidates; stronger ones get the `conflict` verdict and stay. Anycast hops have no `best`. Details and known limits: [docs/architecture.md#hop-locations](./docs/architecture.md#hop-locations).

## Testing

### TypeScript Tests (Vitest)

- **Unit and component tests** (`vitest.config.ts`): 75 tests across 9 files (`*.test.ts` and `*.test.tsx`)
  - `src/common/__tests__/net.test.ts` — 18 tests: IPv4/IPv6 private IP detection
  - `src/renderer/state/__tests__/tracerouteStore.test.ts` — 9 tests: store behavior
  - `src/renderer/state/__tests__/updateStore.test.ts` — 6 tests: update check/install states
  - `src/renderer/lib/__tests__/globe.test.ts` — 12 tests: arcs, confidence rings (radius on the sphere, styles, conflict style), utilities
  - `src/renderer/lib/__tests__/sun-calculation.test.ts` — 5 tests: solar position
  - `src/renderer/modules/app/components/__tests__/HopDetailsPane.test.tsx` — 12 tests: multipath, PeeringDB, provider failures, location fields, RTT conflict, anycast, empty states
  - `src/renderer/modules/app/components/__tests__/IntegrationSettingsModal.test.tsx` — 7 tests: provider toggles, exchange matching switch, key, URL validation
  - `src/renderer/modules/app/lib/__tests__/integrationSettings.test.ts` — 3 tests: defaults, old saved settings keep exchange matching on
  - `src/renderer/modules/app/components/__tests__/UpdateBanner.test.tsx` — 3 tests: banner states
  - Use `fireEvent` from `@testing-library/react`, not `user-event`: two copies of `@testing-library/dom` in the lockfile make user-event skip `act()`.

- **E2E tests** (`vitest.e2e.config.ts`): 72 tests across 6 files
  - `tests/e2e/bridge.test.ts` — 17 tests: Tauri bridge invoke/listen integration
  - `tests/e2e/traceroute-flow.test.ts` — 7 tests: full traceroute lifecycle
  - `tests/e2e/store-integration.test.ts` — 15 tests: Zustand store with API
  - `tests/e2e/settings-persistence.test.ts` — 10 tests: settings round-trip
  - `tests/e2e/geodb-management.test.ts` — 7 tests: GeoDB download/configure flow
  - `tests/e2e/net-utilities.test.ts` — 16 tests: network utility functions

### Rust Tests

- 144 tests in `src-tauri/src/` (plus one ignored smoke test, `smoke_real_traceroute`, that runs real traceroutes through the real pipeline) covering:
  - Line parsing (macOS, Linux, Windows, multipath, continuation lines, timeouts, IPv6) and a real macOS multipath capture (`fixtures/traceroute/`)
  - Binary lookup, trusted-binary check, per-platform plans, Linux UDP fallback, target validation
  - Provider parsers against real responses, merge rules, TTL cache and persistence, retry/backoff
  - `EnrichmentService` against local mock HTTP/whois servers (retry on 429/503, cache, degradation, private/disabled)
  - Pipeline runs against a fake traceroute process (slow lookup does not delay later hops, cancel, failure)
  - Settings validation (including `ixMatching` defaults for old settings files), updater key detection
  - Geolocation: prefix table edges (v4/v6, nested), RTT math, host name fixtures (`fixtures/hostnames/hints.txt`, positive and negative), IX dataset from real PeeringDB rows (`fixtures/providers/peeringdb-ix/`), precedence, reference hop (medium confidence; cannot rule out stronger candidates, Mumbai/Delhi regression), later-hop and primary-responder bounds, anycast, IX download/backoff/stale-while-refresh/final 429, exchange matching with PeeringDB off and switched off, concurrent cache writes

## Key Implementation Details

- **Platform detection**: Rust `cfg!(target_os = ...)` for platform-specific behavior
- **Traceroute binary paths**: PATH first, then `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`, `/usr/local/*` (Windows: `%SystemRoot%\System32`); elevated runs use only root-owned system binaries
- **IPv6 detection**: `is_ipv6()` checks for colon-separated addresses (in both TS and Rust)
- **Private IP handling**: `is_private_ip()` detects RFC1918 + link-local/ULA addresses (UI label); `is_publicly_routable()` decides what may be sent to providers
- **Cancellation**: Active runs tracked in `Arc<Mutex<HashMap>>`, cancel sends kill signal
- **Snapshot export**: Client-side canvas capture (no server-side `capturePage`)
- **State persistence**: In-memory `AppStore` with `Mutex` for thread-safe access; settings in `$APPDATA/settings.json`, provider cache in `$APPCACHE/enrichment-cache.json`
- **CSP**: strict policy in `tauri.conf.json` (`script-src 'self'`); never inject inline scripts (gif.js loads as a `?url` asset)
- **Updater**: `plugins.updater.pubkey` is a placeholder until the signing key is set up; `get_app_info` reports `updaterConfigured`

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
- `tauri-plugin-updater` (~2.10) / `tauri-plugin-process` (~2.3): in-app updates and relaunch (pinned to match tauri 2.10)
- `maxminddb`: GeoIP database reader
- `tokio`: Async runtime
- `reqwest`: HTTP client (for external providers, MaxMind downloads)
- `regex`: Traceroute output parsing
- `serde`/`serde_json`: Serialization
- `dns-lookup`: Reverse DNS
- `flate2`/`tar`: GeoDB archive extraction

### Frontend (package.json)
- `@tauri-apps/api`: Tauri IPC bridge
- `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process`: update check, install, relaunch
- `react` / `react-dom`: UI framework
- `three` / `@react-three/fiber` / `@react-three/drei`: 3D globe
- `zustand`: State management
- `@tanstack/react-query`: Async data fetching
