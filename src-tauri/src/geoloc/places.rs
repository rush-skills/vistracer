//! Places that router host names refer to.
//!
//! `data/airports.csv` is trimmed from OurAirports (public domain, see
//! `data/README.md`). The curated tables below map metro codes, city names
//! and 6-letter city codes seen in public carrier host names to the
//! airport whose coordinates stand in for the city. They are hand-written
//! facts, not copied from a licensed database.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const AIRPORTS_CSV: &str = include_str!("../../data/airports.csv");

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Airport {
    pub iata: &'static str,
    pub latitude: f64,
    pub longitude: f64,
    pub country: &'static str,
    pub large: bool,
    pub municipality: &'static str,
}

static AIRPORTS: LazyLock<HashMap<&'static str, Airport>> = LazyLock::new(|| {
    AIRPORTS_CSV
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, ',');
            let iata = fields.next()?;
            let latitude = fields.next()?.parse().ok()?;
            let longitude = fields.next()?.parse().ok()?;
            let country = fields.next()?;
            let large = fields.next()? == "L";
            let municipality = fields.next().unwrap_or_default();
            Some((
                iata,
                Airport {
                    iata,
                    latitude,
                    longitude,
                    country,
                    large,
                    municipality,
                },
            ))
        })
        .collect()
});

static COUNTRIES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| AIRPORTS.values().map(|a| a.country).collect());

/// Looks up a 3-letter IATA airport code, case-insensitively.
pub fn airport(code: &str) -> Option<&'static Airport> {
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    AIRPORTS.get(code.to_ascii_uppercase().as_str())
}

/// True for an ISO 3166-1 alpha-2 code (upper case) of a country that has
/// an airport in the table.
pub fn is_country(code: &str) -> bool {
    COUNTRIES.contains(code)
}

pub fn is_us_state(code: &str) -> bool {
    US_STATES.contains(&code)
}

/// A city named by a curated code; `iata` gives the coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamedPlace {
    pub label: &'static str,
    pub iata: &'static str,
}

const fn place(label: &'static str, iata: &'static str) -> NamedPlace {
    NamedPlace { label, iata }
}

pub fn lookup(table: &[(&str, NamedPlace)], key: &str) -> Option<NamedPlace> {
    table
        .iter()
        .find(|(code, _)| *code == key)
        .map(|(_, place)| *place)
}

/// IATA metropolitan area codes: they name a city, not an airport.
pub static METRO_CODES: &[(&str, NamedPlace)] = &[
    ("lon", place("London", "LCY")),
    ("par", place("Paris", "ORY")),
    ("nyc", place("New York", "LGA")),
    ("chi", place("Chicago", "MDW")),
    ("was", place("Washington", "DCA")),
    ("mil", place("Milan", "LIN")),
    ("sto", place("Stockholm", "BMA")),
    ("tyo", place("Tokyo", "HND")),
    ("osa", place("Osaka", "ITM")),
    ("rom", place("Rome", "CIA")),
    ("mow", place("Moscow", "SVO")),
    ("bue", place("Buenos Aires", "AEP")),
    ("rio", place("Rio de Janeiro", "SDU")),
    ("sao", place("São Paulo", "CGH")),
    ("yto", place("Toronto", "YTZ")),
    ("ymq", place("Montreal", "YUL")),
    ("bjs", place("Beijing", "PEK")),
    ("sel", place("Seoul", "GMP")),
    ("jkt", place("Jakarta", "HLP")),
    ("buh", place("Bucharest", "OTP")),
    ("dtt", place("Detroit", "DTW")),
    ("yea", place("Edmonton", "YEG")),
];

/// Full city names, lower case without spaces, as carriers write them
/// (`Frankfurt1`, `fr0-frankfurt`, `ashburn.va`). Only cities whose name
/// is unambiguous among network hubs.
pub static CITY_NAMES: &[(&str, NamedPlace)] = &[
    ("amsterdam", place("Amsterdam", "AMS")),
    ("ashburn", place("Ashburn", "IAD")),
    ("athens", place("Athens", "ATH")),
    ("atlanta", place("Atlanta", "ATL")),
    ("auckland", place("Auckland", "AKL")),
    ("bangalore", place("Bengaluru", "BLR")),
    ("bangkok", place("Bangkok", "DMK")),
    ("barcelona", place("Barcelona", "BCN")),
    ("beijing", place("Beijing", "PEK")),
    ("bengaluru", place("Bengaluru", "BLR")),
    ("berlin", place("Berlin", "BER")),
    ("bogota", place("Bogotá", "BOG")),
    ("boston", place("Boston", "BOS")),
    ("brussels", place("Brussels", "BRU")),
    ("bucharest", place("Bucharest", "OTP")),
    ("budapest", place("Budapest", "BUD")),
    ("buenosaires", place("Buenos Aires", "AEP")),
    ("cairo", place("Cairo", "CAI")),
    ("capetown", place("Cape Town", "CPT")),
    ("charlotte", place("Charlotte", "CLT")),
    ("chennai", place("Chennai", "MAA")),
    ("chicago", place("Chicago", "MDW")),
    ("cleveland", place("Cleveland", "CLE")),
    ("copenhagen", place("Copenhagen", "CPH")),
    ("dallas", place("Dallas", "DAL")),
    ("delhi", place("Delhi", "DEL")),
    ("denver", place("Denver", "DEN")),
    ("detroit", place("Detroit", "DTW")),
    ("doha", place("Doha", "DOH")),
    ("dubai", place("Dubai", "DXB")),
    ("dublin", place("Dublin", "DUB")),
    ("dusseldorf", place("Düsseldorf", "DUS")),
    ("frankfurt", place("Frankfurt", "FRA")),
    ("fremont", place("Fremont", "SJC")),
    ("fujairah", place("Fujairah", "FJR")),
    ("geneva", place("Geneva", "GVA")),
    ("guangzhou", place("Guangzhou", "CAN")),
    ("hamburg", place("Hamburg", "HAM")),
    ("helsinki", place("Helsinki", "HEL")),
    ("hongkong", place("Hong Kong", "HKG")),
    ("houston", place("Houston", "HOU")),
    ("hyderabad", place("Hyderabad", "HYD")),
    ("istanbul", place("Istanbul", "IST")),
    ("jakarta", place("Jakarta", "HLP")),
    ("johannesburg", place("Johannesburg", "JNB")),
    ("kansascity", place("Kansas City", "MCI")),
    ("kolkata", place("Kolkata", "CCU")),
    ("kualalumpur", place("Kuala Lumpur", "SZB")),
    ("lagos", place("Lagos", "LOS")),
    ("lasvegas", place("Las Vegas", "LAS")),
    ("lisbon", place("Lisbon", "LIS")),
    ("london", place("London", "LCY")),
    ("losangeles", place("Los Angeles", "LAX")),
    ("madrid", place("Madrid", "MAD")),
    ("manila", place("Manila", "MNL")),
    ("marseille", place("Marseille", "MRS")),
    ("melbourne", place("Melbourne", "MEL")),
    ("miami", place("Miami", "MIA")),
    ("milan", place("Milan", "LIN")),
    ("minneapolis", place("Minneapolis", "MSP")),
    ("montreal", place("Montreal", "YUL")),
    ("moscow", place("Moscow", "SVO")),
    ("mumbai", place("Mumbai", "BOM")),
    ("munich", place("Munich", "MUC")),
    ("nairobi", place("Nairobi", "NBO")),
    ("newark", place("Newark", "EWR")),
    ("newdelhi", place("New Delhi", "DEL")),
    ("newyork", place("New York", "LGA")),
    ("osaka", place("Osaka", "ITM")),
    ("oslo", place("Oslo", "OSL")),
    ("paloalto", place("Palo Alto", "SJC")),
    ("paris", place("Paris", "ORY")),
    ("philadelphia", place("Philadelphia", "PHL")),
    ("phoenix", place("Phoenix", "PHX")),
    ("pittsburgh", place("Pittsburgh", "PIT")),
    ("prague", place("Prague", "PRG")),
    ("riodejaneiro", place("Rio de Janeiro", "SDU")),
    ("riyadh", place("Riyadh", "RUH")),
    ("saltlakecity", place("Salt Lake City", "SLC")),
    ("sandiego", place("San Diego", "SAN")),
    ("sanfrancisco", place("San Francisco", "SFO")),
    ("sanjose", place("San Jose", "SJC")),
    ("santaclara", place("Santa Clara", "SJC")),
    ("saopaulo", place("São Paulo", "CGH")),
    ("seattle", place("Seattle", "SEA")),
    ("secaucus", place("Secaucus", "EWR")),
    ("seoul", place("Seoul", "GMP")),
    ("shanghai", place("Shanghai", "SHA")),
    ("shenzhen", place("Shenzhen", "SZX")),
    ("singapore", place("Singapore", "SIN")),
    ("sofia", place("Sofia", "SOF")),
    ("stockholm", place("Stockholm", "BMA")),
    ("stlouis", place("St. Louis", "STL")),
    ("sunnyvale", place("Sunnyvale", "SJC")),
    ("sydney", place("Sydney", "SYD")),
    ("taipei", place("Taipei", "TSA")),
    ("tampa", place("Tampa", "TPA")),
    ("telaviv", place("Tel Aviv", "TLV")),
    ("tokyo", place("Tokyo", "HND")),
    ("toronto", place("Toronto", "YTZ")),
    ("vancouver", place("Vancouver", "YVR")),
    ("vienna", place("Vienna", "VIE")),
    ("warsaw", place("Warsaw", "WAW")),
    ("washington", place("Washington", "DCA")),
    ("zurich", place("Zurich", "ZRH")),
];

/// 6-letter city and region codes (4 letters city, 2 letters state or
/// country) used by NTT and Verizon, e.g. `lsanca07.us`.
pub static CITY_REGION_CODES: &[(&str, NamedPlace)] = &[
    ("amstnl", place("Amsterdam", "AMS")),
    ("asbnva", place("Ashburn", "IAD")),
    ("atlnga", place("Atlanta", "ATL")),
    ("bstnma", place("Boston", "BOS")),
    ("chcgil", place("Chicago", "MDW")),
    ("dllstx", place("Dallas", "DAL")),
    ("dnvrco", place("Denver", "DEN")),
    ("frnkge", place("Frankfurt", "FRA")),
    ("hstntx", place("Houston", "HOU")),
    ("londen", place("London", "LCY")),
    ("lsanca", place("Los Angeles", "LAX")),
    ("mdrdsp", place("Madrid", "MAD")),
    ("miamfl", place("Miami", "MIA")),
    ("mlanit", place("Milan", "LIN")),
    ("nycmny", place("New York", "LGA")),
    ("osakjp", place("Osaka", "ITM")),
    ("parsfr", place("Paris", "ORY")),
    ("phnxaz", place("Phoenix", "PHX")),
    ("plalca", place("Palo Alto", "SJC")),
    ("sngpsi", place("Singapore", "SIN")),
    ("snjsca", place("San Jose", "SJC")),
    ("sttlwa", place("Seattle", "SEA")),
    ("tokyjp", place("Tokyo", "HND")),
    ("washdc", place("Washington", "DCA")),
];

const US_STATES: &[&str] = &[
    "al", "ak", "az", "ar", "ca", "co", "ct", "dc", "de", "fl", "ga", "hi", "id", "il", "in", "ia",
    "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm",
    "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa",
    "wv", "wi", "wy",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn airport_table_loads_and_looks_up_case_insensitively() {
        assert!(AIRPORTS.len() > 3000, "{}", AIRPORTS.len());
        let fra = airport("fra").unwrap();
        assert_eq!(fra.country, "DE");
        assert!(fra.large);
        assert!((fra.latitude - 50.03).abs() < 0.05 && (fra.longitude - 8.57).abs() < 0.05);
        assert_eq!(airport("FRA"), Some(fra));
        assert_eq!(airport("zz"), None);
        assert_eq!(airport("f4a"), None);
        assert!(is_country("DE") && is_country("IN") && !is_country("XX"));
        assert!(is_us_state("va") && !is_us_state("uk"));
    }

    #[test]
    fn every_curated_place_resolves_to_a_bundled_airport() {
        for table in [METRO_CODES, CITY_NAMES, CITY_REGION_CODES] {
            for (code, place) in table {
                assert!(
                    airport(place.iata).is_some(),
                    "{code} -> {} is not in airports.csv",
                    place.iata
                );
                assert_eq!(*code, code.to_ascii_lowercase());
            }
        }
        for (code, _) in CITY_REGION_CODES {
            assert_eq!(code.len(), 6, "{code}");
        }
    }
}
