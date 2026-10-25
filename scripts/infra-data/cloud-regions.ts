/**
 * Hand-curated cloud regions for the "Cloud regions" globe layer.
 * scripts/infra-data/build-cloud-regions.mjs reads this file and writes
 * src/renderer/public/infra/cloud-regions.json. Facts from each provider's
 * public documentation (URLs below), checked on 2026-10-25. Coordinates are the
 * centre of the named city, rounded to 0.01°: approximate on purpose.
 *
 * Cloudflare has no regions: its sites are the data centres on its status
 * page, which the build script downloads (see CLOUDFLARE below).
 */

export type CuratedProviderId = "aws" | "gcp" | "azure" | "cloudflare";

export interface CuratedProvider {
  id: CuratedProviderId;
  /** Full name, e.g. "Amazon Web Services". */
  name: string;
  /** Short name for labels, e.g. "AWS". */
  shortName: string;
  /**
   * The company whose networks the ASNs are, e.g. "Amazon". Most of them
   * carry the company's other services and edge sites too, not only its cloud.
   */
  operator: string;
  /** ASNs the provider's cloud uses (checked in PeeringDB). */
  asns: readonly number[];
  /** Documentation pages the regions come from. */
  sources: readonly string[];
  /** YYYY-MM-DD */
  checkedAt: string;
}

export interface CuratedRegion {
  provider: CuratedProviderId;
  /** The provider's region id, e.g. "eu-central-1", "europe-west3", "germanywestcentral". */
  code: string;
  /** The provider's display name, e.g. "Europe (Frankfurt)", "Frankfurt", "Germany West Central". */
  name: string;
  city: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  latitude: number;
  longitude: number;
}

export const CURATED_PROVIDERS = [
  { id: "aws", name: "Amazon Web Services", shortName: "AWS", operator: "Amazon", asns: [16509, 14618, 7224], sources: ["https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html", "https://aws.amazon.com/about-aws/global-infrastructure/regions_az/"], checkedAt: "2026-10-25" },
  { id: "gcp", name: "Google Cloud", shortName: "Google Cloud", operator: "Google", asns: [15169, 396982, 19527, 36040, 43515, 139070], sources: ["https://cloud.google.com/compute/docs/regions-zones"], checkedAt: "2026-10-25" },
  { id: "azure", name: "Microsoft Azure", shortName: "Azure", operator: "Microsoft", asns: [8075, 8068, 8069, 12076], sources: ["https://learn.microsoft.com/en-us/azure/reliability/regions-list"], checkedAt: "2026-10-25" },
  // Data centres, not regions: downloaded from the status page by the build script.
  { id: "cloudflare", name: "Cloudflare", shortName: "Cloudflare", operator: "Cloudflare", asns: [13335, 209242], sources: ["https://www.cloudflarestatus.com/api/v2/components.json", "https://www.cloudflare.com/network/"], checkedAt: "2026-10-25" }
] as const satisfies readonly CuratedProvider[];

export const CURATED_REGIONS = [
  { provider: "aws", code: "af-south-1", name: "Africa (Cape Town)", city: "Cape Town", country: "ZA", latitude: -33.92, longitude: 18.42 },
  { provider: "aws", code: "ap-east-1", name: "Asia Pacific (Hong Kong)", city: "Hong Kong", country: "HK", latitude: 22.32, longitude: 114.17 },
  { provider: "aws", code: "ap-east-2", name: "Asia Pacific (Taipei)", city: "Taipei", country: "TW", latitude: 25.03, longitude: 121.57 },
  { provider: "aws", code: "ap-northeast-1", name: "Asia Pacific (Tokyo)", city: "Tokyo", country: "JP", latitude: 35.68, longitude: 139.65 },
  { provider: "aws", code: "ap-northeast-2", name: "Asia Pacific (Seoul)", city: "Seoul", country: "KR", latitude: 37.57, longitude: 126.98 },
  { provider: "aws", code: "ap-northeast-3", name: "Asia Pacific (Osaka)", city: "Osaka", country: "JP", latitude: 34.69, longitude: 135.5 },
  { provider: "aws", code: "ap-south-1", name: "Asia Pacific (Mumbai)", city: "Mumbai", country: "IN", latitude: 19.08, longitude: 72.88 },
  { provider: "aws", code: "ap-south-2", name: "Asia Pacific (Hyderabad)", city: "Hyderabad", country: "IN", latitude: 17.39, longitude: 78.49 },
  { provider: "aws", code: "ap-southeast-1", name: "Asia Pacific (Singapore)", city: "Singapore", country: "SG", latitude: 1.29, longitude: 103.85 },
  { provider: "aws", code: "ap-southeast-2", name: "Asia Pacific (Sydney)", city: "Sydney", country: "AU", latitude: -33.87, longitude: 151.21 },
  { provider: "aws", code: "ap-southeast-3", name: "Asia Pacific (Jakarta)", city: "Jakarta", country: "ID", latitude: -6.21, longitude: 106.85 },
  { provider: "aws", code: "ap-southeast-4", name: "Asia Pacific (Melbourne)", city: "Melbourne", country: "AU", latitude: -37.81, longitude: 144.96 },
  { provider: "aws", code: "ap-southeast-5", name: "Asia Pacific (Malaysia)", city: "Kuala Lumpur", country: "MY", latitude: 3.14, longitude: 101.69 }, // provider names only Malaysia
  { provider: "aws", code: "ap-southeast-6", name: "Asia Pacific (New Zealand)", city: "Auckland", country: "NZ", latitude: -36.85, longitude: 174.76 }, // provider names only New Zealand
  { provider: "aws", code: "ap-southeast-7", name: "Asia Pacific (Thailand)", city: "Bangkok", country: "TH", latitude: 13.76, longitude: 100.5 }, // provider names only Thailand
  { provider: "aws", code: "ca-central-1", name: "Canada (Central)", city: "Montreal", country: "CA", latitude: 45.5, longitude: -73.57 }, // provider names only Central (Canada)
  { provider: "aws", code: "ca-west-1", name: "Canada West (Calgary)", city: "Calgary", country: "CA", latitude: 51.04, longitude: -114.07 },
  { provider: "aws", code: "eu-central-1", name: "Europe (Frankfurt)", city: "Frankfurt", country: "DE", latitude: 50.11, longitude: 8.68 },
  { provider: "aws", code: "eu-central-2", name: "Europe (Zurich)", city: "Zurich", country: "CH", latitude: 47.38, longitude: 8.54 },
  { provider: "aws", code: "eu-north-1", name: "Europe (Stockholm)", city: "Stockholm", country: "SE", latitude: 59.33, longitude: 18.07 },
  { provider: "aws", code: "eu-south-1", name: "Europe (Milan)", city: "Milan", country: "IT", latitude: 45.46, longitude: 9.19 },
  { provider: "aws", code: "eu-south-2", name: "Europe (Spain)", city: "Zaragoza", country: "ES", latitude: 41.65, longitude: -0.89 }, // provider names only Spain (region is in Aragón)
  { provider: "aws", code: "eu-west-1", name: "Europe (Ireland)", city: "Dublin", country: "IE", latitude: 53.35, longitude: -6.26 }, // provider names only Ireland
  { provider: "aws", code: "eu-west-2", name: "Europe (London)", city: "London", country: "GB", latitude: 51.51, longitude: -0.13 },
  { provider: "aws", code: "eu-west-3", name: "Europe (Paris)", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.35 },
  { provider: "aws", code: "il-central-1", name: "Israel (Tel Aviv)", city: "Tel Aviv", country: "IL", latitude: 32.09, longitude: 34.78 },
  { provider: "aws", code: "me-central-1", name: "Middle East (UAE)", city: "Abu Dhabi", country: "AE", latitude: 24.45, longitude: 54.38 }, // provider names only UAE (AWS's region map puts the marker at Dubai)
  { provider: "aws", code: "me-south-1", name: "Middle East (Bahrain)", city: "Manama", country: "BH", latitude: 26.23, longitude: 50.59 }, // provider names only Bahrain
  { provider: "aws", code: "mx-central-1", name: "Mexico (Central)", city: "Querétaro", country: "MX", latitude: 20.59, longitude: -100.39 }, // provider names only Central (Mexico)
  { provider: "aws", code: "sa-east-1", name: "South America (São Paulo)", city: "São Paulo", country: "BR", latitude: -23.55, longitude: -46.63 },
  { provider: "aws", code: "us-east-1", name: "US East (N. Virginia)", city: "Ashburn", country: "US", latitude: 39.04, longitude: -77.49 }, // provider names only N. Virginia
  { provider: "aws", code: "us-east-2", name: "US East (Ohio)", city: "Columbus", country: "US", latitude: 39.96, longitude: -83.0 }, // provider names only Ohio
  { provider: "aws", code: "us-west-1", name: "US West (N. California)", city: "San Francisco", country: "US", latitude: 37.77, longitude: -122.42 }, // provider names only N. California
  { provider: "aws", code: "us-west-2", name: "US West (Oregon)", city: "Boardman", country: "US", latitude: 45.84, longitude: -119.7 }, // provider names only Oregon
  { provider: "gcp", code: "africa-south1", name: "Johannesburg", city: "Johannesburg", country: "ZA", latitude: -26.2, longitude: 28.05 },
  { provider: "gcp", code: "asia-east1", name: "Changhua County", city: "Changhua", country: "TW", latitude: 24.08, longitude: 120.54 }, // provider names only Changhua County
  { provider: "gcp", code: "asia-east2", name: "Hong Kong", city: "Hong Kong", country: "HK", latitude: 22.32, longitude: 114.17 },
  { provider: "gcp", code: "asia-northeast1", name: "Tokyo", city: "Tokyo", country: "JP", latitude: 35.68, longitude: 139.65 },
  { provider: "gcp", code: "asia-northeast2", name: "Osaka", city: "Osaka", country: "JP", latitude: 34.69, longitude: 135.5 },
  { provider: "gcp", code: "asia-northeast3", name: "Seoul", city: "Seoul", country: "KR", latitude: 37.57, longitude: 126.98 },
  { provider: "gcp", code: "asia-south1", name: "Mumbai", city: "Mumbai", country: "IN", latitude: 19.08, longitude: 72.88 },
  { provider: "gcp", code: "asia-south2", name: "Delhi", city: "Delhi", country: "IN", latitude: 28.61, longitude: 77.21 },
  { provider: "gcp", code: "asia-southeast1", name: "Jurong West", city: "Jurong West", country: "SG", latitude: 1.34, longitude: 103.71 },
  { provider: "gcp", code: "asia-southeast2", name: "Jakarta", city: "Jakarta", country: "ID", latitude: -6.21, longitude: 106.85 },
  { provider: "gcp", code: "asia-southeast3", name: "Bangkok", city: "Bangkok", country: "TH", latitude: 13.76, longitude: 100.5 },
  { provider: "gcp", code: "australia-southeast1", name: "Sydney", city: "Sydney", country: "AU", latitude: -33.87, longitude: 151.21 },
  { provider: "gcp", code: "australia-southeast2", name: "Melbourne", city: "Melbourne", country: "AU", latitude: -37.81, longitude: 144.96 },
  { provider: "gcp", code: "europe-central2", name: "Warsaw", city: "Warsaw", country: "PL", latitude: 52.23, longitude: 21.01 },
  { provider: "gcp", code: "europe-north1", name: "Hamina", city: "Hamina", country: "FI", latitude: 60.57, longitude: 27.2 },
  { provider: "gcp", code: "europe-north2", name: "Stockholm", city: "Stockholm", country: "SE", latitude: 59.33, longitude: 18.07 },
  { provider: "gcp", code: "europe-southwest1", name: "Madrid", city: "Madrid", country: "ES", latitude: 40.42, longitude: -3.7 },
  { provider: "gcp", code: "europe-west1", name: "St. Ghislain", city: "St. Ghislain", country: "BE", latitude: 50.45, longitude: 3.82 },
  { provider: "gcp", code: "europe-west10", name: "Berlin", city: "Berlin", country: "DE", latitude: 52.52, longitude: 13.4 },
  { provider: "gcp", code: "europe-west12", name: "Turin", city: "Turin", country: "IT", latitude: 45.07, longitude: 7.69 },
  { provider: "gcp", code: "europe-west2", name: "London", city: "London", country: "GB", latitude: 51.51, longitude: -0.13 },
  { provider: "gcp", code: "europe-west3", name: "Frankfurt", city: "Frankfurt", country: "DE", latitude: 50.11, longitude: 8.68 },
  { provider: "gcp", code: "europe-west4", name: "Eemshaven", city: "Eemshaven", country: "NL", latitude: 53.44, longitude: 6.83 },
  { provider: "gcp", code: "europe-west6", name: "Zurich", city: "Zurich", country: "CH", latitude: 47.38, longitude: 8.54 },
  { provider: "gcp", code: "europe-west8", name: "Milan", city: "Milan", country: "IT", latitude: 45.46, longitude: 9.19 },
  { provider: "gcp", code: "europe-west9", name: "Paris", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.35 },
  { provider: "gcp", code: "me-central1", name: "Doha", city: "Doha", country: "QA", latitude: 25.29, longitude: 51.53 },
  { provider: "gcp", code: "me-central2", name: "Dammam", city: "Dammam", country: "SA", latitude: 26.42, longitude: 50.09 },
  { provider: "gcp", code: "me-west1", name: "Tel Aviv", city: "Tel Aviv", country: "IL", latitude: 32.09, longitude: 34.78 },
  { provider: "gcp", code: "northamerica-northeast1", name: "Montréal", city: "Montréal", country: "CA", latitude: 45.5, longitude: -73.57 },
  { provider: "gcp", code: "northamerica-northeast2", name: "Toronto", city: "Toronto", country: "CA", latitude: 43.65, longitude: -79.38 },
  { provider: "gcp", code: "northamerica-south1", name: "Queretaro", city: "Queretaro", country: "MX", latitude: 20.59, longitude: -100.39 },
  { provider: "gcp", code: "southamerica-east1", name: "Osasco", city: "Osasco", country: "BR", latitude: -23.53, longitude: -46.79 },
  { provider: "gcp", code: "southamerica-west1", name: "Santiago", city: "Santiago", country: "CL", latitude: -33.45, longitude: -70.67 },
  { provider: "gcp", code: "us-central1", name: "Council Bluffs", city: "Council Bluffs", country: "US", latitude: 41.26, longitude: -95.86 },
  { provider: "gcp", code: "us-east1", name: "Moncks Corner", city: "Moncks Corner", country: "US", latitude: 33.2, longitude: -80.01 },
  { provider: "gcp", code: "us-east4", name: "Ashburn", city: "Ashburn", country: "US", latitude: 39.04, longitude: -77.49 },
  { provider: "gcp", code: "us-east5", name: "Columbus", city: "Columbus", country: "US", latitude: 39.96, longitude: -83.0 },
  { provider: "gcp", code: "us-south1", name: "Dallas", city: "Dallas", country: "US", latitude: 32.78, longitude: -96.8 },
  { provider: "gcp", code: "us-west1", name: "The Dalles", city: "The Dalles", country: "US", latitude: 45.59, longitude: -121.18 },
  { provider: "gcp", code: "us-west2", name: "Los Angeles", city: "Los Angeles", country: "US", latitude: 34.05, longitude: -118.24 },
  { provider: "gcp", code: "us-west3", name: "Salt Lake City", city: "Salt Lake City", country: "US", latitude: 40.76, longitude: -111.89 },
  { provider: "gcp", code: "us-west4", name: "Las Vegas", city: "Las Vegas", country: "US", latitude: 36.17, longitude: -115.14 },
  { provider: "azure", code: "australiacentral", name: "Australia Central", city: "Canberra", country: "AU", latitude: -35.28, longitude: 149.13 },
  { provider: "azure", code: "australiacentral2", name: "Australia Central 2", city: "Canberra", country: "AU", latitude: -35.28, longitude: 149.13 }, // restricted access
  { provider: "azure", code: "australiaeast", name: "Australia East", city: "Sydney", country: "AU", latitude: -33.87, longitude: 151.21 }, // provider names only New South Wales
  { provider: "azure", code: "australiasoutheast", name: "Australia Southeast", city: "Melbourne", country: "AU", latitude: -37.81, longitude: 144.96 }, // provider names only Victoria
  { provider: "azure", code: "austriaeast", name: "Austria East", city: "Vienna", country: "AT", latitude: 48.21, longitude: 16.37 },
  { provider: "azure", code: "belgiumcentral", name: "Belgium Central", city: "Brussels", country: "BE", latitude: 50.85, longitude: 4.35 },
  { provider: "azure", code: "brazilsouth", name: "Brazil South", city: "Campinas", country: "BR", latitude: -22.91, longitude: -47.06 }, // provider names only Sao Paulo State
  { provider: "azure", code: "brazilsoutheast", name: "Brazil Southeast", city: "Rio de Janeiro", country: "BR", latitude: -22.91, longitude: -43.17 }, // provider names only Rio; restricted access
  { provider: "azure", code: "canadacentral", name: "Canada Central", city: "Toronto", country: "CA", latitude: 43.65, longitude: -79.38 },
  { provider: "azure", code: "canadaeast", name: "Canada East", city: "Quebec City", country: "CA", latitude: 46.81, longitude: -71.21 }, // provider names only Quebec
  { provider: "azure", code: "centralindia", name: "Central India", city: "Pune", country: "IN", latitude: 18.52, longitude: 73.86 },
  { provider: "azure", code: "centralus", name: "Central US", city: "Des Moines", country: "US", latitude: 41.59, longitude: -93.62 }, // provider names only Iowa
  { provider: "azure", code: "chilecentral", name: "Chile Central", city: "Santiago", country: "CL", latitude: -33.45, longitude: -70.67 },
  { provider: "azure", code: "denmarkeast", name: "Denmark East", city: "Copenhagen", country: "DK", latitude: 55.68, longitude: 12.57 },
  { provider: "azure", code: "eastasia", name: "East Asia", city: "Hong Kong", country: "HK", latitude: 22.32, longitude: 114.17 },
  { provider: "azure", code: "eastus", name: "East US", city: "Boydton", country: "US", latitude: 36.67, longitude: -78.39 }, // provider names only Virginia
  { provider: "azure", code: "eastus2", name: "East US 2", city: "Boydton", country: "US", latitude: 36.67, longitude: -78.39 }, // provider names only Virginia
  { provider: "azure", code: "francecentral", name: "France Central", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.35 },
  { provider: "azure", code: "francesouth", name: "France South", city: "Marseille", country: "FR", latitude: 43.3, longitude: 5.37 }, // restricted access
  { provider: "azure", code: "germanynorth", name: "Germany North", city: "Berlin", country: "DE", latitude: 52.52, longitude: 13.4 }, // restricted access
  { provider: "azure", code: "germanywestcentral", name: "Germany West Central", city: "Frankfurt", country: "DE", latitude: 50.11, longitude: 8.68 },
  { provider: "azure", code: "indiasouthcentral", name: "India South Central", city: "Hyderabad", country: "IN", latitude: 17.39, longitude: 78.49 },
  { provider: "azure", code: "indonesiacentral", name: "Indonesia Central", city: "Jakarta", country: "ID", latitude: -6.21, longitude: 106.85 },
  { provider: "azure", code: "israelcentral", name: "Israel Central", city: "Tel Aviv", country: "IL", latitude: 32.09, longitude: 34.78 }, // provider names only Israel
  { provider: "azure", code: "italynorth", name: "Italy North", city: "Milan", country: "IT", latitude: 45.46, longitude: 9.19 },
  { provider: "azure", code: "japaneast", name: "Japan East", city: "Tokyo", country: "JP", latitude: 35.68, longitude: 139.65 }, // provider names Tokyo, Saitama
  { provider: "azure", code: "japanwest", name: "Japan West", city: "Osaka", country: "JP", latitude: 34.69, longitude: 135.5 },
  { provider: "azure", code: "koreacentral", name: "Korea Central", city: "Seoul", country: "KR", latitude: 37.57, longitude: 126.98 },
  { provider: "azure", code: "koreasouth", name: "Korea South", city: "Busan", country: "KR", latitude: 35.18, longitude: 129.08 },
  { provider: "azure", code: "malaysiawest", name: "Malaysia West", city: "Kuala Lumpur", country: "MY", latitude: 3.14, longitude: 101.69 },
  { provider: "azure", code: "mexicocentral", name: "Mexico Central", city: "Querétaro", country: "MX", latitude: 20.59, longitude: -100.39 }, // provider names only Querétaro State
  { provider: "azure", code: "newzealandnorth", name: "New Zealand North", city: "Auckland", country: "NZ", latitude: -36.85, longitude: 174.76 },
  { provider: "azure", code: "northcentralus", name: "North Central US", city: "Chicago", country: "US", latitude: 41.88, longitude: -87.63 }, // provider names only Illinois
  { provider: "azure", code: "northeurope", name: "North Europe", city: "Dublin", country: "IE", latitude: 53.35, longitude: -6.26 }, // provider names only Ireland
  { provider: "azure", code: "norwayeast", name: "Norway East", city: "Oslo", country: "NO", latitude: 59.91, longitude: 10.75 }, // provider names only Norway
  { provider: "azure", code: "norwaywest", name: "Norway West", city: "Stavanger", country: "NO", latitude: 58.97, longitude: 5.73 }, // provider names only Norway; restricted access
  { provider: "azure", code: "polandcentral", name: "Poland Central", city: "Warsaw", country: "PL", latitude: 52.23, longitude: 21.01 },
  { provider: "azure", code: "qatarcentral", name: "Qatar Central", city: "Doha", country: "QA", latitude: 25.29, longitude: 51.53 },
  { provider: "azure", code: "southafricanorth", name: "South Africa North", city: "Johannesburg", country: "ZA", latitude: -26.2, longitude: 28.05 },
  { provider: "azure", code: "southafricawest", name: "South Africa West", city: "Cape Town", country: "ZA", latitude: -33.92, longitude: 18.42 }, // restricted access
  { provider: "azure", code: "southcentralus", name: "South Central US", city: "San Antonio", country: "US", latitude: 29.42, longitude: -98.49 }, // provider names only Texas
  { provider: "azure", code: "southeastasia", name: "Southeast Asia", city: "Singapore", country: "SG", latitude: 1.29, longitude: 103.85 },
  { provider: "azure", code: "southindia", name: "South India", city: "Chennai", country: "IN", latitude: 13.08, longitude: 80.27 },
  { provider: "azure", code: "spaincentral", name: "Spain Central", city: "Madrid", country: "ES", latitude: 40.42, longitude: -3.7 },
  { provider: "azure", code: "swedencentral", name: "Sweden Central", city: "Gävle", country: "SE", latitude: 60.67, longitude: 17.14 },
  { provider: "azure", code: "switzerlandnorth", name: "Switzerland North", city: "Zurich", country: "CH", latitude: 47.38, longitude: 8.54 },
  { provider: "azure", code: "switzerlandwest", name: "Switzerland West", city: "Geneva", country: "CH", latitude: 46.2, longitude: 6.14 }, // restricted access
  { provider: "azure", code: "uaecentral", name: "UAE Central", city: "Abu Dhabi", country: "AE", latitude: 24.45, longitude: 54.38 }, // restricted access
  { provider: "azure", code: "uaenorth", name: "UAE North", city: "Dubai", country: "AE", latitude: 25.2, longitude: 55.27 },
  { provider: "azure", code: "uksouth", name: "UK South", city: "London", country: "GB", latitude: 51.51, longitude: -0.13 },
  { provider: "azure", code: "ukwest", name: "UK West", city: "Cardiff", country: "GB", latitude: 51.48, longitude: -3.18 },
  { provider: "azure", code: "westcentralus", name: "West Central US", city: "Cheyenne", country: "US", latitude: 41.14, longitude: -104.82 }, // provider names only Wyoming
  { provider: "azure", code: "westeurope", name: "West Europe", city: "Amsterdam", country: "NL", latitude: 52.37, longitude: 4.9 }, // provider names only Netherlands
  { provider: "azure", code: "westindia", name: "West India", city: "Mumbai", country: "IN", latitude: 19.08, longitude: 72.88 },
  { provider: "azure", code: "westus", name: "West US", city: "San Francisco", country: "US", latitude: 37.77, longitude: -122.42 }, // provider names only California
  { provider: "azure", code: "westus2", name: "West US 2", city: "Quincy", country: "US", latitude: 47.23, longitude: -119.85 }, // provider names only Washington
  { provider: "azure", code: "westus3", name: "West US 3", city: "Phoenix", country: "US", latitude: 33.45, longitude: -112.07 }
] as const satisfies readonly CuratedRegion[];

/**
 * Cloudflare data centre codes that OurAirports does not list for an open
 * airport (a closed airport such as Berlin Tegel, a renamed code, or no
 * airport at all). City centres, rounded to 0.01°.
 */
export interface CuratedPlace {
  code: string;
  country: string;
  latitude: number;
  longitude: number;
}

export const CLOUDFLARE_PLACES = [
  { code: "FRU", country: "KG", latitude: 42.87, longitude: 74.59 }, // Bishkek
  { code: "JXG", country: "CN", latitude: 30.75, longitude: 120.76 }, // Jiaxing
  { code: "KIV", country: "MD", latitude: 47.01, longitude: 28.86 }, // Chișinău
  { code: "QWJ", country: "BR", latitude: -22.74, longitude: -47.33 }, // Americana
  { code: "TXL", country: "DE", latitude: 52.52, longitude: 13.4 }, // Berlin
  { code: "ZDM", country: "PS", latitude: 31.9, longitude: 35.2 } // Ramallah
] as const satisfies readonly CuratedPlace[];
