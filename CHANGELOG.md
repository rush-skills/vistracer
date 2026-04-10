# Changelog

All notable changes to VisTracer will be documented in this file.

## [1.0.0] - 2026-04-10

Complete rewrite from Electron to Tauri v2 with a Rust backend.

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

Quality, reliability, and accessibility improvements.

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

## [0.1.0] - 2025-03-26

Initial public release.

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
- Tauri v2 packaging for macOS (DMG), Windows (NSIS), and Linux (AppImage/deb)
- Settings persistence with no-restart database reload
