# Changelog

All notable changes to VisTracer will be documented in this file.

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
- Electron packaging for macOS (DMG), Windows (NSIS), and Linux (AppImage/deb)
- Settings persistence via electron-store with no-restart database reload
