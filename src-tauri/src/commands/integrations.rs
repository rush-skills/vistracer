use crate::commands::persistence::{IntegrationSettings, SharedStore};
use crate::types::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct EnrichmentResult {
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    pub provider_statuses: Vec<ProviderStatus>,
    pub peering_db: Option<PeeringDbDetails>,
}

fn make_provider_status(provider: &str, status: &str, message: &str) -> ProviderStatus {
    ProviderStatus {
        provider: provider.to_string(),
        status: status.to_string(),
        message: Some(message.to_string()),
        details: None,
    }
}

#[derive(Debug)]
struct TeamCymruResult {
    asn: Option<u32>,
    name: Option<String>,
    prefix: Option<String>,
    country: Option<String>,
    registry: Option<String>,
}

async fn query_team_cymru(ip: &str) -> Result<Option<TeamCymruResult>, String> {
    let ip_str = ip.to_string();
    tokio::task::spawn_blocking(move || {
        let mut stream = TcpStream::connect_timeout(
            &"whois.cymru.com:43".parse().map_err(|e| format!("{}", e))?,
            Duration::from_secs(8),
        )
        .map_err(|e| format!("Team Cymru connection failed: {}", e))?;

        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .ok();

        stream
            .write_all(format!("begin\nverbose\n{}\nend\n", ip_str).as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;

        let reader = BufReader::new(stream);
        let mut data_row: Option<String> = None;

        for line in reader.lines() {
            let line = line.map_err(|e| format!("Read failed: {}", e))?;
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            // Data rows start with a digit followed by pipe
            if trimmed.chars().next().map_or(false, |c| c.is_ascii_digit())
                && trimmed.contains('|')
            {
                data_row = Some(trimmed);
                break;
            }
        }

        match data_row {
            None => Ok(None),
            Some(row) => {
                let parts: Vec<&str> = row.split('|').map(|s| s.trim()).collect();
                if parts.len() < 7 {
                    return Ok(None);
                }
                let asn = parts[0].parse::<u32>().ok();
                let prefix = if parts[2].is_empty() {
                    None
                } else {
                    Some(parts[2].to_string())
                };
                let country = if parts[3].is_empty() {
                    None
                } else {
                    Some(parts[3].to_string())
                };
                let registry = if parts[4].is_empty() {
                    None
                } else {
                    Some(parts[4].to_string())
                };
                let name = if parts.len() > 6 && !parts[6].is_empty() {
                    Some(parts[6].to_string())
                } else {
                    None
                };

                Ok(Some(TeamCymruResult {
                    asn,
                    name,
                    prefix,
                    country,
                    registry,
                }))
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(Debug)]
struct RdapResult {
    name: Option<String>,
    country: Option<String>,
}

async fn query_rdap(ip: &str, base_url: &str) -> Result<Option<RdapResult>, String> {
    let url = format!("{}/{}", base_url.trim_end_matches('/'), ip);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "VisTracer")
        .header("Accept", "application/rdap+json, application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("RDAP request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limited by RDAP service (HTTP 429).".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from RDAP service.", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("RDAP JSON parse failed: {}", e))?;

    Ok(Some(RdapResult {
        name: data["name"].as_str().map(|s| s.to_string()),
        country: data["country"].as_str().map(|s| s.to_string()),
    }))
}

#[derive(Debug)]
struct RipeStatResult {
    asn: Option<u32>,
    holder: Option<String>,
    prefix: Option<String>,
    country: Option<String>,
}

async fn query_ripe_stat(ip: &str, source_app: &str) -> Result<Option<RipeStatResult>, String> {
    let url = format!(
        "https://stat.ripe.net/data/prefix-overview/data.json?resource={}&sourceapp={}",
        ip, source_app
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "VisTracer")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("RIPE Stat request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limited by RIPE Stat (HTTP 429).".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from RIPE Stat.", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("RIPE Stat JSON parse failed: {}", e))?;

    let primary_asn = &data["data"]["asns"][0];

    Ok(Some(RipeStatResult {
        asn: primary_asn["asn"].as_u64().map(|v| v as u32),
        holder: primary_asn["holder"].as_str().map(|s| s.to_string()),
        country: primary_asn["country"].as_str().map(|s| s.to_string()),
        prefix: data["data"]["prefix"].as_str().map(|s| s.to_string()),
    }))
}

async fn query_peeringdb(
    asn: u32,
    api_key: Option<&str>,
) -> Result<Option<PeeringDbDetails>, String> {
    let url = format!("https://www.peeringdb.com/api/net?asn={}", asn);
    let client = reqwest::Client::new();
    let mut req = client
        .get(&url)
        .header("User-Agent", "VisTracer")
        .timeout(Duration::from_secs(10));

    if let Some(key) = api_key {
        req = req.header("X-Api-Key", key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PeeringDB request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limited by PeeringDB (HTTP 429).".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from PeeringDB.", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("PeeringDB JSON parse failed: {}", e))?;

    let entry = &data["data"][0];
    if entry.is_null() {
        return Ok(None);
    }

    Ok(Some(PeeringDbDetails {
        id: entry["id"].as_u64(),
        name: entry["name"].as_str().map(|s| s.to_string()),
        aka: entry["aka"].as_str().map(|s| s.to_string()),
        website: entry["website"].as_str().map(|s| s.to_string()),
        city: entry["city"].as_str().map(|s| s.to_string()),
        country: entry["country"].as_str().map(|s| s.to_string()),
        ix_count: entry["ix_count"].as_u64(),
    }))
}

fn merge_asn(base: Option<&AsnDetails>, addition: &AsnDetails) -> AsnDetails {
    AsnDetails {
        asn: addition.asn.or_else(|| base.and_then(|b| b.asn)),
        name: addition
            .name
            .clone()
            .or_else(|| base.and_then(|b| b.name.clone())),
        network: addition
            .network
            .clone()
            .or_else(|| base.and_then(|b| b.network.clone())),
        country: addition
            .country
            .clone()
            .or_else(|| base.and_then(|b| b.country.clone())),
        registry: addition
            .registry
            .clone()
            .or_else(|| base.and_then(|b| b.registry.clone())),
    }
}

pub async fn enrich_with_external_providers(
    ip: &str,
    seed_geo: Option<&GeoDetails>,
    seed_asn: Option<&AsnDetails>,
    store: &SharedStore,
) -> EnrichmentResult {
    let settings = {
        let guard = store.lock().unwrap();
        guard.integrations.clone()
    };

    let mut statuses: Vec<ProviderStatus> = Vec::new();
    let mut current_geo = seed_geo.cloned();
    let mut current_asn = seed_asn.cloned();
    let mut peering_db_details: Option<PeeringDbDetails> = None;

    // MaxMind status
    if seed_geo.is_some() || seed_asn.is_some() {
        statuses.push(make_provider_status(
            "maxmind",
            "success",
            "Resolved locally via GeoLite2.",
        ));
    } else {
        statuses.push(make_provider_status(
            "maxmind",
            "error",
            "No GeoLite2 match found.",
        ));
    }

    // Team Cymru
    if settings.team_cymru.enabled {
        match query_team_cymru(ip).await {
            Ok(Some(result)) => {
                let addition = AsnDetails {
                    asn: result.asn,
                    name: result.name,
                    network: result.prefix,
                    country: result.country,
                    registry: result.registry,
                };
                current_asn = Some(merge_asn(current_asn.as_ref(), &addition));
                statuses.push(make_provider_status("team-cymru", "success", "Lookup complete."));
            }
            Ok(None) => {
                statuses.push(make_provider_status(
                    "team-cymru",
                    "success",
                    "No data found for this IP.",
                ));
            }
            Err(e) => {
                statuses.push(make_provider_status("team-cymru", "error", &e));
            }
        }
    } else {
        statuses.push(make_provider_status(
            "team-cymru",
            "skipped",
            "Disabled in settings.",
        ));
    }

    // RDAP
    if settings.rdap.enabled {
        let base_url = settings
            .rdap
            .base_url
            .as_deref()
            .unwrap_or("https://rdap.org/ip");
        match query_rdap(ip, base_url).await {
            Ok(Some(result)) => {
                if current_asn.as_ref().and_then(|a| a.name.as_ref()).is_none() {
                    if let Some(name) = result.name {
                        let addition = AsnDetails {
                            asn: None,
                            name: Some(name),
                            network: None,
                            country: None,
                            registry: None,
                        };
                        current_asn = Some(merge_asn(current_asn.as_ref(), &addition));
                    }
                }
                if current_geo.as_ref().and_then(|g| g.country.as_ref()).is_none() {
                    if let Some(country) = result.country {
                        if let Some(ref mut geo) = current_geo {
                            geo.country = Some(country);
                        }
                    }
                }
                statuses.push(make_provider_status("rdap", "success", "Lookup complete."));
            }
            Ok(None) => {
                statuses.push(make_provider_status(
                    "rdap",
                    "success",
                    "No data found for this IP.",
                ));
            }
            Err(e) => {
                statuses.push(make_provider_status("rdap", "error", &e));
            }
        }
    } else {
        statuses.push(make_provider_status(
            "rdap",
            "skipped",
            "Disabled in settings.",
        ));
    }

    // RIPE Stat
    if settings.ripe_stat.enabled {
        let source_app = &settings.ripe_stat.source_app;
        match query_ripe_stat(ip, source_app).await {
            Ok(Some(result)) => {
                let addition = AsnDetails {
                    asn: result.asn,
                    name: result.holder,
                    network: result.prefix,
                    country: result.country,
                    registry: None,
                };
                current_asn = Some(merge_asn(current_asn.as_ref(), &addition));
                statuses.push(make_provider_status("ripe-stat", "success", "Lookup complete."));
            }
            Ok(None) => {
                statuses.push(make_provider_status(
                    "ripe-stat",
                    "success",
                    "No data found for this IP.",
                ));
            }
            Err(e) => {
                statuses.push(make_provider_status("ripe-stat", "error", &e));
            }
        }
    } else {
        statuses.push(make_provider_status(
            "ripe-stat",
            "skipped",
            "Disabled in settings.",
        ));
    }

    // PeeringDB
    if let Some(asn_num) = current_asn.as_ref().and_then(|a| a.asn) {
        if settings.peering_db.enabled {
            let api_key = settings.peering_db.api_key.as_deref();
            match query_peeringdb(asn_num, api_key).await {
                Ok(Some(result)) => {
                    // Merge PeeringDB data into ASN
                    if current_asn.as_ref().and_then(|a| a.name.as_ref()).is_none() {
                        if let Some(ref name) = result.name {
                            let addition = AsnDetails {
                                asn: None,
                                name: Some(name.clone()),
                                network: None,
                                country: result.country.clone(),
                                registry: None,
                            };
                            current_asn = Some(merge_asn(current_asn.as_ref(), &addition));
                        }
                    }
                    peering_db_details = Some(result);
                    statuses.push(make_provider_status(
                        "peeringdb",
                        "success",
                        "Lookup complete.",
                    ));
                }
                Ok(None) => {
                    statuses.push(make_provider_status(
                        "peeringdb",
                        "success",
                        "No data found for this ASN.",
                    ));
                }
                Err(e) => {
                    statuses.push(make_provider_status("peeringdb", "error", &e));
                }
            }
        } else {
            statuses.push(make_provider_status(
                "peeringdb",
                "skipped",
                "Disabled in settings.",
            ));
        }
    } else {
        statuses.push(make_provider_status(
            "peeringdb",
            "skipped",
            "ASN unknown, skipping PeeringDB lookup.",
        ));
    }

    EnrichmentResult {
        geo: current_geo,
        asn: current_asn,
        provider_statuses: statuses,
        peering_db: peering_db_details,
    }
}

pub fn get_integration_settings(store: &SharedStore) -> IntegrationSettings {
    let guard = store.lock().unwrap();
    guard.integrations.clone()
}

pub fn set_integration_settings(store: &SharedStore, settings: IntegrationSettings) {
    let mut guard = store.lock().unwrap();
    guard.integrations = settings;
}
