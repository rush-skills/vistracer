# VisTracer (Electron) — Overview PRD

## 1) Problem & Goals

**Problem:** Network paths are hard to reason about from plain traceroute output.
**Goal:** Provide an intuitive, local, cross-platform desktop app that runs a traceroute to a target and animates the hop-by-hop path on a 3D globe, with latency context and basic ASN/geo info.

**Success metrics (v1):**

* Run traceroute to a domain/IP and render a globe path in <5s for typical routes.
* Show per-hop RTT and geolocation for ≥80% of public hops.
* Cross-platform builds for macOS, Windows, Linux via a single codebase.

## 2) Target Users / Primary Use Cases

* **NetOps/SRE/devs**: quick visual to diagnose routing oddities, unexpected detours, CDN anycast effects.
* **Educators/enthusiasts**: demonstrate how the Internet routes traffic globally.

**Use cases:**

1. Type a hostname → see animated hop path with RTT per segment.
2. Compare two runs (morning vs evening) to spot route changes/congestion.
3. Save/share a static snapshot (PNG/MP4/GIF) for incident reports.

## 3) Scope

### In-scope (v1)

* IPv4 traceroute (ICMP or UDP; TCP fallback optional).
* Local execution using system binaries (`traceroute`/`tracert`) or a Node module; parse output.
* GeoIP resolution (local DB) + ASN lookup.
* 3D globe visualization with arcs between hop coordinates; color by RTT bucket.
* Minimal UI: target input, “Run”, progress, hop table (IP, rDNS, ASN, RTT, loss), export snapshot.
* Offline-first for lookups (no PII exfiltration; optional opt-in telemetry off by default).

### Out-of-scope (v1)

* Continuous monitoring/scheduling.
* Full IPv6 and MTR-style streaming (planned v1.x).
* Team sharing, cloud sync, or SaaS components.

## 4) UX Outline

* **Top bar:** Target input (domain/IP), protocol selector (ICMP/UDP/TCP), “Run”.
* **Globe pane (center):** Interactive 3D earth (drag/zoom), animated arcs per hop; node glow/pulse on arrival. Color ramps for RTT bands (e.g., <50ms, 50–150ms, >150ms). Tooltip on hover: IP, rDNS, city/country, ASN, RTT, % loss.
* **Details pane (right):** Table of hops with inline status (★ for suspected anycast or private IP), packet counts and min/avg/max RTT.
* **Footer:** Legend, geolocation DB version, last update, export (PNG/GIF/MP4), rerun.

Accessibility: keyboard nav for hop selection; high-contrast mode; reduced-motion toggle.

## 5) Data Flow

1. **Input:** target + protocol + max hops + timeout.
2. **Execution:** Node main process spawns system traceroute (platform-aware) or uses privileged Node addon/module.
3. **Parsing:** Stream lines → extract hop index, IP, RTTs, loss.
4. **Enrichment:** Local GeoIP (MaxMind GeoLite2 City + ASN) → lat/lon, city, country, ASN; reverse DNS via `dns` with timeout & cache.
5. **Render:** Send structured hops to renderer; compute great-circle arcs; animate.
6. **Persist (local):** Cache IP→geo/ASN/rDNS, recent runs, user settings. Optional offline DB update job.

## 6) Architecture & Tech Choices

* **Shell:** Electron (main: process + spawn; renderer: React/TypeScript).
* **3D Globe:** Three.js (custom shader arcs) or deck.gl GlobeView; keep abstraction to swap engines later.
* **Geo/ASN:** Local MaxMind GeoLite2 (MMDB) via `maxmind` Node lib; periodic user-triggered updates.
* **Traceroute:**

  * macOS/Linux: spawn `traceroute` (prefer ICMP if available) with flags (`-I`, `-n`, `-q`, `-m`, `-w`).
  * Windows: spawn `tracert` with `/d` (no DNS during run) then do rDNS separately.
  * Fallback: `traceroute` npm module or `raw-socket` only if permissions allow; prefer system binaries for reliability.
* **Packaging:** `electron-builder` for dmg/exe/AppImage. Auto-update via electron-updater (optional).
* **State:** Redux Toolkit or Zustand; simple JSON persistence.
* **Licensing:** Bundle GeoLite2 license notice; prompt user to accept and download DB on first run.

## 7) Key Features & Rules

* **RTT visualization:** color by quantiles; optionally thickness by jitter.
* **Packet loss indicator:** dashed arcs or node halo intensity.
* **Anycast hinting:** if hostname resolves to multiple geos or hop geo changes but IP family/ASN suggests anycast, show “(anycast?)”.
* **Privacy:** all lookups local; no external calls unless user triggers DB update. Telemetry opt-in; collect only anonymized perf metrics.
* **Error handling:** ICMP blocked/filtered, `* * *` hops, private RFC1918 addresses (display “private – no geo”), max hops exceeded, timeouts.

## 8) Performance & Quality

* Keep renderer FPS ≥ 45 on integrated GPUs with 200+ arcs (use instancing, frustum culling).
* Debounce re-projections; use WebGL line instancing for arc paths.
* Cold start < 3s on mid-range hardware.
* Unit tests for parsers; snapshot tests for hop table; perf budget for render.

## 9) Release Plan

**v0.1 (MVP, 1–2 weeks)**

* Run traceroute (IPv4), parse, local GeoIP, basic globe with arcs, hop table, export PNG.

**v0.2**

* TCP/UDP selection, rDNS with cache, ASN badges, GIF export, reduced-motion mode.

**v0.3**

* IPv6 (where supported), side-by-side run comparison, MP4 capture, simple route diff heuristics.

## 10) Risks & Mitigations

* **Geo accuracy:** IP-to-geo is approximate; show confidence and allow user override per IP.
* **Permissions/AV:** Raw sockets blocked → prefer system traceroute binaries.
* **GPU variance:** Provide fallback to 2D map (MapLibre) if WebGL2 unavailable.
* **Licenses/updates:** Guide users through GeoLite2 signup and DB refresh; keep a last-known copy.

## 11) Analytics (opt-in)

* Anonymous: app version, OS, render FPS buckets, avg hops resolved, DB age. No targets or IPs.
