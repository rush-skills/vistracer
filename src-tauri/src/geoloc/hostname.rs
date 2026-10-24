//! Location hints in router reverse-DNS names.
//!
//! Carriers name routers after the city they sit in: NTT `lsanca07`,
//! Cogent `fra03`, Arelion `ffm-bb2`, Lumen `Frankfurt1`. A token only
//! counts when it is a whole label or a whole `-` piece of a label, with at
//! most a site number after it. Tokens that routers use for roles or
//! interfaces (`ccr41`, `agg1`, `cgn`, `pos`) are never read as places even
//! when they are also airport codes. Known carrier domains raise the
//! confidence of the scheme that carrier uses. A bare 3-letter token, or a
//! code of a small airport outside a known carrier's names, is only kept
//! when another source agrees on the country. Two different places at the
//! same confidence cancel out.

use super::places::{self, Airport, NamedPlace, CITY_NAMES, CITY_REGION_CODES, METRO_CODES};
use crate::types::{HintRule, HostnameHint, LocationConfidence};

/// Routers of a metro are within about this distance of the airport that
/// stands in for the city.
pub const HINT_RADIUS_KM: f64 = 50.0;

#[derive(Debug, Clone, Copy, Default)]
struct Trust {
    airport: bool,
    city_region: bool,
    city_name: bool,
}

struct Carrier {
    name: &'static str,
    suffixes: &'static [&'static str],
    codes: &'static [(&'static str, NamedPlace)],
    trust: Trust,
    /// Google service names: `bom07s29-in-f14.1e100.net`.
    google_style: bool,
}

const fn named(label: &'static str, iata: &'static str) -> NamedPlace {
    NamedPlace { label, iata }
}

/// Arelion (formerly Telia Carrier): `ffm-bb2-link.ip.twelve99.net`.
static ARELION_CODES: &[(&str, NamedPlace)] = &[
    ("adm", named("Amsterdam", "AMS")),
    ("ash", named("Ashburn", "IAD")),
    ("atl", named("Atlanta", "ATL")),
    ("chi", named("Chicago", "MDW")),
    ("dls", named("Dallas", "DAL")),
    ("ffm", named("Frankfurt", "FRA")),
    ("hbg", named("Hamburg", "HAM")),
    ("hls", named("Helsinki", "HEL")),
    ("kbn", named("Copenhagen", "CPH")),
    ("las", named("Los Angeles", "LAX")),
    ("ldn", named("London", "LCY")),
    ("mad", named("Madrid", "MAD")),
    ("mai", named("Miami", "MIA")),
    ("mil", named("Milan", "LIN")),
    ("nyk", named("New York", "LGA")),
    ("osl", named("Oslo", "OSL")),
    ("prs", named("Paris", "ORY")),
    ("s", named("Stockholm", "BMA")),
    ("sea", named("Seattle", "SEA")),
    ("sjo", named("San Jose", "SJC")),
    ("vie", named("Vienna", "VIE")),
    ("war", named("Warsaw", "WAW")),
];

/// Hurricane Electric site codes that are not IATA codes: `core2.fmt2.he.net`.
static HE_CODES: &[(&str, NamedPlace)] = &[
    ("ash", named("Ashburn", "IAD")),
    ("fmt", named("Fremont", "SJC")),
    ("pao", named("Palo Alto", "SJC")),
    ("tor", named("Toronto", "YTZ")),
];

const NONE: Trust = Trust {
    airport: false,
    city_region: false,
    city_name: false,
};
const AIRPORT: Trust = Trust {
    airport: true,
    city_region: false,
    city_name: false,
};
const CITY_NAME: Trust = Trust {
    airport: false,
    city_region: false,
    city_name: true,
};

static CARRIERS: &[Carrier] = &[
    Carrier {
        name: "Arelion",
        suffixes: &["twelve99.net", "telia.net"],
        codes: ARELION_CODES,
        trust: NONE,
        google_style: false,
    },
    Carrier {
        name: "Hurricane Electric",
        suffixes: &["he.net"],
        codes: HE_CODES,
        trust: AIRPORT,
        google_style: false,
    },
    Carrier {
        name: "NTT",
        suffixes: &["gin.ntt.net"],
        codes: &[],
        trust: Trust {
            airport: false,
            city_region: true,
            city_name: false,
        },
        google_style: false,
    },
    Carrier {
        name: "Cogent",
        suffixes: &["cogentco.com"],
        codes: &[],
        trust: AIRPORT,
        google_style: false,
    },
    Carrier {
        name: "Zayo",
        suffixes: &["zayo.com"],
        codes: &[],
        trust: AIRPORT,
        google_style: false,
    },
    Carrier {
        name: "GTT",
        suffixes: &["gtt.net"],
        codes: &[],
        trust: AIRPORT,
        google_style: false,
    },
    Carrier {
        name: "Verizon",
        suffixes: &["alter.net", "verizon.net"],
        codes: &[],
        trust: Trust {
            airport: true,
            city_region: true,
            city_name: false,
        },
        google_style: false,
    },
    Carrier {
        name: "Lumen",
        suffixes: &["level3.net", "lumen.tech"],
        codes: &[],
        trust: CITY_NAME,
        google_style: false,
    },
    Carrier {
        name: "Tata",
        suffixes: &["as6453.net"],
        codes: &[],
        trust: CITY_NAME,
        google_style: false,
    },
    Carrier {
        name: "Comcast",
        suffixes: &["comcast.net"],
        codes: &[],
        trust: CITY_NAME,
        google_style: false,
    },
    Carrier {
        name: "Google",
        suffixes: &["1e100.net"],
        codes: &[],
        trust: NONE,
        google_style: true,
    },
];

/// Router roles, interface names and host-name words that collide with
/// IATA codes (`ccr` = Concord, `cgn` = Cologne, `man` = Manchester,
/// `sat` = San Antonio). Generic rules never read these as places.
const STOPWORDS: &[&str] = &[
    "acc", "acx", "agg", "agr", "api", "app", "asr", "asw", "atm", "bar", "bbn", "bbr", "bdr",
    "bgp", "bng", "brs", "bsr", "bvi", "cab", "car", "cat", "ccr", "cdn", "cgn", "cmt", "com",
    "cor", "cpe", "crs", "csw", "dev", "dmz", "dns", "doc", "dsl", "dsw", "dyn", "ear", "edu",
    "eth", "ext", "fix", "ftp", "gig", "gin", "gov", "gwy", "hfc", "hsd", "hub", "idr", "ilo",
    "int", "ipt", "irb", "isp", "ixp", "ixs", "lab", "lag", "lan", "lnk", "lte", "man", "mgm",
    "mgt", "mob", "mpd", "msr", "nap", "nat", "net", "noc", "nyk", "olt", "one", "ont", "oob",
    "ops", "org", "pon", "pop", "pos", "ppp", "prd", "pri", "ptr", "pub", "rcr", "reg", "res",
    "rgn", "rtr", "sat", "sec", "ser", "srv", "srx", "stc", "stg", "sub", "svc", "ten", "the",
    "tst", "tun", "uat", "vpn", "vps", "vrf", "wan", "web", "wls", "www",
];

const GENERIC_TLDS: &[&str] = &[
    "arpa", "biz", "cloud", "com", "edu", "google", "gov", "host", "info", "int", "io", "link",
    "mil", "net", "network", "online", "org", "services", "systems", "tech", "telecom",
];
/// Second-level labels under country TLDs that are part of the
/// registered domain (`com.mx`, `co.uk`, `ne.jp`).
const SECOND_LEVEL: &[&str] = &[
    "ac", "ad", "co", "com", "edu", "gob", "gov", "ne", "net", "nic", "or", "org",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Hint {
    pub info: HostnameHint,
    pub latitude: f64,
    pub longitude: f64,
    pub country: &'static str,
    pub confidence: LocationConfidence,
}

struct Match {
    found: Found,
    token: String,
    country_agrees: bool,
}

/// Number of trailing labels that belong to the registered domain and are
/// not scanned. Unknown TLDs (`lon10.core`) scan every label.
fn registrable_len(labels: &[&str]) -> usize {
    let Some(tld) = labels.last() else {
        return 0;
    };
    let country_tld = tld.len() == 2 && tld.bytes().all(|b| b.is_ascii_alphabetic());
    if !country_tld && !GENERIC_TLDS.contains(tld) {
        return 0;
    }
    if country_tld && labels.len() >= 3 && SECOND_LEVEL.contains(&labels[labels.len() - 2]) {
        3
    } else {
        labels.len().min(2)
    }
}

/// Leading letters and a site number: `fra03` -> (`fra`, `03`).
fn letters_and_number(piece: &str) -> Option<(&str, &str)> {
    let split = piece
        .find(|c: char| !c.is_ascii_lowercase())
        .unwrap_or(piece.len());
    let (letters, rest) = piece.split_at(split);
    (!letters.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())).then_some((letters, rest))
}

/// `bom07s29` -> `bom`.
fn google_site(piece: &str) -> Option<&str> {
    let bytes = piece.as_bytes();
    let shape = bytes.len() >= 7
        && bytes[..3].iter().all(u8::is_ascii_lowercase)
        && bytes[3..5].iter().all(u8::is_ascii_digit)
        && bytes[5] == b's'
        && bytes[6..].iter().all(u8::is_ascii_digit);
    shape.then(|| &piece[..3])
}

fn city_label(airport: &Airport) -> String {
    let city = airport
        .municipality
        .split(['(', ','])
        .next()
        .unwrap_or_default()
        .trim();
    let city = if city.is_empty() { airport.iata } else { city };
    format!("{city}, {}", airport.country)
}

fn named_place(place: NamedPlace) -> Option<(&'static Airport, String)> {
    let airport = places::airport(place.iata)?;
    Some((airport, format!("{}, {}", place.label, airport.country)))
}

enum CountryLabel {
    Agrees,
    Disagrees,
    Unknown,
}

/// A 2-letter label right after the location token: a country (`.de`,
/// `.uk`) or a US state (`.va`).
fn country_label(next: Option<&&str>, airport: &Airport) -> CountryLabel {
    let Some(label) = next.filter(|l| l.len() == 2) else {
        return CountryLabel::Unknown;
    };
    let code = if *label == "uk" {
        "GB".to_string()
    } else {
        label.to_ascii_uppercase()
    };
    let state = airport.country == "US" && places::is_us_state(label);
    if code == airport.country || state {
        CountryLabel::Agrees
    } else if places::is_country(&code) {
        CountryLabel::Disagrees
    } else {
        CountryLabel::Unknown
    }
}

fn raise(confidence: LocationConfidence, trusted: bool) -> LocationConfidence {
    if trusted {
        LocationConfidence::High
    } else {
        confidence
    }
}

/// A place that one piece of a host name names.
struct Found {
    airport: &'static Airport,
    place: String,
    rule: HintRule,
    confidence: LocationConfidence,
    /// Kept only when another source agrees on the country.
    needs_country: bool,
}

impl Found {
    fn new(
        (airport, place): (&'static Airport, String),
        rule: HintRule,
        confidence: LocationConfidence,
    ) -> Self {
        Self {
            airport,
            place,
            rule,
            confidence,
            needs_country: false,
        }
    }
}

fn piece_matches(piece: &str, carrier: Option<&Carrier>) -> Vec<Found> {
    let mut found = Vec::new();
    let trust = carrier.map(|c| c.trust).unwrap_or_default();

    if let Some(code) = carrier
        .filter(|c| c.google_style)
        .and_then(|_| google_site(piece))
    {
        if let Some(airport) = places::airport(code) {
            found.push(Found::new(
                (airport, city_label(airport)),
                HintRule::CarrierCode,
                LocationConfidence::High,
            ));
        }
        return found;
    }
    let Some((letters, number)) = letters_and_number(piece) else {
        return found;
    };
    if let Some(place) = carrier.and_then(|c| places::lookup(c.codes, letters)) {
        if let Some(resolved) = named_place(place) {
            found.push(Found::new(
                resolved,
                HintRule::CarrierCode,
                LocationConfidence::High,
            ));
            return found;
        }
    }
    if letters.len() == 6 {
        if let Some(resolved) = places::lookup(CITY_REGION_CODES, letters).and_then(named_place) {
            let confidence = raise(LocationConfidence::Medium, trust.city_region);
            found.push(Found::new(resolved, HintRule::CityRegionCode, confidence));
        }
    }
    if letters.len() >= 5 {
        if let Some(resolved) = places::lookup(CITY_NAMES, letters).and_then(named_place) {
            let confidence = raise(LocationConfidence::Medium, trust.city_name);
            found.push(Found::new(resolved, HintRule::CityName, confidence));
        }
    }
    if letters.len() == 3 && !STOPWORDS.contains(&letters) {
        let metro = places::lookup(METRO_CODES, letters).and_then(named_place);
        let is_metro = metro.is_some();
        let resolved = metro.or_else(|| places::airport(letters).map(|a| (a, city_label(a))));
        if let Some(resolved) = resolved {
            let large = is_metro || resolved.0.large;
            if (1..=3).contains(&number.len()) {
                let confidence = raise(LocationConfidence::Medium, trust.airport);
                let mut hit = Found::new(resolved, HintRule::AirportCode, confidence);
                // Small-city airport codes collide with site codes
                // (Tele2 `avk1` is not Arvaikheer, Mongolia).
                hit.needs_country = !large && !trust.airport;
                found.push(hit);
            } else if number.is_empty() && large {
                let mut hit =
                    Found::new(resolved, HintRule::BareAirportCode, LocationConfidence::Low);
                hit.needs_country = true;
                found.push(hit);
            }
        }
    }
    found
}

/// Reads a location from a reverse-DNS name. `context_country` is the ISO
/// country another source gives for the address (GeoLite2 or the
/// registry); bare 3-letter codes need it to agree.
pub fn hostname_hint(host_name: &str, context_country: Option<&str>) -> Option<Hint> {
    let host = host_name.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty()) {
        return None;
    }
    let carrier = CARRIERS.iter().find(|c| {
        c.suffixes
            .iter()
            .any(|s| host == *s || host.ends_with(&format!(".{s}")))
    });
    let scanned = labels.len() - registrable_len(&labels);

    let mut matches: Vec<Match> = Vec::new();
    for (index, label) in labels[..scanned].iter().enumerate() {
        for piece in label.split('-') {
            for mut found in piece_matches(piece, carrier) {
                let country_agrees = match country_label(labels.get(index + 1), found.airport) {
                    CountryLabel::Disagrees => continue,
                    CountryLabel::Agrees => true,
                    CountryLabel::Unknown => false,
                };
                if country_agrees && found.confidence == LocationConfidence::Medium {
                    found.confidence = LocationConfidence::High;
                }
                matches.push(Match {
                    found,
                    token: piece.to_string(),
                    country_agrees,
                });
            }
        }
    }

    let context = context_country.map(str::to_ascii_uppercase);
    matches.retain(|m| {
        !m.found.needs_country
            || m.country_agrees
            || context.as_deref() == Some(m.found.airport.country)
    });
    let top = matches.iter().map(|m| m.found.confidence).max()?;
    let mut best = matches.into_iter().filter(|m| m.found.confidence == top);
    let chosen = best.next()?;
    if best.any(|other| other.found.airport.iata != chosen.found.airport.iata) {
        return None;
    }
    let Match { found, token, .. } = chosen;
    Some(Hint {
        latitude: found.airport.latitude,
        longitude: found.airport.longitude,
        country: found.airport.country,
        confidence: found.confidence,
        info: HostnameHint {
            host_name: host_name.to_string(),
            token,
            rule: found.rule,
            carrier: carrier.map(|c| c.name.to_string()),
            iata: found.airport.iata.to_string(),
            place: found.place,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../fixtures/hostnames/hints.txt");

    fn rule_name(rule: HintRule) -> String {
        serde_json::to_value(rule)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    fn confidence_name(confidence: LocationConfidence) -> String {
        serde_json::to_value(confidence)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Each fixture line: `host | context country or - | IATA rule confidence, or -`.
    #[test]
    fn real_world_host_names_match_the_fixture_list() {
        let mut checked = 0;
        let mut failures = Vec::new();
        for line in FIXTURES.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split('|').map(str::trim).collect();
            assert_eq!(fields.len(), 3, "bad fixture line: {line}");
            let context = (fields[1] != "-").then_some(fields[1]);
            let got = hostname_hint(fields[0], context)
                .map(|h| {
                    format!(
                        "{} {} {}",
                        h.info.iata,
                        rule_name(h.info.rule),
                        confidence_name(h.confidence)
                    )
                })
                .unwrap_or_else(|| "-".to_string());
            if got != fields[2] {
                failures.push(format!("{}: expected {}, got {got}", fields[0], fields[2]));
            }
            checked += 1;
        }
        assert!(checked >= 40, "only {checked} fixtures");
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn hint_carries_token_place_and_carrier() {
        let hint = hostname_hint("be3187.ccr41.fra03.atlas.cogentco.com.", None).unwrap();
        assert_eq!(hint.info.token, "fra03");
        assert_eq!(hint.info.carrier.as_deref(), Some("Cogent"));
        assert_eq!(hint.info.place, "Frankfurt am Main, DE");
        assert_eq!(hint.country, "DE");
        assert_eq!(
            hint.info.host_name,
            "be3187.ccr41.fra03.atlas.cogentco.com."
        );

        let ntt = hostname_hint("ae-1.r21.lsanca07.us.bb.gin.ntt.net", None).unwrap();
        assert_eq!(ntt.info.place, "Los Angeles, US");
        assert_eq!(ntt.info.token, "lsanca07");
    }

    #[test]
    fn registrable_domain_is_not_scanned() {
        assert_eq!(registrable_len(&["a", "fra", "example", "net"]), 2);
        assert_eq!(registrable_len(&["a", "prod", "com", "mx"]), 3);
        assert_eq!(registrable_len(&["xe-0", "lon10", "core"]), 0);
        // "sin.net" is the domain, not Singapore.
        assert_eq!(hostname_hint("gw1.sin.net", None), None);
    }
}
