use crate::commands::persistence::SharedStore;

/// Perform a reverse DNS lookup for an IP address, with caching.
pub async fn resolve_reverse_dns(
    ip: &str,
    force_refresh: bool,
    store: &SharedStore,
) -> Option<String> {
    if ip.is_empty() {
        return None;
    }

    if !force_refresh {
        let guard = store.lock().unwrap();
        if let Some(cached) = guard.get_cached_dns(ip) {
            return Some(cached);
        }
    }

    // Use dns-lookup for reverse DNS
    match dns_lookup::lookup_addr(&ip.parse().ok()?) {
        Ok(host) => {
            if !host.is_empty() && host != ip {
                if !force_refresh {
                    let mut guard = store.lock().unwrap();
                    guard.set_cached_dns(ip, &host);
                }
                Some(host)
            } else {
                None
            }
        }
        Err(e) => {
            log::debug!("Reverse DNS lookup failed for {}: {}", ip, e);
            None
        }
    }
}
