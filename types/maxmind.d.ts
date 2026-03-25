declare module "maxmind" {
  export interface CityNames {
    en?: string;
    [key: string]: string | undefined;
  }

  export interface CountryRecord {
    names?: CityNames;
    iso_code?: string;
  }

  export interface CityRecord {
    names?: CityNames;
  }

  export interface LocationRecord {
    latitude?: number;
    longitude?: number;
    accuracy_radius?: number;
  }

  export interface CityResponse {
    city?: CityRecord;
    country?: CountryRecord;
    location?: LocationRecord;
  }

  export interface AsnResponse {
    autonomous_system_number?: number;
    autonomous_system_organization?: string;
    network?: string;
  }

  export interface Reader<T> {
    get(address: string): T | null;
    close(): void;
  }

  export function open<T>(path: string): Promise<Reader<T>>;

  const maxmind: {
    open: typeof open;
  };

  export default maxmind;
}
