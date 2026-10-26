use crate::commands::persistence::SharedStore;
use std::net::IpAddr;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::Semaphore;

/// getnameinfo can block for a long time when a resolver does not answer.
/// The limit covers the wait for a resolver slot and the answer.
const REVERSE_DNS_TIMEOUT: Duration = Duration::from_secs(4);

/// System resolver calls that may run at once, for all runs together. A
/// blocking call cannot be stopped: after the timeout it keeps its thread
/// until the resolver gives up. Without a cap, a dead resolver would add a
/// blocked thread for each new address.
const MAX_RESOLVER_CALLS: usize = 8;

static RESOLVER_SLOTS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_RESOLVER_CALLS)));

/// Runs `lookup` on the blocking pool when a slot in `slots` is free. The
/// slot stays taken until `lookup` returns, also after the timeout. `None`
/// when no slot freed up, or no answer came, within `timeout`.
async fn bounded_lookup<T: Send + 'static>(
    slots: &Arc<Semaphore>,
    timeout: Duration,
    lookup: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let call = async {
        let slot = slots.clone().acquire_owned().await.ok()?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            lookup()
        })
        .await
        .ok()
    };
    tokio::time::timeout(timeout, call).await.ok().flatten()
}

/// Reverse DNS lookup with caching. The system resolver call is blocking,
/// so it runs on the blocking thread pool, at most `MAX_RESOLVER_CALLS` at
/// a time, and the caller waits at most `REVERSE_DNS_TIMEOUT`.
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

    let lookup = move || dns_lookup::lookup_addr(&ip);
    let host = match bounded_lookup(&RESOLVER_SLOTS, REVERSE_DNS_TIMEOUT, lookup).await {
        Some(Ok(host)) if !host.is_empty() && host != key => host,
        Some(Ok(_)) => return None,
        Some(Err(e)) => {
            log::debug!("Reverse DNS lookup failed for {key}: {e}");
            return None;
        }
        None => {
            log::debug!("Reverse DNS lookup timed out for {key} (resolver busy or not answering)");
            return None;
        }
    };

    let mut guard = store.lock().unwrap_or_else(|e| e.into_inner());
    guard.set_cached_dns(&key, &host);
    Some(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Instant;

    #[tokio::test]
    async fn a_dead_resolver_holds_at_most_the_cap_and_callers_return_at_the_timeout() {
        const CAP: usize = 2;
        const CALLERS: usize = 10;
        const TIMEOUT: Duration = Duration::from_millis(200);
        let slots = Arc::new(Semaphore::new(CAP));
        let started = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        // The fake resolver answers only when the test releases it, like a
        // DNS server that does not reply until the system gives up.
        let (release, released) = mpsc::channel::<()>();
        let released = Arc::new(Mutex::new(released));

        let callers: Vec<_> = (0..CALLERS)
            .map(|i| {
                let slots = slots.clone();
                let (started, running, peak) = (started.clone(), running.clone(), peak.clone());
                let released = released.clone();
                tokio::spawn(async move {
                    let begun = Instant::now();
                    let answer = bounded_lookup(&slots, TIMEOUT, move || {
                        started.fetch_add(1, Ordering::SeqCst);
                        peak.fetch_max(
                            running.fetch_add(1, Ordering::SeqCst) + 1,
                            Ordering::SeqCst,
                        );
                        let _ = released.lock().unwrap().recv();
                        running.fetch_sub(1, Ordering::SeqCst);
                        format!("host-{i}")
                    })
                    .await;
                    (answer, begun.elapsed())
                })
            })
            .collect();
        for caller in callers {
            let (answer, elapsed) = tokio::time::timeout(Duration::from_secs(5), caller)
                .await
                .expect("a caller must not wait for the resolver")
                .unwrap();
            assert_eq!(answer, None);
            assert!(
                elapsed >= TIMEOUT && elapsed < TIMEOUT + Duration::from_secs(1),
                "{elapsed:?}"
            );
        }
        assert_eq!(
            started.load(Ordering::SeqCst),
            CAP,
            "only CAP calls reach the resolver"
        );
        assert_eq!(peak.load(Ordering::SeqCst), CAP);

        // While the stuck calls hold every slot, a new lookup starts no call.
        assert_eq!(bounded_lookup(&slots, TIMEOUT, || "late").await, None);
        assert_eq!(started.load(Ordering::SeqCst), CAP);

        // When the resolver answers, the slots free up and lookups work again.
        for _ in 0..CAP {
            release.send(()).unwrap();
        }
        let answer = bounded_lookup(&slots, Duration::from_secs(5), || "back").await;
        assert_eq!(answer, Some("back"));
    }

    #[tokio::test]
    async fn a_resolver_that_answers_in_time_gives_its_answer() {
        let slots = Arc::new(Semaphore::new(1));
        let answer = bounded_lookup(&slots, Duration::from_secs(1), || "dns.google").await;
        assert_eq!(answer, Some("dns.google"));
        assert_eq!(slots.available_permits(), 1);
    }
}
