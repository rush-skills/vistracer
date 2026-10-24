//! Per-address lookup work that runs outside the traceroute read loop.

use super::dns::resolve_reverse_dns;
use super::geo::{lookup_geolite, SharedGeoReaders};
use super::integrations::{Enrichment, EnrichmentService};
use super::persistence::{IntegrationSettings, SharedStore};
use std::future::Future;
use std::net::IpAddr;
use std::sync::Arc;

/// `NameOnly` is used for secondary responders of a multipath hop: they are
/// shown with their host name, but only the primary responder is sent to
/// GeoLite2 and the external providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LookupKind {
    NameOnly,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LookupRequest {
    pub ip: String,
    pub kind: LookupKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IpLookup {
    pub host_name: Option<String>,
    pub enrichment: Option<Enrichment>,
}

pub struct LookupContext {
    pub store: Arc<SharedStore>,
    pub readers: Arc<SharedGeoReaders>,
    pub enrichment: Arc<EnrichmentService>,
    pub settings: IntegrationSettings,
    pub force_fresh: bool,
}

/// The lookup work the traceroute loop schedules for each new address.
pub trait HopLookup: Send + Sync + 'static {
    fn lookup(&self, request: &LookupRequest) -> impl Future<Output = IpLookup> + Send;
}

impl HopLookup for LookupContext {
    fn lookup(&self, request: &LookupRequest) -> impl Future<Output = IpLookup> + Send {
        lookup_ip(self, request)
    }
}

pub async fn lookup_ip(ctx: &LookupContext, request: &LookupRequest) -> IpLookup {
    let Ok(ip) = request.ip.parse::<IpAddr>() else {
        return IpLookup {
            host_name: None,
            enrichment: None,
        };
    };
    let host_name = resolve_reverse_dns(ip, ctx.force_fresh, &ctx.store);

    match request.kind {
        LookupKind::NameOnly => IpLookup {
            host_name: host_name.await,
            enrichment: None,
        },
        LookupKind::Full => {
            let geolite = lookup_geolite(ip, &ctx.readers, &ctx.store);
            let enrichment = ctx
                .enrichment
                .enrich(ip, geolite, &ctx.settings, ctx.force_fresh);
            let (host_name, enrichment) = tokio::join!(host_name, enrichment);
            IpLookup {
                host_name,
                enrichment: Some(enrichment),
            }
        }
    }
}
