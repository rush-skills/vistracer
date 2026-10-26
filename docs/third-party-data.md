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
| Cloud regions and Cloudflare data centres | `src/renderer/public/infra/cloud-regions.json`, built from `scripts/infra-data/cloud-regions.ts` | 474 sites, 77 KB (13 KB gzip); loaded only while the **Cloud regions** layer is on | Facts from the providers' public documentation (not copyrightable as such); coordinates of the Cloudflare sites from OurAirports (public domain). AWS, Google Cloud, Microsoft Azure and Cloudflare are trademarks of their owners | See [Cloud regions](#cloud-regions) |
| Network colour palette | `src/renderer/lib/infra/asnColors.ts` | 7 colours | Paul Tol's colour schemes, free to use ("light" qualitative scheme) | <https://personal.sron.nl/~pault/> |
| satellite.js 7.1 (SGP4 orbit propagation for the satellites layer) | npm `satellite.js`; a lazy chunk (`propagate`) loaded only when the layer has data | 20.7 KB JS | MIT (a derivative of Brandon Rhodes' `sgp4`, MIT) | <https://github.com/shashwatak/satellite-js> |

Not bundled: Cesium imports `meshoptimizer` (MIT) for compressed glTF
models. The globe never loads glTF, and the package compiles WebAssembly as
soon as it loads, which the app's CSP blocks. `vite.config.ts` therefore
replaces it with `src/renderer/modules/app/components/globe/meshoptimizerStub.ts`.
In the same way, the two WebAssembly builds of satellite.js's optional bulk
propagator (`#wasm-single-thread`, `#wasm-multi-thread`) are replaced by
`src/renderer/lib/satellites/satelliteWasmStub.ts`; the app uses only its
JavaScript SGP4 functions.

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

### Cloud regions

`scripts/infra-data/cloud-regions.ts` is a hand-curated, typed table
(checked by `npm run typecheck`) of the generally available public regions
of AWS (34), Google Cloud (43) and Microsoft Azure (57), with each region's
code, the provider's display name, the city, the country and the centre of
the city, rounded to 0.01°. Where a provider names only an area (AWS
`us-east-1` "N. Virginia", Azure `eastus` "Virginia"), the table uses the
metro commonly reported for it and says so in a comment. Government,
sovereign and China partitions and announced regions are left out; Azure
regions with restricted access are in and marked. The table also holds the
ASNs each provider's cloud uses (checked in PeeringDB and the registry
records at `https://rdap.org/autnum/<asn>`) for the hop match. Google's
YouTube networks (AS36040, AS43515, registered as YOUTUBE) are not in the
Google Cloud list.

Cloudflare has no regions. Its 340 data centres come from the components of
its public status page (names like "Frankfurt, Germany - (FRA)"); each
takes the coordinates and country of the open airport with its IATA code
in OurAirports. Six codes without one (Berlin TXL, Bishkek FRU, Chișinău
KIV, Americana QWJ, Jiaxing JXG, Ramallah ZDM) are placed by hand at the
city centre (`CLOUDFLARE_PLACES`).

Every location is approximate (the city, or the airport), and the app says
so. The snapshot's `meta` lists each source with its URL, licence, fetch
date and record count.

| Source | URL | Fetched | Records |
| --- | --- | --- | --- |
| AWS regions | <https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html>, <https://aws.amazon.com/about-aws/global-infrastructure/regions_az/> | 2026-10-25 | 34 |
| Google Cloud regions | <https://cloud.google.com/compute/docs/regions-zones> | 2026-10-25 | 43 |
| Azure regions | <https://learn.microsoft.com/en-us/azure/reliability/regions-list> | 2026-10-25 | 57 |
| Cloudflare data centres | <https://www.cloudflarestatus.com/api/v2/components.json> (and <https://www.cloudflare.com/network/>) | 2026-10-25 | 340 |
| Coordinates of the Cloudflare sites | <https://davidmegginson.github.io/ourairports-data/airports.csv> (OurAirports, public domain) | 2026-10-25 | 334 (+ 6 by hand) |

To rebuild (two keyless downloads, saved in `scripts/infra-data/.cache`
(gitignored) and reused, so the same inputs give the same file; needs Node
22.18 or later):

```bash
node scripts/infra-data/build-cloud-regions.mjs
```

A test (`lib/infra/__tests__/sources.test.ts`) fails when the snapshot and
the curated table differ.

## Downloaded at run time

| What | Host | When | Terms |
| --- | --- | --- | --- |
| Blue Marble day tiles, levels 5–8 (EPSG:3857, `GoogleMapsCompatible_Level8`, about 600 m per pixel at level 8) | `gibs.earthdata.nasa.gov` | Only when the globe is zoomed in past the bundled levels; through the Rust tile cache (`$APPCACHE/tiles`, 500 MB) | GIBS: "NASA promotes full and open sharing of data." No API key, no stated rate limit. GIBS asks clients to add: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)." |
| PeeringDB exchange list (exchanges, peering LAN prefixes, facilities) | `www.peeringdb.com` | At most once a day, during traces, while exchange matching (**Internet exchanges** in Integration settings) is on | PeeringDB Acceptable Use Policy. Also the data of the exchange and data centre layers, which add no request. See [src-tauri/data/README.md](../src-tauri/data/README.md) and [architecture.md](./architecture.md) |
| Submarine cable map (`cable-geo.json`, about 0.75 MB) | `www.submarinecablemap.com` | Only after the user turns on **Submarine cables** and accepts its notice; then at most once a week while the layer is on (saved in `$APPCACHE/submarine-cables.json`) | TeleGeography, CC BY-NC-SA 3.0: non-commercial use, attribution, share-alike. See [Submarine cables](#submarine-cables) |
| Orbital elements (GP data, CSV) of the satellite groups Starlink, OneWeb, GPS (`gps-ops`), space stations and geostationary (`geo`); Starlink 1.70 MB | `celestrak.org` | Only after the user turns on **Satellites** and accepts its notice, for the groups that are on; each group at most once in 2 hours, reused for 12 hours (saved in `$APPCACHE/satellites/`) | CelesTrak's usage policy; GP data of the US Space Force. See [Satellites](#satellites) |

The tile requests show NASA the approximate areas of the globe you zoom
into; they carry no addresses. Automatic camera moves (following a trace,
selecting a hop, exports) stay at or above the height where the globe uses
only bundled imagery. Online tiles stay off at start-up and after such moves
until you zoom, drag or tilt the globe yourself. So automatic moves download
nothing and do not trace your route for NASA. Night imagery has no online
layer: it fades out as the camera comes close, where the day imagery takes
over (see [architecture.md](./architecture.md#globe)).

### PeeringDB data is not bundled

PeeringDB's Acceptable Use Policy (<https://www.peeringdb.com/aup>, read on
2026-10-25) says that "the PeeringDB data may not be passed on in bulk to
any other person or organization unless approved by PeeringDB". A bundled
snapshot of every exchange and facility would pass it on in bulk to every
user, so VisTracer does not ship one. The exchange and data centre layers
show the list that each installation downloads for exchange matching
(network troubleshooting, which the policy names as an operational use),
with the extra fields `net_count` (exchanges) and `name, org_name, city,
country, net_count, ix_count` (facilities). On 2026-10-25 that made the
`fac` download 1.17 MB and added 5,279 facilities, about 0.98 MB, to the
provider cache. A bundled snapshot needs PeeringDB's approval first.

### Submarine cables

The cable layer shows TeleGeography's Submarine Cable Map data. It is
downloaded by the backend from
`https://www.submarinecablemap.com/api/v3/cable/cable-geo.json` (733
features, 14,450 points on 2026-10-25), only after the user accepted the
layer's notice, which names the licence and the host. It is never bundled,
and the test fixture `src-tauri/fixtures/cables/cable-geo-sample.json` is
synthetic.

- **Licence.** TeleGeography's repository for the map, which published the
  links to these GeoJSON files, states: "Our map is made available under
  the following Creative Commons License: Attribution-NonCommercial-
  ShareAlike 3.0 Unported (CC BY-NC-SA 3.0)" (archived copy of
  <https://github.com/telegeography/www.submarinecablemap.com>, 2022-11-10;
  the repository was later deleted). TeleGeography's current citation page
  (<https://www2.telegeography.com/cite-telegeography-map>) offers its maps
  and screen captures under CC BY-SA 4.0 and keeps the underlying
  databases for subscribers. VisTracer applies the stricter terms: the
  notice says the data is for non-commercial use under CC BY-NC-SA 3.0,
  with attribution.
- **Attribution.** While the layer is on, the credits list "TeleGeography
  Submarine Cable Map" with the licence and the notice "Submarine cable
  data © TeleGeography, www.submarinecablemap.com, licensed CC BY-NC-SA
  3.0.", and the credits chip names TeleGeography. Each cable's hover card
  repeats the source and the licence, and exported images and videos carry
  the same notice in their lower right corner while the layer is on.
- **Privacy.** The request shows TeleGeography the user's IP address; it
  carries nothing about traces.

### Satellites

The satellites layer computes positions from orbital elements (OMM mean
elements for SGP4) that the backend downloads from CelesTrak:
`https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=csv`,
for the groups `starlink`, `oneweb`, `gps-ops`, `stations` and `geo` only.
On 2026-10-25 the Starlink group had 11,113 rows (1.70 MB), the space
stations 20 and the GPS group 32. Nothing is bundled; the test fixture
`src-tauri/fixtures/satellites/gp-sample.csv` has CelesTrak's column
layout with made-up rows and Vallado's published SGP4 test case 00005.

- **Terms.** CelesTrak (a non-profit run by Dr. T.S. Kelso) provides the
  data free of charge and publishes no licence for it; the GP data comes
  from the US Space Force's 18th Space Defense Squadron through
  Space-Track.org. CelesTrak's usage policy
  (<https://celestrak.org/usage-policy.php>, updated 2026-05-22, read on
  2026-10-25) and its GP documentation
  (<https://celestrak.org/NORAD/documentation/gp-data-formats.php>) ask
  apps to "only download the data you need, when you are going to use it,
  and only download data once per update" (GP data updates every 2
  hours), to stop querying after any answer that is not HTTP 200, and not
  to download the Active list and the Starlink list together. VisTracer
  never asks for the Active list, saves the time of each request before it
  goes out, asks for a group at most once in 2 hours, reuses a group for
  12 hours, and stops every request for 2 hours after an error (see
  [architecture.md](./architecture.md#satellites)). Every installation
  downloads the data itself; VisTracer does not pass it on.
- **Attribution.** While the layer is on, the credits list CelesTrak with
  the origin of the data, the chip names CelesTrak, and exported images
  and videos carry "Satellite positions computed from CelesTrak GP data
  (celestrak.org)."
- **Privacy.** The requests show CelesTrak the user's IP address and the
  groups shown; they carry nothing about traces.
- **Satellite internet providers.** The networks that mark a hop as a
  likely or possible satellite link (Starlink AS14593, OneWeb AS800, Viasat AS7155,
  HughesNet AS6621, Eutelsat Skylogic AS29286) are listed in
  `src/renderer/lib/satellites/isp.ts`; their names were checked in
  PeeringDB's network records on 2026-10-25.

## Test data in the repository

Not in the app. `src-tauri/fixtures/geoip/` holds four MaxMind DB test
files (54 KB) from <https://github.com/maxmind/MaxMind-DB>, for the GeoLite2
lookup tests. License: Apache-2.0 or MIT, MaxMind, Inc. The source commit,
the hashes and the MIT notice are in
[src-tauri/fixtures/geoip/README.md](../src-tauri/fixtures/geoip/README.md).

## Credits shown in the app

A small "NASA, GIBS, CesiumJS" button in the globe's lower right corner opens
the full list (`src/renderer/lib/attribution.ts`; keep it in step with this
file): CesiumJS, NASA Blue Marble and Black Marble, NASA GIBS with the
acknowledgement GIBS asks for (see the table above), Natural Earth, MaxMind
GeoLite2 with MaxMind's notice ("This product includes GeoLite2 data created
by MaxMind, available from https://www.maxmind.com."), PeeringDB (also for
the exchange and data centre layers), OurAirports, Team Cymru, RDAP and
RIPEstat, the cloud region sources, and satellite.js. While the submarine
cable layer is on, the list also has TeleGeography with its licence and
notice; while the satellites layer is on, CelesTrak with the origin of
its data. Each of them is then named on the chip too, for example "NASA,
GIBS, CesiumJS, TeleGeography, CelesTrak".

GIBS served the bundled day and night tiles (the build script asks the GIBS
WMS for them, see above) as well as the online tiles. So the GIBS credit and
its acknowledgement show at all times, and the button text does not change.
While online imagery is off in the layer panel, the GIBS entry only adds
"Online tiles: off". Cesium's own credit box is hidden, and the list has no
links: a link would open in the app window instead of a browser.

Sources checked on 2026-10-25:

- GIBS API documentation, "Data Use Guidance and Acknowledgements":
  <https://nasa-gibs.github.io/gibs-api-docs/>
- NASA images and media usage guidelines:
  <https://www.nasa.gov/nasa-brand-center/images-and-media/>
- GIBS capabilities (layer names, formats, tile matrix sets):
  <https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml>
