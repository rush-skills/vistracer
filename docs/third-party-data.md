# Third-party code and data

Everything VisTracer bundles or downloads that it did not write itself, with
the license and how to rebuild it. The app is MIT-licensed; each entry below
allows redistribution in it.

## Bundled in the app

| What | Where in the repo | Size | License | Source |
| --- | --- | --- | --- | --- |
| CesiumJS 1.146 (globe engine) | npm `cesium`; the build copies `Workers/`, `Assets/IAU2006_XYS/`, `Assets/approximateTerrainHeights.json`, `Assets/Images/` and `LICENSE.md` to `dist/renderer/cesium/` | 3.8 MB JS chunk + 3.2 MB static files | Apache-2.0. `dist/renderer/cesium/LICENSE.md` is Cesium's license with the notices of the third-party code it contains | <https://github.com/CesiumGS/cesium> |
| NASA Blue Marble, shaded relief and bathymetry (day imagery) | `src/renderer/public/imagery/blue-marble/{z}/{x}/{y}.jpg`, levels 0–4 | 682 tiles, 4.58 MB | NASA imagery is not subject to copyright in the US (NASA media guidelines); credit NASA, do not imply endorsement | GIBS layer `BlueMarble_ShadedRelief_Bathymetry` (NASA Earth Observatory Blue Marble: Next Generation) |
| NASA Black Marble 2016 (night lights) | `src/renderer/public/imagery/black-marble/{z}/{x}/{y}.jpg`, levels 0–4 | 682 tiles, 1.94 MB | As above | GIBS layer `VIIRS_Black_Marble`, time `2016-01-01` (Suomi NPP VIIRS) |
| Country borders | `src/renderer/public/world.geojson` | 177 countries, 10,654 points, 488 KB | Public domain | Natural Earth Admin-0 countries, 1:110m (<https://www.naturalearthdata.com/>) |
| Airport table for host name hints | `src-tauri/data/airports.csv` | 104 KB | Public domain | OurAirports; see [src-tauri/data/README.md](../src-tauri/data/README.md) |

Not bundled: Cesium imports `meshoptimizer` (MIT) for compressed glTF
models. The globe never loads glTF, and the package compiles WebAssembly as
soon as it loads, which the app's CSP blocks. `vite.config.ts` therefore
replaces it with `src/renderer/modules/app/components/globe/meshoptimizerStub.ts`.

### Imagery tiles

The bundled tiles use Cesium's `GeographicTilingScheme`: level `z` has
2^(z+1) × 2^z tiles of 256 × 256 px; `x` counts from 180° W, `y` from 90° N.
Level 4 is 8,192 px around the equator, about 4.9 km per pixel. GIBS's own
EPSG:4326 tile matrices do not line up with that scheme (their level 0 tiles
span 288°), so the script asks the GIBS WMS for each tile with its exact
bounding box. It needs no API key and no extra packages.

Level 4 for both layers keeps the bundled imagery at 6.5 MB. Level 5 would
add about 13 MB for the day layer alone. Closer zoom uses online tiles (next
section).

To rebuild (takes about 4 minutes, 1,364 requests, 4 at a time):

```bash
node scripts/build-globe-imagery.mjs src/renderer/public/imagery
```

The layer ids and the maximum level in the script must match
`BUNDLED_IMAGERY` in `src/renderer/lib/imagery.ts`.

## Downloaded at run time

| What | Host | When | Terms |
| --- | --- | --- | --- |
| Blue Marble day tiles, levels 5–8 (EPSG:3857, `GoogleMapsCompatible_Level8`, about 600 m per pixel at level 8) | `gibs.earthdata.nasa.gov` | Only when the globe is zoomed in past the bundled levels; through the Rust tile cache (`$APPCACHE/tiles`, 500 MB) | GIBS: "NASA promotes full and open sharing of data." No API key, no stated rate limit. GIBS asks clients to add: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)." |
| PeeringDB exchange list | `www.peeringdb.com` | At most once a day | See [src-tauri/data/README.md](../src-tauri/data/README.md) and [architecture.md](./architecture.md) |

The tile requests show NASA the approximate areas of the globe you zoom
into; they carry no addresses. Automatic camera moves (following a trace,
selecting a hop, exports) stay at or above the height where the globe uses
only bundled imagery. Online tiles stay off at start-up and after such moves
until you zoom, drag or tilt the globe yourself. So automatic moves download
nothing and do not trace your route for NASA. Night imagery has no online
layer: it fades out as the camera comes close, where the day imagery takes
over (see [architecture.md](./architecture.md#globe)).

## Credits shown in the app

A small "NASA, GIBS, CesiumJS" button in the globe's lower right corner opens
the full list (`src/renderer/lib/attribution.ts`; keep it in step with this
file): CesiumJS, NASA Blue Marble and Black Marble, NASA GIBS with the
acknowledgement GIBS asks for (see the table above), Natural Earth, MaxMind GeoLite2 with
MaxMind's notice ("This product includes GeoLite2 data created by MaxMind,
available from https://www.maxmind.com."), PeeringDB, OurAirports, Team
Cymru, RDAP and RIPEstat. While online imagery is off in the layer panel,
GIBS is listed as not used and the button reads "NASA, CesiumJS". Cesium's
own credit box is hidden, and the list has no links: a link would open in
the app window instead of a browser.

Sources checked on 2026-10-25:

- GIBS API documentation, "Data Use Guidance and Acknowledgements":
  <https://nasa-gibs.github.io/gibs-api-docs/>
- NASA images and media usage guidelines:
  <https://www.nasa.gov/nasa-brand-center/images-and-media/>
- GIBS capabilities (layer names, formats, tile matrix sets):
  <https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml>
