// Builds the bundled cloud region snapshot for the "Cloud regions" layer:
// src/renderer/public/infra/cloud-regions.json.
//
//   node scripts/infra-data/build-cloud-regions.mjs [--from <dir>] [output.json]
//
// Inputs:
// - cloud-regions.ts (this folder): AWS, Google Cloud and Azure regions,
//   hand-curated from the providers' documentation.
// - Cloudflare's data centres: the components of its public status page
//   (names like "Frankfurt, Germany - (FRA)"). No key needed.
// - OurAirports airports.csv (public domain): coordinates and country of
//   each Cloudflare data centre's IATA code; CLOUDFLARE_PLACES in
//   cloud-regions.ts for the few codes it has no open airport for.
//
// The two downloads are saved in the --from folder (default
// scripts/infra-data/.cache, gitignored) and read from there on the next run,
// so a rebuild with the same inputs gives the same file. Delete the folder
// to download again. Needs Node 22.18 or later (TypeScript type stripping).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDFLARE_PLACES, CURATED_PROVIDERS, CURATED_REGIONS } from "./cloud-regions.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLOUDFLARE_URL = "https://www.cloudflarestatus.com/api/v2/components.json";
const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const SCHEMA_VERSION = 1;

const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const inputDir = path.resolve(
  fromIndex >= 0 ? args.splice(fromIndex, 2)[1] : path.join(ROOT, "scripts", "infra-data", ".cache")
);
const output = path.resolve(args[0] ?? path.join(ROOT, "src/renderer/public/infra/cloud-regions.json"));

/** A saved download, or a new one saved for the next run. */
async function input(url, file) {
  const saved = path.join(inputDir, file);
  if (fs.existsSync(saved)) {
    return { text: fs.readFileSync(saved, "utf8"), fetchedAt: fs.statSync(saved).mtime };
  }
  const response = await fetch(url, { headers: { "User-Agent": "VisTracer infra-data build" } });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(saved, text);
  return { text, fetchedAt: new Date() };
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const AIRPORT_RANK = { large_airport: 3, medium_airport: 2, small_airport: 1 };

/** IATA code → the largest open airport with that code. */
function airportsByIata(csv) {
  const [header, ...rows] = parseCsv(csv);
  const col = (name) => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`airports.csv has no ${name} column`);
    }
    return index;
  };
  const [iata, type, lat, lon, country] = [
    "iata_code",
    "type",
    "latitude_deg",
    "longitude_deg",
    "iso_country"
  ].map(col);
  const best = new Map();
  for (const row of rows) {
    const code = row[iata];
    const rank = AIRPORT_RANK[row[type]];
    const latitude = Number(row[lat]);
    const longitude = Number(row[lon]);
    if (!/^[A-Z]{3}$/.test(code ?? "") || !rank || !isFinite(latitude) || !isFinite(longitude)) {
      continue;
    }
    if ((best.get(code)?.rank ?? 0) < rank) {
      best.set(code, { rank, latitude, longitude, country: row[country] });
    }
  }
  return best;
}

const round = (value) => Math.round(value * 100) / 100;

function cloudflareSites(statusJson, airports) {
  const components = JSON.parse(statusJson).components;
  if (!Array.isArray(components)) {
    throw new Error("the Cloudflare status page has no components list");
  }
  const sites = [];
  const unplaced = [];
  for (const component of components) {
    const match = /^(.+) - \(([A-Z]{3})\)$/.exec(component?.name ?? "");
    if (!match || !component.group_id) {
      continue;
    }
    const [, place, code] = match;
    const airport = airports.get(code) ?? CLOUDFLARE_PLACES.find((place) => place.code === code);
    if (!airport) {
      unplaced.push(component.name);
      continue;
    }
    sites.push({
      provider: "cloudflare",
      code,
      name: place,
      city: place.split(",")[0].trim(),
      country: airport.country,
      latitude: round(airport.latitude),
      longitude: round(airport.longitude),
      approximate: true
    });
  }
  return { sites, unplaced };
}

function validate(regions) {
  const providers = new Set(CURATED_PROVIDERS.map((provider) => provider.id));
  const seen = new Set();
  for (const region of regions) {
    const key = `${region.provider}/${region.code}`;
    const problems = [
      !providers.has(region.provider) && "unknown provider",
      !/^[a-z0-9-]{2,40}$/i.test(region.code) && "bad code",
      seen.has(key) && "duplicate code",
      !region.name || !region.city ? "missing name or city" : false,
      !/^[A-Z]{2}$/.test(region.country) && "bad country",
      !(Math.abs(region.latitude) <= 90 && Math.abs(region.longitude) <= 180) && "bad coordinates"
    ].filter(Boolean);
    if (problems.length) {
      throw new Error(`${key}: ${problems.join(", ")}`);
    }
    seen.add(key);
  }
}

const day = (date) => date.toISOString().slice(0, 10);

const [cloudflareInput, airportsInput] = await Promise.all([
  input(CLOUDFLARE_URL, "cloudflare-components.json"),
  input(AIRPORTS_URL, "airports.csv")
]);
const { sites, unplaced } = cloudflareSites(cloudflareInput.text, airportsByIata(airportsInput.text));
const regions = [
  ...CURATED_REGIONS.map((region) => ({ ...region, approximate: true })),
  ...sites.sort((a, b) => a.code.localeCompare(b.code))
];
validate(regions);

const count = (provider) => regions.filter((region) => region.provider === provider).length;
const snapshot = {
  meta: {
    schema: SCHEMA_VERSION,
    name: "cloud-regions",
    builtBy: "scripts/infra-data/build-cloud-regions.mjs",
    // The newest input date, not today: the same inputs give the same file.
    builtAt: [
      ...CURATED_PROVIDERS.map((provider) => provider.checkedAt),
      day(cloudflareInput.fetchedAt),
      day(airportsInput.fetchedAt)
    ]
      .sort()
      .at(-1),
    recordCount: regions.length,
    coordinates:
      "Approximate: the centre of the city a provider names (AWS, Google Cloud, Azure) or the airport of a Cloudflare data centre's IATA code.",
    sources: [
      ...CURATED_PROVIDERS.filter((provider) => provider.id !== "cloudflare").map((provider) => ({
        what: `${provider.name} regions, hand-curated`,
        urls: provider.sources,
        licence: "Facts from the provider's public documentation",
        fetchedAt: provider.checkedAt,
        recordCount: count(provider.id)
      })),
      {
        what: "Cloudflare data centres",
        urls: [CLOUDFLARE_URL],
        licence: "Facts from Cloudflare's public status page",
        fetchedAt: day(cloudflareInput.fetchedAt),
        recordCount: count("cloudflare")
      },
      {
        what: "Coordinates and countries of the Cloudflare data centres",
        urls: [AIRPORTS_URL],
        licence: "Public domain (OurAirports)",
        fetchedAt: day(airportsInput.fetchedAt),
        recordCount: count("cloudflare")
      }
    ]
  },
  providers: CURATED_PROVIDERS.map(({ id, name, shortName, operator, asns }) => ({
    id,
    name,
    shortName,
    operator,
    asns: [...asns],
    sites: id === "cloudflare" ? "data-centres" : "regions"
  })),
  regions
};

fs.mkdirSync(path.dirname(output), { recursive: true });
// One site per line keeps the file small and its diffs readable.
const body = JSON.stringify({ ...snapshot, regions: [] }, null, 1).replace(
  '"regions": []',
  `"regions": [\n${regions.map((region) => `  ${JSON.stringify(region)}`).join(",\n")}\n ]`
);
fs.writeFileSync(output, `${body}\n`);
console.log(
  `${output}: ${regions.length} sites (${CURATED_PROVIDERS.map((p) => `${p.id} ${count(p.id)}`).join(", ")}), ${fs.statSync(output).size} bytes`
);
if (unplaced.length) {
  console.log(`Cloudflare data centres without an OurAirports IATA match (left out): ${unplaced.join("; ")}`);
}
