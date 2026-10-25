import type {
  CableData,
  CloudProvider,
  CloudRegion,
  CloudRegionData,
  Exchange,
  Facility,
  PeeringDbSiteData
} from "@renderer/lib/infra/sources";

/** Small, parsed infrastructure data for renderer tests. */

export const exchange = (
  id: number,
  name: string,
  latitude: number,
  longitude: number,
  networkCount = 100
): Exchange => ({
  key: `ix:${id}`,
  id,
  name,
  city: null,
  country: null,
  latitude,
  longitude,
  radiusKm: 25,
  facilityCount: 3,
  networkCount
});

export const facility = (
  id: number,
  name: string,
  latitude: number,
  longitude: number,
  networkCount = 50
): Facility => ({
  key: `fac:${id}`,
  id,
  name,
  org: null,
  city: null,
  country: null,
  latitude,
  longitude,
  networkCount,
  exchangeCount: 2
});

export const PEERINGDB: PeeringDbSiteData = {
  storedAt: 1,
  complete: true,
  exchanges: [
    exchange(31, "DE-CIX Frankfurt", 50.11, 8.68, 1019),
    exchange(26, "AMS-IX", 52.36, 4.95, 856),
    exchange(359, "France-IX Marseille", 43.31, 5.37, 90)
  ],
  facilities: [
    facility(58, "Digital Realty Frankfurt FRA1-27", 50.12, 8.74, 618),
    facility(60, "Equinix FR5", 50.1, 8.63, 400),
    facility(18, "NIKHEF Amsterdam", 52.36, 4.95, 504),
    facility(900, "Interxion MRS1", 43.31, 5.37, 120)
  ],
  rejected: 0
};

export const PROVIDERS: CloudProvider[] = [
  { id: "aws", name: "Amazon Web Services", shortName: "AWS", asns: [16509, 14618], sites: "regions" },
  { id: "gcp", name: "Google Cloud", shortName: "Google Cloud", asns: [15169, 396982], sites: "regions" },
  { id: "cloudflare", name: "Cloudflare", shortName: "Cloudflare", asns: [13335], sites: "data-centres" }
];

export const region = (
  provider: string,
  code: string,
  city: string,
  latitude: number,
  longitude: number
): CloudRegion => ({
  key: `${provider}:${code}`,
  provider,
  code,
  name: city,
  city,
  country: "XX",
  latitude,
  longitude
});

export const CLOUD: CloudRegionData = {
  builtAt: "2026-10-25",
  sources: [],
  providers: PROVIDERS,
  regions: [
    region("aws", "eu-central-1", "Frankfurt", 50.11, 8.68),
    region("aws", "ap-south-1", "Mumbai", 19.08, 72.88),
    region("aws", "us-east-1", "Ashburn", 39.04, -77.49),
    region("gcp", "europe-west3", "Frankfurt", 50.11, 8.68),
    region("cloudflare", "FRA", "Frankfurt", 50.03, 8.56)
  ],
  rejected: 0
};

export const CABLES: CableData = {
  fetchedAt: 1,
  note: null,
  cables: [
    {
      key: "cable:indian-ocean",
      id: "indian-ocean",
      name: "Example Indian Ocean Cable",
      segments: [
        [
          [72.83, 18.94],
          [60, 15],
          [43, 12.6],
          [32.3, 31.3],
          [5.37, 43.3]
        ]
      ]
    },
    {
      key: "cable:atlantic",
      id: "atlantic",
      name: "Example Atlantic Cable",
      segments: [
        [
          [-73.97, 40.59],
          [-40, 47],
          [-4.55, 50.83]
        ]
      ]
    }
  ],
  rejected: 0
};
