//! HTTPS downloads from a fixed list of hosts, shared by the tile cache and
//! the submarine cable download. Redirects are followed only to the same
//! list, and a response body has a size cap.

use std::future::Future;
use std::time::Duration;
use tauri::http::header;

/// An upstream answer, before it is checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub trait Fetcher: Send + Sync + 'static {
    fn fetch(&self, url: reqwest::Url) -> impl Future<Output = Result<Fetched, String>> + Send;
}

/// HTTPS on the default port, no credentials, and a host in `hosts`.
pub fn is_allowed(url: &reqwest::Url, hosts: &[&str]) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|host| hosts.contains(&host))
}

pub fn client_builder(hosts: &'static [&'static str], timeout: Duration) -> reqwest::ClientBuilder {
    let redirects = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 3 {
            attempt.error("too many redirects")
        } else if is_allowed(attempt.url(), hosts) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .user_agent(format!(
            "VisTracer/{} (+https://github.com/rush-skills/vistracer)",
            env!("CARGO_PKG_VERSION")
        ))
        .redirect(redirects)
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
}

pub struct HttpFetcher {
    /// A client that could not be built is kept as its error: falling back
    /// to a default client would follow redirects to any host.
    client: Result<reqwest::Client, String>,
    max_bytes: usize,
}

impl HttpFetcher {
    pub fn new(hosts: &'static [&'static str], max_bytes: usize, timeout: Duration) -> Self {
        Self::from_client(
            client_builder(hosts, timeout)
                .build()
                .map_err(|e| format!("cannot create the HTTP client: {e}")),
            max_bytes,
        )
    }

    pub fn from_client(client: Result<reqwest::Client, String>, max_bytes: usize) -> Self {
        Self { client, max_bytes }
    }
}

impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, String> {
        let client = self.client.as_ref().map_err(Clone::clone)?;
        let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > self.max_bytes {
                return Err(format!("response larger than {} bytes", self.max_bytes));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Fetched {
            status,
            content_type,
            body,
        })
    }
}
