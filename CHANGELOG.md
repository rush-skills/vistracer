# Changelog

All notable changes to VisTracer will be documented in this file.

## [Unreleased]

### Added

- External enrichment now runs: Team Cymru, RDAP, RIPEstat and PeeringDB fill ASN, holder, prefix, registry and PeeringDB network details, with retry/backoff, per-provider rate limits and a 7-day cache in the app cache folder
- Every responder of a load-balanced hop is parsed and shown with its own RTTs
- Hop details panel: responders, merged network data, PeeringDB record (or the reason there is none), and the result of each provider
- Provider on/off switches, RDAP base URL and PeeringDB API key in Integration settings
- In-app updates through the Tauri updater (needs the signing key setup in docs/releasing.md)
- Universal macOS DMG (Apple Silicon and Intel)
- Linux: ICMP/TCP traces that fail for lack of raw-socket privileges run again with UDP and show how to enable them
- Hop locations from PeeringDB exchange (IX) peering LANs, router host names (NTT, Cogent, Arelion, Hurricane Electric, Lumen, Tata, Zayo, GTT, Google, Microsoft, Verizon, Comcast and generic airport/city codes) and GeoLite2, ranked by a documented precedence
- Speed-of-light check against a reference hop's estimate: impossible locations that are weaker than that estimate are not drawn; locations at least as strong are kept and marked as a conflict; radii are tightened or widened
- Anycast detection for public DNS resolvers, DNS root servers and anycast CDN networks; anycast hops are marked and not drawn at a fake point
- Uncertainty rings on the globe, true to scale and styled by confidence; Location section in the hop details with source, confidence, radius, RTT check, IXP, host name hint and other candidates
- "Internet exchanges" switch in Integration settings and the quick toggles: places hops at internet exchanges using PeeringDB's public exchange list. On by default (also for existing settings) and separate from the PeeringDB switch; nothing about your route is sent
- CesiumJS globe with NASA Blue Marble (day) and Black Marble (night) imagery bundled for levels 0–4, so the globe works offline; zooming in closer yourself loads NASA GIBS tiles through a 500 MB disk cache in the backend. Camera moves the app makes (following a trace, selecting a hop, exports) stay zoomed out and load only bundled imagery
- Hovering a hop on the globe highlights its row in the hop table and the other way round; the selected and hovered hop get a label on the globe
- Anycast hops with a known RTT bound show the area the answering site can be in (a dotted circle around the reference hop), still without a point
- "Globe imagery" in Integration settings shows the tile cache size and clears it
- New layout: the globe fills the window and the controls float over it on translucent panels (trace panel, toolbar, hop pane, hop timeline, status bar), each of which can collapse; the layout, theme and layer switches are remembered
- Light theme next to the dark default; reduced motion and reduced transparency system settings are respected
- Layer panel with switches for route arcs, hop markers, confidence rings, anycast reach, labels, day/night shading and online imagery; with online imagery off, no NASA GIBS tile is downloaded (the backend refuses them too)
- Hop timeline with RTT (average, min-max, each probe), loss, location confidence and marked latency jumps; arrow keys move the selection
- Hover cards for hops on the globe and in the timeline, from data already loaded
- Command bar (⌘K / Ctrl+K): trace a typed host, run the last trace again, go to a hop, show/hide layers and panels, switch theme, export, clear the tile cache, open settings
- Credits button on the globe with every data source, including the NASA GIBS and MaxMind GeoLite2 acknowledgements
- Infrastructure layers, all off by default: internet exchanges and data centres from the PeeringDB list exchange matching already downloads (sites on the route stand out; clustered at every zoom), cloud regions of AWS, Google Cloud and Azure and Cloudflare data centres (bundled, with a switch per provider and a "likely inside a region" match per hop with its confidence), network colours (one colour-blind-safe colour per ASN, with a legend), and opt-in submarine cables from TeleGeography (CC BY-NC-SA 3.0; a notice names the licence and the host before the first download, and guessed cables are labelled as a guess)
- Hover cards for exchange, data centre, cloud region and cable markers

### Changed

- Hops appear as soon as traceroute prints them; DNS, GeoIP and provider lookups run in the background and update the hop
- Traceroute binaries are found through PATH with system fallbacks; a missing binary shows an install command
- Content Security Policy enabled; file system scope limited to the app data, app cache and Downloads folders
- The globe, camera and export draw each hop at its best location estimate instead of the raw GeoLite2 record; hop markers keep the same size on screen when zooming
- The globe renders only when something changes and stops its animation loop when idle, hidden or minimized; frame rate is capped at 60 (30 on battery where the webview reports it)
- The app bundle shrank from 55 MB to 23 MB (macOS): the 10k textures and README media are no longer shipped
- Camera flights frame the hop in the part of the globe that the panels leave free
- The PeeringDB exchange list download includes facility names, operators, places and member counts (no extra request)

### Fixed

- Online imagery no longer loads at start-up before you move the camera (very wide windows could refine the start view past the bundled levels)
- Arrow keys, Home and End no longer scroll the hop timeline while an animated export records
- A second export started within 3.5 s of the previous one is no longer shown as finished while it still runs
- Team Cymru lookups could never connect, PeeringDB sent the API key in the wrong header, and RIPEstat/PeeringDB fields that do not exist were read
- macOS TCP traces only run root-owned system binaries with administrator rights
- A partial settings file no longer resets all settings
- Two runs that finish together can no longer write an older provider cache over a newer one

## [1.0.0] - 2026-04-11

Port from Electron to Tauri v2. A Rust backend replaces the Electron main process; the React + Three.js renderer is kept.

### Changed

- **Platform**: Replaced Electron with Tauri v2 and a full Rust backend
- **IPC**: Replaced Electron IPC with Tauri `invoke()` / `listen()` commands
- **Persistence**: Settings now saved to `settings.json` in app data directory, surviving restarts
- **GeoIP**: Database paths auto-discovered from download directory on startup
- **Traceroute**: TCP mode on macOS now prompts for admin privileges via native password dialog
- **Dependencies**: Removed `electron`, `electron-store`, `electron-log`, `electron-builder`; added `@tauri-apps/api` and Tauri plugins

### Added

- Rust backend (`src-tauri/`) with traceroute execution, GeoIP/ASN lookups, DNS resolution, and enrichment providers
- 15 Rust unit tests for traceroute parsing, command building, and network utilities
- 72 e2e tests covering bridge layer, traceroute flow, store integration, settings persistence, GeoDB management, and network utilities
- Tauri capabilities for filesystem, dialog, and shell permissions

### Removed

- Electron main process (`src/main/`)
- Electron preload script and IPC channel handlers
- `electron-store`, `electron-log`, `electron-builder` dependencies

## [0.2.0] - 2026-03-31

Quality, reliability, and accessibility improvements to the Electron application.

### Fixed

- **GeoLite2 auto-download**: Fixed 401 errors caused by cross-origin redirect handling during MaxMind database downloads
- **Test integrity**: Tests now import real `parseHopLine`, `buildCommand`, and `parseLatencyValues` functions from `traceroute.ts` instead of testing inline copies that could drift from the actual implementation
- **Export cleanup**: `captureGif` and `captureWebm` now use try/finally to guarantee hop selection restoration and stream track cleanup on error
- **Type duplication**: `GeoDbDownloadProgress` interface in `geodb-downloader.ts` replaced with import from `@common/ipc`

### Added

- **Test coverage**: 16 new tests (78 total, up from 62) covering DNS cache integration, persistence cache TTL/expiry, geodb tar parser extraction, and cross-platform `buildCommand` with mocked `os.platform()`
- **Accessibility**: `useModalA11y` hook providing Escape-to-close, focus-on-open, and focus-restore for all 4 modals (GeoSettings, Onboarding, ExportMedia, IntegrationSettings)
- **Keyboard navigation**: HopDetailsPane rows now support Tab, Enter, and Space key interaction with `role="button"` and proper `aria-label` attributes
- **ARIA attributes**: `role="dialog"`, `aria-modal`, and `aria-labelledby` on GeoSettingsModal; `aria-label` on globe viewport section
- **Static website**: Project landing page at vistracer.anks.in built with Astro and Tailwind CSS, deployed via GitHub Pages

### Improved

- **Render performance**: HopDetailsPane wrapped in `React.memo` with `useMemo` for derived hop computations, preventing unnecessary re-renders during active traceroute
- **Animation performance**: CameraController eliminates ~8 Three.js object allocations per frame (Quaternion/Vector3) via persistent `useRef` objects
- **Dead code cleanup**: Removed commented-out JSX block and debug `console.log` statements from GlobeViewport

## [0.1.0] - 2026-03-30

Initial public release. This version is an Electron application.

### Features

- Cross-platform traceroute execution (ICMP/UDP/TCP) via native system binaries
- Streaming hop-by-hop progress with real-time UI updates
- GeoIP/ASN enrichment via local MaxMind GeoLite2 databases with persistent caching
- Optional external enrichment: Team Cymru, RDAP, RIPE Stat, PeeringDB
- 3D globe visualization (Three.js) with animated hop arcs colored by latency
- Real-time day/night terminator with seasonal solar position calculation
- Detailed hop table with RTT stats, packet loss, location, and ASN metadata
- Snapshot export (PNG/JPG/WebP) and animation export (WebM/GIF)
- Configurable dwell time per hop for animated exports
- Onboarding modal with GeoLite2 status and integration review
- Electron packaging with `electron-builder` for macOS (DMG), Windows (NSIS), and Linux (AppImage/deb)
- Settings persistence (`electron-store`) with no-restart database reload
