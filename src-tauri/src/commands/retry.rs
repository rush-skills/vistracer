//! Retry with exponential backoff and jitter for enrichment provider calls.

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum ProviderError {
    RateLimited { retry_after: Option<Duration> },
    Server(u16),
    Client(u16),
    Timeout,
    Network(String),
    Parse(String),
}

impl ProviderError {
    /// 429, 5xx, timeouts and connection failures are transient.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ProviderError::RateLimited { .. }
                | ProviderError::Server(_)
                | ProviderError::Timeout
                | ProviderError::Network(_)
        )
    }

    pub fn describe(&self) -> String {
        match self {
            ProviderError::RateLimited { .. } => "Rate limited (HTTP 429)".to_string(),
            ProviderError::Server(code) => format!("Server error (HTTP {code})"),
            ProviderError::Client(code) => format!("Request rejected (HTTP {code})"),
            ProviderError::Timeout => "Timed out".to_string(),
            ProviderError::Network(msg) => format!("Network error: {msg}"),
            ProviderError::Parse(msg) => format!("Unexpected response: {msg}"),
        }
    }

    pub fn from_status(status: u16, retry_after: Option<Duration>) -> Self {
        match status {
            429 => ProviderError::RateLimited { retry_after },
            500..=599 => ProviderError::Server(status),
            _ => ProviderError::Client(status),
        }
    }
}

impl From<reqwest::Error> for ProviderError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            ProviderError::Timeout
        } else if err.is_decode() {
            ProviderError::Parse(err.to_string())
        } else {
            ProviderError::Network(err.without_url().to_string())
        }
    }
}

#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub attempt_timeout: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(8),
            attempt_timeout: Duration::from_secs(6),
        }
    }
}

impl RetryPolicy {
    /// Delay before retry number `retry` (1 = first retry). Uses "equal
    /// jitter": half of the exponential step is fixed and half is random, so
    /// clients spread out but still back off. A server `Retry-After` value
    /// wins when it is longer, capped at `max_delay`.
    pub fn backoff_delay(
        &self,
        retry: u32,
        jitter: f64,
        retry_after: Option<Duration>,
    ) -> Duration {
        let exponent = retry.saturating_sub(1).min(16);
        let step = self
            .base_delay
            .saturating_mul(1u32 << exponent)
            .min(self.max_delay);
        let half = step / 2;
        let jittered = half + half.mul_f64(jitter.clamp(0.0, 1.0));
        match retry_after {
            Some(server) => server.min(self.max_delay).max(jittered),
            None => jittered,
        }
    }
}

/// Uniform value in [0, 1). `RandomState` is seeded from OS randomness, so
/// this needs no extra dependency and is good enough for jitter.
pub fn jitter() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(0);
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

/// Runs `op` until it succeeds, fails with a non-retryable error, or uses up
/// `max_attempts`. Each attempt is bounded by `attempt_timeout`. Returns the
/// last error and the number of attempts made.
pub async fn with_retry<T, F, Fut>(
    policy: &RetryPolicy,
    label: &str,
    mut op: F,
) -> Result<T, (ProviderError, u32)>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, ProviderError>>,
{
    let mut attempt = 1;
    loop {
        let result = tokio::time::timeout(policy.attempt_timeout, op())
            .await
            .unwrap_or(Err(ProviderError::Timeout));
        match result {
            Ok(value) => return Ok(value),
            Err(err) if err.is_retryable() && attempt < policy.max_attempts => {
                let retry_after = match &err {
                    ProviderError::RateLimited { retry_after } => *retry_after,
                    _ => None,
                };
                let delay = policy.backoff_delay(attempt, jitter(), retry_after);
                log::debug!(
                    "{label}: attempt {attempt} failed ({}), retrying in {delay:?}",
                    err.describe()
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(err) => return Err((err, attempt)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
            attempt_timeout: Duration::from_millis(200),
        }
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        let policy = RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(8),
            attempt_timeout: Duration::from_secs(1),
        };
        // jitter 0 gives the lower bound (half the step), jitter 1 the step.
        assert_eq!(
            policy.backoff_delay(1, 0.0, None),
            Duration::from_millis(250)
        );
        assert_eq!(
            policy.backoff_delay(1, 1.0, None),
            Duration::from_millis(500)
        );
        assert_eq!(
            policy.backoff_delay(2, 1.0, None),
            Duration::from_millis(1000)
        );
        assert_eq!(
            policy.backoff_delay(3, 1.0, None),
            Duration::from_millis(2000)
        );
        assert_eq!(policy.backoff_delay(10, 1.0, None), Duration::from_secs(8));
        assert_eq!(policy.backoff_delay(40, 0.5, None), Duration::from_secs(6));
    }

    #[test]
    fn backoff_respects_retry_after_up_to_cap() {
        let policy = RetryPolicy::default();
        assert_eq!(
            policy.backoff_delay(1, 0.0, Some(Duration::from_secs(3))),
            Duration::from_secs(3)
        );
        assert_eq!(
            policy.backoff_delay(1, 0.0, Some(Duration::from_secs(120))),
            policy.max_delay
        );
    }

    #[test]
    fn jitter_is_in_unit_interval_and_varies() {
        let samples: Vec<f64> = (0..32).map(|_| jitter()).collect();
        assert!(samples.iter().all(|j| (0.0..1.0).contains(j)));
        assert!(samples.windows(2).any(|w| w[0] != w[1]));
    }

    #[test]
    fn classifies_retryable_errors() {
        assert!(ProviderError::from_status(429, None).is_retryable());
        assert!(ProviderError::from_status(503, None).is_retryable());
        assert!(!ProviderError::from_status(400, None).is_retryable());
        assert!(!ProviderError::from_status(403, None).is_retryable());
        assert!(ProviderError::Timeout.is_retryable());
        assert!(!ProviderError::Parse("x".into()).is_retryable());
    }

    #[tokio::test]
    async fn retries_transient_errors_until_success() {
        let calls = AtomicU32::new(0);
        let result = with_retry(&fast_policy(), "test", || async {
            match calls.fetch_add(1, Ordering::SeqCst) {
                0 => Err(ProviderError::Server(503)),
                1 => Err(ProviderError::RateLimited { retry_after: None }),
                _ => Ok("ok"),
            }
        })
        .await;
        assert_eq!(result, Ok("ok"));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn stops_on_non_retryable_error() {
        let calls = AtomicU32::new(0);
        let result: Result<(), _> = with_retry(&fast_policy(), "test", || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::Client(400))
        })
        .await;
        assert_eq!(result, Err((ProviderError::Client(400), 1)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let calls = AtomicU32::new(0);
        let result: Result<(), _> = with_retry(&fast_policy(), "test", || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::Server(502))
        })
        .await;
        assert_eq!(result, Err((ProviderError::Server(502), 3)));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn times_out_slow_attempts_and_retries() {
        let calls = AtomicU32::new(0);
        let result = with_retry(&fast_policy(), "test", || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Ok::<_, ProviderError>(n)
            }
        })
        .await;
        assert_eq!(result, Ok(1));
    }
}
