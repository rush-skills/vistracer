# Bundled data

Data files compiled into the backend. Each entry gives the source, the
license and how to rebuild the file.

## airports.csv

| | |
| --- | --- |
| Source | [OurAirports](https://ourairports.com/data/), `airports.csv` (file dated 2026-10-23, downloaded 2026-10-24 from the [GitHub mirror](https://davidmegginson.github.io/ourairports-data/airports.csv)) |
| License | Public domain: "All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use." No attribution is required; this file gives it anyway. |
| Used by | `src/geoloc/places.rs` (host name hints, IX city fallback) |
| Size | 3,266 rows, about 104 KB |

Kept rows: large airports, and medium airports with scheduled service, that
have a 3-letter IATA code. Columns: `iata,latitude,longitude,country,size,municipality`
(`size` is `L` or `M`; `municipality` is the last column and can contain
commas). Coordinates are rounded to 0.01° (about 1 km).

To rebuild:

```bash
mkdir -p /tmp/ourairports
curl -o /tmp/ourairports/airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
node scripts/build-airport-table.mjs /tmp/ourairports/airports.csv src-tauri/data/airports.csv
```

## Hand-written tables

These tables are facts written for VisTracer, not copies of a licensed
database. They are MIT-licensed with the rest of the code.

| Table | File | Source of the facts |
| --- | --- | --- |
| IATA metro codes, city names, 6-letter city codes (`lsanca`) | `src/geoloc/places.rs` | Public carrier host names and the IATA metro code list |
| Carrier site codes (Arelion `ffm`, Hurricane Electric `fmt`) | `src/geoloc/hostname.rs` | Public carrier host names |
| Anycast prefixes (public DNS, root servers) and anycast operator ASNs | `src/geoloc/anycast.rs` | Operator documentation and [root-servers.org](https://root-servers.org/) |

Each curated place points to an airport in `airports.csv` for its
coordinates; a unit test fails when a code is missing.

## Data fetched at run time

The PeeringDB IX list (`ixpfx`, `ixlan`, `ix`, `ixfac`, `fac`) is not
bundled. When exchange matching is on (the default), the app downloads it at
most once a day and keeps it in the provider cache
(`$APPCACHE/enrichment-cache.json`). See `docs/architecture.md`.
