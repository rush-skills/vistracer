/**
 * Credits for the code and data the app shows. Keep in step with
 * docs/third-party-data.md and src-tauri/data/README.md.
 */

export type CreditGroup = "Globe" | "Hop data";

export interface Credit {
  name: string;
  group: CreditGroup;
  /** What it gives the app. */
  use: string;
  licence: string;
  /** Plain text: links would open inside the app window. */
  source: string;
  /** Required acknowledgement wording, when the provider asks for one. */
  notice?: string;
  /**
   * Also serves the online tiles, which the "Online imagery" switch turns
   * off. The credit stays either way; only a note says the online tiles are off.
   */
  servesOnlineTiles?: true;
}

export const CREDITS: readonly Credit[] = [
  {
    name: "CesiumJS",
    group: "Globe",
    use: "Globe engine",
    licence: "Apache-2.0",
    source: "github.com/CesiumGS/cesium"
  },
  {
    name: "NASA Blue Marble",
    group: "Globe",
    use: "Day imagery (bundled, levels 0–4)",
    licence: "NASA imagery, not subject to copyright in the US",
    source: "NASA Earth Observatory, Blue Marble: Next Generation"
  },
  {
    name: "NASA Black Marble 2016",
    group: "Globe",
    use: "City lights on the night side (bundled)",
    licence: "NASA imagery, not subject to copyright in the US",
    source: "Suomi NPP VIIRS"
  },
  {
    name: "NASA GIBS",
    group: "Globe",
    // scripts/build-globe-imagery.mjs takes the bundled tiles from GIBS too.
    use: "Served the bundled day and night tiles, and sharper day tiles when you zoom in (online imagery)",
    licence: "Open data",
    source: "gibs.earthdata.nasa.gov",
    notice:
      "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
    servesOnlineTiles: true
  },
  {
    name: "Natural Earth",
    group: "Globe",
    use: "Country borders",
    licence: "Public domain",
    source: "naturalearthdata.com"
  },
  {
    name: "MaxMind GeoLite2",
    group: "Hop data",
    use: "City, country and ASN of each address, from the databases you configure",
    licence: "GeoLite2 End User License Agreement",
    source: "maxmind.com",
    notice:
      "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com."
  },
  {
    name: "PeeringDB",
    group: "Hop data",
    use: "Internet exchange LANs and facilities, network records",
    licence: "PeeringDB Acceptable Use Policy",
    source: "peeringdb.com"
  },
  {
    name: "OurAirports",
    group: "Hop data",
    use: "Airport locations for router host name hints",
    licence: "Public domain",
    source: "ourairports.com"
  },
  {
    name: "Team Cymru, RDAP and RIPEstat",
    group: "Hop data",
    use: "Origin ASN, prefix and registry of each public address",
    licence: "Public services of Team Cymru, the regional internet registries and the RIPE NCC",
    source: "team-cymru.com, rdap.org, stat.ripe.net"
  }
];
