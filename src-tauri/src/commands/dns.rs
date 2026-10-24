use crate::commands::persistence::SharedStore;
use std::net::IpAddr;
use std::time::Duration;

/// getnameinfo can block for a long time when a resolver does not answer.
const REVERSE_DNS_TIMEOUT: Duration = Duration::from_secs(4);

/// Reverse DNS lookup with caching. The system resolver call is blocking,
/// so it runs on the blocking thread pool with a timeout.
pub async fn resolve_reverse_dns(
    ip: IpAddr,
    force_refresh: bool,
    store: &SharedStore,
) -> Option<String> {
    let key = ip.to_string();
    if !force_refresh {
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.get_cached_dns(&key) {
            return Some(cached);
        }
    }

    let lookup = tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip));
    let host = match tokio::time::timeout(REVERSE_DNS_TIMEOUT, lookup).await {
        Ok(Ok(Ok(host))) if !host.is_empty() && host != key => host,
        Ok(Ok(Err(e))) => {
            log::debug!("Reverse DNS lookup failed for {key}: {e}");
            return None;
        }
        Err(_) => {
            log::debug!("Reverse DNS lookup timed out for {key}");
            return None;
        }
        _ => return None,
    };

    let mut guard = store.lock().unwrap_or_else(|e| e.into_inner());
    guard.set_cached_dns(&key, &host);
    Some(host)
}
