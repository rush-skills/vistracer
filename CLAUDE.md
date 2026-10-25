# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VisTracer is a Tauri v2-based visual traceroute desktop application that executes traceroute locally, enriches hop data with GeoIP/ASN metadata, and animates hop-by-hop routes on a 3D globe using CesiumJS. The application provides cross-platform support for macOS, Windows, and Linux, including both IPv4 and IPv6 targets.

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
npm run test           # Run unit + component tests (206 tests across 24 files)
npm run test:e2e       # Run e2e tests (79 tests across 7 files)
npm run test:watch     # Run tests in watch mode
node scripts/globe-check/check.mjs  # After a build (Node >= 22.4): wide start view, idle frames and compositor frames, online tile requests (incl. the online imagery switch), export input lock in headless Chrome
node scripts/globe-check/ui-shots.mjs [dir]  # After a build: screenshots of every UI state, dark/light/960x640

# Rust
cd src-tauri && cargo test                                # 169 tests (+2 ignored network smoke tests)
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
  - Serves globe imagery tiles from NASA GIBS through a disk cache (`vistiles` URI scheme)
  - External enrichment providers (Team Cymru, RDAP, RIPE Stat, PeeringDB, PeeringDB IX list)
  - Hop location estimates (`geoloc/`): IX LAN, host name hint, GeoLite2; speed-of-light check; anycast
  - Entry point: `src-tauri/src/main.rs`

- **Frontend** (`src/renderer/`): React application in WebView
  - CesiumJS 3D globe (`modules/app/components/globe/cesiumGlobe.ts` is the only module that imports Cesium)
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
- `get_settings` / `set_settings`: Read/write application settings (keys: `integrations`, `preferences.onboarding`, `preferences.ui`, `geo`, ...)
- `emit_telemetry`: Log telemetry events
- `get_app_info`: App version and whether the updater public key is configured
- `get_tile_cache_info` / `clear_tile_cache`: size of the globe tile cache, and emptying it

Key Events (Tauri emit/listen):
- `vistracer:traceroute:progress`: Streamed hop progress events
- `vistracer:geo:download-progress`: GeoDB download progress

### Rust Backend Structure (`src-tauri/src/`)

- `main.rs`: Tauri app setup, command registration, state management, `vistiles` URI scheme
- `atomic_file.rs`: `write_atomic` (unique temp file + rename), shared by the provider cache and the tile cache
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
- `commands/tile_cache.rs`: globe tile cache: allowlisted GIBS layers, URI parsing, `$APPCACHE/tiles` with a 500 MB LRU cap, single-flight downloads, 3-failure pause, redirect allowlist; no upstream request while the "Online imagery" layer switch is off (`set_online_enabled`, applied at start and on every `set_settings`)
- `commands/geodb_downloader.rs`: MaxMind database auto-download
- `commands/persistence.rs`: In-memory store for settings, DNS cache, runs; settings validation; `UiPreferences` (theme, layer switches, collapsed panels; ids checked, unknown ids kept; a saved section is read field by field, so one bad value keeps the other choices)
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

CesiumJS globe, details and diagram in [docs/architecture.md#globe](./docs/architecture.md#globe):

- **Scene mapping** (`src/renderer/lib/globe.ts`, pure): `buildGlobeScene` turns hops into markers, raised great-circle arcs, confidence rings (km, styled by confidence), anycast reach circles and labels; `nextCameraFocus` / `planFlight` decide camera flights; app-made flights stay at or above `bundledOnlyHeight` and `OnlineImageryGate` keeps the online layer off after them until the user zooms, drags or tilts (`lib/imagery.ts`). Export input lock uses the controller's per-gesture switches, not `enableInputs` (Cesium flights reset it). No Cesium import, tested in jsdom.
- **Adapter** (`modules/app/components/globe/cesiumGlobe.ts`): the only Cesium import. `CesiumWidget` with every ion default off (`baseLayer: false`, ellipsoid terrain, no sky box), primitives (not entities), picking for hover/click. `GlobeViewport.tsx` loads it lazily behind the `GlobeController` interface (`globe/controller.ts`); tests mock that module.
- **Render governor** (`src/renderer/lib/renderGovernor.ts`): owns the rAF loop. `requestRenderMode`, wake on data/input/resize/`scene.requestRender()`, sleep after 20 idle ticks, 60 fps cap (30 on battery), paused when hidden or minimized.
- **Imagery** (`src/renderer/lib/imagery.ts`): bundled Blue Marble + Black Marble tiles (levels 0–4) in `src/renderer/public/imagery/` (built by `scripts/build-globe-imagery.mjs`); online Blue Marble levels 5–8 via `vistiles://` → Rust tile cache → NASA GIBS. Night imagery fades out with Cesium's lighting fade when zooming in.
- **Arc colouring**: latency bands (`latencyToColor`); markers and rings use `hopIndexToColor` (20-colour palette, shared with the hop table).
- **Day/night**: Cesium's sun from the clock (wall clock on each drawn frame, and every 10 minutes while idle).
- **Vite**: `vite.config.ts` serves/copies Cesium's `Workers/`, IAU2006 tables, terrain heights and images to `/cesium/`, and aliases `meshoptimizer` to a stub (its WebAssembly would break the CSP).

### UI Shell

Details and diagram in [docs/architecture.md#ui-shell](./docs/architecture.md#ui-shell):

- **Layout** (`modules/app/App.tsx`, `app.css`): full-bleed globe; a `.hud` grid floats glass panels over it (trace panel `TopBar`, `Toolbar` + `LayerPanel`, hop pane `HopDetailsPane`, `HopTimeline`, status bar `FooterBar`, `Attribution`), plus `HoverCard` and `CommandPalette`. The grid lets pointer events through; panels never resize the canvas.
- **Design tokens** (`styles/tokens.css`, loaded before components in `main.tsx`): dark default, `data-theme="light"`; reduced motion → 0 ms durations; reduced transparency → solid panels. No colour literals in component CSS; `styles/__tests__/tokens.test.ts` checks WCAG AA against the worst backdrop.
- **Layer registry** (`lib/layers.ts`): the layer panel, command bar and globe read it; scene layers drop `GlobeScene` items (`sceneForLayers`), globe layers go to `GlobeController.setImagery`. A new layer = a new entry + its drawing code; the panel does not change.
- **Command registry** (`lib/commands.ts`, `hooks/useCommands.ts`): every command built from state; toolbar and footer buttons run commands by id. ⌘K / Ctrl+K (`lib/shortcuts.ts`).
- **Online imagery off**: the adapter removes the online layer from Cesium's collection and Rust refuses downloads; `OnlineImageryGate` starts held, so even with it on, only the user's own camera moves load online tiles.

### State Management

Zustand stores:
- `tracerouteStore`: `runs`, `currentRunId`, `status` (`idle` | `running` | `success` | `error`), `selectedHopIndex`, `hoveredHopIndex` and `hoverAnchor` (pointer or timeline rectangle; a hover card shows only with an anchor). Globe, timeline and hop table share selection and hover.
- `uiStore`: theme, layer switches, collapsed panels (saved in `preferences.ui`), `paletteOpen`.
- `exportStore` / `noticeStore`: export in progress and the export dialog; short result notices with one timer.

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

- **Unit and component tests** (`vitest.config.ts`): 206 tests across 24 files (`*.test.ts` and `*.test.tsx`)
  - `src/common/__tests__/net.test.ts` — 18 tests: IPv4/IPv6 private IP detection
  - `src/renderer/state/__tests__/tracerouteStore.test.ts` — 11 tests: store behavior, hovered hop, user selections ignored during an export
  - `src/renderer/state/__tests__/updateStore.test.ts` — 6 tests: update check/install states
  - `src/renderer/lib/__tests__/globe.test.ts` — 26 tests: arcs (great circle, raised profile), confidence rings (radius on the sphere, styles, conflict style, emphasis), markers, labels, anycast reach, camera focus, borders, flight floor (a whole trace follow from a zoomed-in view never moves sideways below it)
  - `src/renderer/lib/__tests__/renderGovernor.test.ts` — 8 tests: idle sleep (no frames requested), wake during a frame, fps cap and battery, hidden/visible (resumes a running flight), dispose, render quality
  - `src/renderer/lib/__tests__/imagery.test.ts` — 13 tests: tile scheme URL per platform, no online layer in a browser, night imagery fade, bundled-only height, online layer held at start and after app moves until user input, only drags that start on the globe count
  - `src/renderer/lib/__tests__/layers.test.ts` — 6 tests: registry ids and groups, every scene item has a switch, online imagery entry, visibility defaults, scene and imagery mapping
  - `src/renderer/lib/__tests__/timeline.test.ts` — 5 tests: RTT stats, samples, loss, latency jumps, location kinds, screen reader text
  - `src/renderer/lib/__tests__/hoverCard.test.ts` — 7 tests: card content (anycast, private, no reply, conflict), placement next to the pointer or a timeline hop, always inside the window
  - `src/renderer/lib/__tests__/commands.test.ts` — 12 tests: registry contents, toggle titles, hop search, disabled reasons (incl. no trace or hop flight during an export), typed host and its place in the results, word-by-word fuzzy ranking, ⌘K vs Ctrl+K, auto repeat, non-Latin layouts
  - `src/renderer/styles/__tests__/tokens.test.ts` — 17 tests: WCAG AA for text tokens in both themes (glass and solid), text on the globe, reduced motion and transparency rules
  - `src/renderer/state/__tests__/uiStore.test.ts` — 6 tests: parsing saved UI preferences, defaults, saving, choices made while the read is in flight, no writes after a failed read, write failures
  - `src/renderer/modules/app/components/__tests__/GlobeViewport.test.tsx` — 7 tests: scene and fly-to through a mocked `GlobeController`, hover/select sync, no flight for a click during an export, input lock during export, hidden layers and imagery switches, WebGL failure message, imagery notice
  - `src/renderer/modules/app/components/__tests__/LayerPanel.test.tsx` — 3 tests: switches from the registry by group, online imagery off saved, Escape returns focus
  - `src/renderer/modules/app/components/__tests__/HopTimeline.test.tsx` — 9 tests: RTT/loss/confidence/jumps, selection sync both ways, arrow keys/Home/End, selection left to an export, Escape hides the card, hover sync, scroll into view, aria-controls only to an existing list, collapse saved
  - `src/renderer/modules/app/components/__tests__/HoverCard.test.tsx` — 3 tests: content from the store with no bridge call or fetch, placed again after an export, no card for table hover or during export
  - `src/renderer/modules/app/components/__tests__/CommandPalette.test.tsx` — 12 tests: open/close per platform, held shortcut, focus return, combobox/listbox roles, fuzzy match, execute, disabled commands, typed host, focus trap (Tab and presses inside the bar), empty result, not over another dialog
  - `src/renderer/modules/app/components/__tests__/Attribution.test.tsx` — 2 tests: full credit list with required notices, GIBS credit and acknowledgement also while online imagery is off
  - `src/renderer/modules/app/components/__tests__/FooterBar.test.tsx` — 1 test: a finished export's reset timer does not end the next export
  - `src/renderer/modules/app/components/__tests__/HopDetailsPane.test.tsx` — 15 tests: multipath, PeeringDB, provider failures, location fields, RTT conflict, anycast, empty states, row selection (not during an export), hover sync, scroll to selection, focus kept when the pane collapses
  - `src/renderer/modules/app/components/__tests__/IntegrationSettingsModal.test.tsx` — 11 tests: provider toggles, exchange matching switch, key, URL validation, tile cache size and clearing, online tile disclosure
  - `src/renderer/modules/app/lib/__tests__/tileCache.test.ts` — 2 tests: cache size text
  - `src/renderer/modules/app/lib/__tests__/integrationSettings.test.ts` — 3 tests: defaults, old saved settings keep exchange matching on
  - `src/renderer/modules/app/components/__tests__/UpdateBanner.test.tsx` — 3 tests: banner states
  - Use `fireEvent` from `@testing-library/react`, not `user-event`: two copies of `@testing-library/dom` in the lockfile make user-event skip `act()`.

- **E2E tests** (`vitest.e2e.config.ts`): 79 tests across 7 files
  - `tests/e2e/bridge.test.ts` — 19 tests: Tauri bridge invoke/listen integration, tile cache commands
  - `tests/e2e/traceroute-flow.test.ts` — 7 tests: full traceroute lifecycle
  - `tests/e2e/store-integration.test.ts` — 15 tests: Zustand store with API
  - `tests/e2e/settings-persistence.test.ts` — 10 tests: settings round-trip
  - `tests/e2e/geodb-management.test.ts` — 7 tests: GeoDB download/configure flow
  - `tests/e2e/net-utilities.test.ts` — 16 tests: network utility functions
  - `tests/e2e/ui-shell.test.tsx` — 5 tests: whole App through the real bridge (faked invoke/listen, mocked Cesium adapter): panels and a trace, command bar theme + layer switch saved, typed host traced with the panel's options, reset options keeps the target, collapsed panels after a restart

### Rust Tests

- 169 tests in `src-tauri/src/` (plus two ignored smoke tests: `smoke_real_traceroute` runs real traceroutes through the real pipeline, `smoke_real_gibs_tile` fetches one NASA GIBS tile through the tile cache) covering:
  - Line parsing (macOS, Linux, Windows, multipath, continuation lines, timeouts, IPv6) and a real macOS multipath capture (`fixtures/traceroute/`)
  - Binary lookup, trusted-binary check, per-platform plans, Linux UDP fallback, target validation
  - Provider parsers against real responses, merge rules, TTL cache and persistence, retry/backoff
  - `EnrichmentService` against local mock HTTP/whois servers (retry on 429/503, cache, degradation, private/disabled)
  - Pipeline runs against a fake traceroute process (slow lookup does not delay later hops, cancel, failure)
  - Settings validation (including `ixMatching` defaults for old settings files), UI preferences (defaults, bad ids and unbounded maps rejected, a damaged `ui` section keeps the rest of the file, one bad field keeps the other saved choices), updater key detection
  - Geolocation: prefix table edges (v4/v6, nested), RTT math, host name fixtures (`fixtures/hostnames/hints.txt`, positive and negative), IX dataset from real PeeringDB rows (`fixtures/providers/peeringdb-ix/`), precedence, reference hop (medium confidence; cannot rule out stronger candidates, Mumbai/Delhi regression), later-hop and primary-responder bounds, anycast, IX download/backoff/stale-while-refresh/final 429, exchange matching with PeeringDB off and switched off, concurrent cache writes
  - Tile cache: URI parsing on every platform, rejected hosts and paths (never fetched), upstream allowlist, hit/miss, errors and non-images not cached, LRU eviction at the cap, crash leftovers and interrupted clears, clear, single flight for one tile, concurrent writes of many tiles, failure pause, no download while online imagery is off (cached tiles still served), GET/HEAD only (405 otherwise), `HttpFetcher` size cap and redirect allowlist (local mock server); `write_atomic` under concurrent writers

## Key Implementation Details

- **Platform detection**: Rust `cfg!(target_os = ...)` for platform-specific behavior
- **Traceroute binary paths**: PATH first, then `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`, `/usr/local/*` (Windows: `%SystemRoot%\System32`); elevated runs use only root-owned system binaries
- **IPv6 detection**: `is_ipv6()` checks for colon-separated addresses (in both TS and Rust)
- **Private IP handling**: `is_private_ip()` detects RFC1918 + link-local/ULA addresses (UI label); `is_publicly_routable()` decides what may be sent to providers
- **Cancellation**: Active runs tracked in `Arc<Mutex<HashMap>>`, cancel sends kill signal
- **Snapshot export**: Client-side canvas capture (no server-side `capturePage`); the Cesium canvas keeps `preserveDrawingBuffer` for it
- **State persistence**: In-memory `AppStore` with `Mutex` for thread-safe access; settings in `$APPDATA/settings.json`, provider cache in `$APPCACHE/enrichment-cache.json`, globe tiles in `$APPCACHE/tiles/`
- **CSP**: strict policy in `tauri.conf.json` (`script-src 'self'`); never inject inline scripts (gif.js loads as a `?url` asset). The tile scheme (`vistiles:`, `http://vistiles.localhost`) is allowed in `img-src`/`connect-src`; no `'wasm-unsafe-eval'` (see `meshoptimizerStub.ts`)
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
- `cesium` (~1.146, Apache-2.0): 3D globe; licenses of bundled data in [docs/third-party-data.md](./docs/third-party-data.md)
- `zustand`: State management
- `@tanstack/react-query`: Async data fetching
