#!/usr/bin/env node
// Trims the OurAirports airports.csv (public domain) to the table that the
// hostname-hint parser bundles: src-tauri/data/airports.csv.
//
//   curl -o /tmp/ourairports/airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
//   node scripts/build-airport-table.mjs /tmp/ourairports/airports.csv src-tauri/data/airports.csv
//
// Kept: large airports and medium airports with scheduled service that have
// a 3-letter IATA code. Columns: iata,latitude,longitude,country,size,municipality
// (size L = large, M = medium). Municipality is the last column and may
// contain commas. Coordinates are rounded to 0.01 degrees.

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: build-airport-table.mjs <airports.csv> <output.csv>");
  process.exit(2);
}

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
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const [header, ...data] = parseCsv(readFileSync(input, "utf8"));
const col = Object.fromEntries(header.map((name, index) => [name, index]));
for (const name of [
  "type",
  "latitude_deg",
  "longitude_deg",
  "iso_country",
  "municipality",
  "scheduled_service",
  "iata_code"
]) {
  if (!(name in col)) {
    throw new Error(`airports.csv has no "${name}" column`);
  }
}

const seen = new Set();
const lines = [];
for (const row of data) {
  const iata = row[col.iata_code] ?? "";
  const type = row[col.type];
  const scheduled = row[col.scheduled_service] === "yes";
  const size = type === "large_airport" ? "L" : type === "medium_airport" && scheduled ? "M" : null;
  if (!size || !/^[A-Z]{3}$/.test(iata) || seen.has(iata)) continue;
  const lat = Number(row[col.latitude_deg]);
  const lon = Number(row[col.longitude_deg]);
  const country = row[col.iso_country];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !/^[A-Z]{2}$/.test(country)) continue;
  seen.add(iata);
  const municipality = (row[col.municipality] ?? "").replace(/[\r\n]+/g, " ").trim();
  lines.push(`${iata},${lat.toFixed(2)},${lon.toFixed(2)},${country},${size},${municipality}`);
}
lines.sort();
writeFileSync(output, `${lines.join("\n")}\n`);
console.log(`wrote ${lines.length} airports to ${output}`);
