import { SATELLITES_LAYER_ID, SUBMARINE_CABLES_LAYER_ID } from "@common/ipc";
import type { LayerId, LayerVisibility } from "./layers";

/**
 * Credits for the code and data the app shows. Keep in step with
 * docs/third-party-data.md and src-tauri/data/README.md.
 */

export type CreditGroup = "Globe" | "Hop data" | "Infrastructure" | "Space";

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
  /** Listed only while this layer is on (data the user opted in to). */
  layer?: LayerId;
  /** Named on the credits chip too while the layer is on. */
  chip?: string;
}

/** The credits chip: the always-shown sources, then the opt-in data that is on. */
export function creditsChip(visibility: LayerVisibility): string {
  return [
    "NASA, GIBS, CesiumJS",
    ...CREDITS.flatMap((credit) =>
      credit.layer && credit.chip && visibility[credit.layer] ? [credit.chip] : []
    )
  ].join(", ");
}

/**
 * The notices that exported images and videos must carry: those of opt-in
 * data whose layer is on (CC BY asks for attribution in the medium, and an
 * export leaves the app). Empty while no such layer is on.
 */
export function exportCredits(visibility: LayerVisibility): string[] {
  return CREDITS.flatMap((credit) =>
    credit.layer && credit.notice && visibility[credit.layer] ? [credit.notice] : []
  );
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
    use: "Internet exchange LANs and facilities, network records; the exchange and data centre layers",
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
  },
  {
    name: "Cloud regions",
    group: "Infrastructure",
    use: "AWS, Google Cloud and Microsoft Azure regions from their documentation, Cloudflare data centres from its status page (bundled, approximate locations)",
    licence: "Facts from the providers' public documentation; names are trademarks of their owners",
    source: "docs.aws.amazon.com, cloud.google.com, learn.microsoft.com, cloudflarestatus.com"
  },
  {
    name: "TeleGeography Submarine Cable Map",
    group: "Infrastructure",
    use: "Submarine cable routes (opt-in layer)",
    licence: "CC BY-NC-SA 3.0: non-commercial use, with attribution, adaptations under the same licence",
    source: "submarinecablemap.com",
    notice: "Submarine cable data © TeleGeography, www.submarinecablemap.com, licensed CC BY-NC-SA 3.0.",
    layer: SUBMARINE_CABLES_LAYER_ID,
    // CC BY asks for attribution in the medium.
    chip: "TeleGeography"
  },
  {
    name: "CelesTrak",
    group: "Space",
    use: "Orbital elements (GP data) of the satellite groups (opt-in layer)",
    licence:
      "Free of charge under CelesTrak's usage policy; GP data of the US Space Force (18th Space Defense Squadron)",
    source: "celestrak.org",
    notice: "Satellite positions computed from CelesTrak GP data (celestrak.org).",
    layer: SATELLITES_LAYER_ID,
    chip: "CelesTrak"
  },
  {
    name: "satellite.js",
    group: "Space",
    use: "SGP4 orbit propagation for the satellites layer",
    licence: "MIT",
    source: "github.com/shashwatak/satellite-js"
  }
];
