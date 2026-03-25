# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VisTracer is an Electron-based visual traceroute desktop application that executes traceroute locally, enriches hop data with GeoIP/ASN metadata, and animates hop-by-hop routes on a 3D globe using Three.js. The application provides cross-platform support for macOS, Windows, and Linux.

## Development Commands

```bash
# Development with hot reload (runs main process compiler, Vite dev server, and Electron)
npm run dev

# Production build
npm run build
npm run start          # Launch production build

# Type checking (both processes)
npm run typecheck

# Linting
npm run lint

# Testing
npm run test           # Run all tests
npm run test:watch     # Run tests in watch mode
```

## Project Architecture

### Process Architecture

VisTracer follows Electron's multi-process model:

- **Main process** (`src/main/`): Node.js environment handling system-level operations
  - Spawns native traceroute binaries (`traceroute` on Unix, `tracert` on Windows)
  - Manages GeoIP/ASN lookups via local MaxMind GeoLite2 databases
  - Handles IPC communication, persistence, DNS resolution, and logging
  - Entry point: `src/main/main.ts`

- **Renderer process** (`src/renderer/`): React application in browser context
  - Three.js-based 3D globe visualization
  - Zustand state management (`src/renderer/state/tracerouteStore.ts`)
  - UI components in `src/renderer/modules/app/components/`
  - Entry point: `src/renderer/main.tsx`

- **Common** (`src/common/`): TypeScript contracts shared between processes
  - `bridge.ts`: Type-safe API surface exposed to renderer via preload
  - `ipc.ts`: IPC channel definitions and data types
  - `net.ts`: Network utility functions (e.g., private IP detection)

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
- `SNAPSHOT_EXPORT`: Capture renderer view as PNG

### Traceroute Execution Pipeline

1. **Command construction** (`src/main/services/traceroute.ts:buildCommand`):
   - Platform-aware: `traceroute` on Unix with `-I` for ICMP, `tracert` on Windows
   - Spawns child process with streaming stdout

2. **Line parsing** (`parseHopLine`):
   - Regex-based extraction of hop index, IP, RTT values, and packet loss
   - Handles timeouts (`* * *`), private IPs, and various output formats

3. **Enrichment** (async per hop):
   - Reverse DNS lookup via `src/main/services/dns.ts` with caching
   - GeoIP/ASN lookup via `src/main/services/geo.ts` using MaxMind readers
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

GeoLite2 databases are configured at startup:

1. `src/main/services/persistence.ts:configureGeoDatabaseDefaults` sets database paths
2. Databases expected in `assets/GeoLite2-City.mmdb` and `assets/GeoLite2-ASN.mmdb`
3. If missing, geo/ASN lookups return undefined (graceful degradation)
4. Database paths stored in electron-store under `geo.cityDbPath` and `geo.asnDbPath`

IP lookups are cached in electron-store to avoid repeated database queries. Use `forceRefresh: true` in request options to bypass cache.

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

Tests use Vitest with Testing Library (renderer-focused):
- Configuration: `vitest.config.ts`
- Setup file: `vitest.setup.ts`
- Example: `src/renderer/lib/__tests__/globe.test.ts`

Tests run in jsdom environment with React plugin support.

## Key Implementation Details

- **Platform detection**: Use `os.platform()` to differentiate between macOS/Linux/Windows
- **Traceroute binary paths**: Unix systems use `/usr/sbin/traceroute`, Windows uses `tracert` from PATH
- **Private IP handling**: `isPrivateIpv4` in `src/common/net.ts` detects RFC1918 addresses (no geo lookup)
- **Cancellation**: Active runs tracked in Map; cancel sends SIGINT to child process
- **Snapshot export**: Uses Electron's `webContents.capturePage()` to capture PNG, saves to `{userData}/snapshots/`

## Known Limitations

- GIF/MP4 export not yet implemented (PNG only)
- IPv6 support planned but not in v0.1
- Windows relies on `tracert` being available on PATH
- GeoLite2 database updates require manual download and replacement
