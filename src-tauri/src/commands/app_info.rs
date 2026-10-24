//! App version and updater state for the renderer.

use serde::Serialize;
use serde_json::Value;

/// Marker in the shipped `plugins.updater.pubkey`. Builds that still carry
/// it have no signing key, so the renderer does not offer updates.
const PUBKEY_PLACEHOLDER: &str = "PLACEHOLDER";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub updater_configured: bool,
}

/// `updater_config` is the `plugins.updater` object from tauri.conf.json.
pub fn updater_pubkey_configured(updater_config: Option<&Value>) -> bool {
    updater_config
        .and_then(|config| config.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty() && !key.contains(PUBKEY_PLACEHOLDER))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn placeholder_or_missing_key_disables_updates() {
        assert!(!updater_pubkey_configured(None));
        assert!(!updater_pubkey_configured(Some(&json!({}))));
        assert!(!updater_pubkey_configured(Some(&json!({ "pubkey": "  " }))));
        assert!(!updater_pubkey_configured(Some(
            &json!({ "pubkey": "PUBLIC KEY PLACEHOLDER: replace me" })
        )));
        assert!(updater_pubkey_configured(Some(
            &json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=" })
        )));
    }

    #[test]
    fn shipped_config_points_at_github_latest_json() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            json!([
                "https://github.com/rush-skills/vistracer/releases/latest/download/latest.json"
            ])
        );
        assert!(updater["pubkey"].is_string());
    }
}
