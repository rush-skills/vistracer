// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod atomic_file;
mod commands;
mod geoloc;
mod net;
mod types;

use commands::app_info::{updater_pubkey_configured, AppInfo};
use commands::geo::{
    database_statuses, ensure_readers, reload_geo_databases, GeoReaders, SharedGeoReaders,
};
use commands::geodb_downloader::download_geo_databases;
use commands::integrations::{EnrichmentConfig, EnrichmentService};
use commands::persistence::{
    configure_geo_database_defaults, ensure_app_data_dirs, save_persisted_settings, AppStore,
    IntegrationSettings, SharedStore, UiPreferences,
};
use commands::tile_cache::{
    into_response, HttpFetcher, TileCacheInfo, TileError, TileService, TileStore,
    DEFAULT_CAP_BYTES, TILE_SCHEME,
};
use commands::traceroute::{
    cancel_traceroute, create_active_runs, run_traceroute, ActiveRuns, TracerouteDeps,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;
use types::*;

struct AppState {
    store: Arc<SharedStore>,
    geo_readers: Arc<SharedGeoReaders>,
    enrichment: Arc<EnrichmentService>,
    tiles: Arc<TileService<HttpFetcher>>,
    active_runs: ActiveRuns,
    app_data_dir: PathBuf,
}

impl AppState {
    fn store(&self) -> MutexGuard<'_, AppStore> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[tauri::command]
async fn traceroute_run(
    request: TracerouteRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TracerouteExecutionResult, String> {
    let deps = TracerouteDeps {
        store: state.store.clone(),
        readers: state.geo_readers.clone(),
        enrichment: state.enrichment.clone(),
        active_runs: state.active_runs.clone(),
    };
    run_traceroute(request, app, &deps).await
}

#[tauri::command]
async fn traceroute_cancel(
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    cancel_traceroute(&run_id, &state.active_runs);
    Ok(())
}

#[tauri::command]
async fn get_recent_runs(state: tauri::State<'_, AppState>) -> Result<Vec<RecentRun>, String> {
    Ok(state.store().get_recent_runs(5))
}

#[tauri::command]
async fn get_geo_database_meta(
    state: tauri::State<'_, AppState>,
) -> Result<GeoDatabaseMeta, String> {
    ensure_readers(&state.geo_readers, &state.store);
    let (city_path, asn_path, updated_at) = {
        let guard = state.store();
        (
            guard.geo.city_db_path.clone(),
            guard.geo.asn_db_path.clone(),
            guard.geo.last_updated,
        )
    };
    let (city_status, asn_status, load_errors) = database_statuses(&state.geo_readers);

    let loaded = |s: GeoDatabaseStatus| s == GeoDatabaseStatus::Loaded;
    let status_message = if !load_errors.is_empty() {
        Some(load_errors.join(" "))
    } else if !loaded(city_status) && !loaded(asn_status) {
        Some("GeoIP databases not found. Fallback services will attempt lookups but accuracy may vary.".to_string())
    } else if !loaded(city_status) {
        Some("City database not found. Hops will have no map location.".to_string())
    } else if !loaded(asn_status) {
        Some("ASN database not found. ASN details will rely on external providers.".to_string())
    } else {
        None
    };

    Ok(GeoDatabaseMeta {
        city_db_path: city_path,
        asn_db_path: asn_path,
        updated_at,
        city_db_status: city_status,
        asn_db_status: asn_status,
        status_message,
    })
}

#[tauri::command]
async fn update_geo_database_paths(
    city_path: Option<String>,
    asn_path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut guard = state.store();
        guard.geo.city_db_path = city_path;
        guard.geo.asn_db_path = asn_path;
        guard.geo.last_updated = Some(chrono::Utc::now().timestamp_millis() as f64);
        save_persisted_settings(&state.app_data_dir, &guard);
    }
    reload_geo_databases(&state.geo_readers, &state.store);
    Ok(())
}

#[tauri::command]
async fn select_geo_db_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file = app
        .dialog()
        .file()
        .add_filter("MaxMind Database", &["mmdb"])
        .add_filter("All Files", &["*"])
        .set_title("Select GeoLite2 Database File")
        .blocking_pick_file();

    Ok(file.map(|f| {
        f.into_path()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    }))
}

#[tauri::command]
async fn download_geo_db(
    license_key: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (city_path, asn_path) = download_geo_databases(
        &license_key,
        &state.app_data_dir,
        &app,
        &state.store,
        &state.geo_readers,
    )
    .await?;

    Ok(serde_json::json!({
        "cityPath": city_path,
        "asnPath": asn_path
    }))
}

#[tauri::command]
async fn get_settings(
    key: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let guard = state.store();
    let value = match key.as_str() {
        "geo" => serde_json::to_value(&guard.geo),
        "preferences" => serde_json::to_value(&guard.preferences),
        "preferences.onboarding" => serde_json::to_value(&guard.preferences.onboarding),
        "preferences.ui" => serde_json::to_value(&guard.preferences.ui),
        "integrations" => serde_json::to_value(&guard.integrations),
        "cache" => serde_json::to_value(&guard.cache_settings),
        _ => Ok(serde_json::Value::Null),
    };
    value.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_settings(
    key: String,
    value: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.store();

    match key.as_str() {
        "integrations" => {
            let parsed: IntegrationSettings = serde_json::from_value(value)
                .map_err(|e| format!("Invalid integration settings: {e}"))?;
            guard.integrations = parsed.validated()?;
        }
        "preferences.onboarding" => {
            guard.preferences.onboarding =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        "preferences.ui" => {
            let parsed: UiPreferences = serde_json::from_value(value)
                .map_err(|e| format!("Invalid UI preferences: {e}"))?;
            guard.preferences.ui = parsed.validated()?;
        }
        "preferences" => {
            guard.preferences = serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        "geo" => {
            guard.geo = serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown settings key: {key}")),
    }

    state
        .tiles
        .set_online_enabled(guard.preferences.ui.online_imagery());
    save_persisted_settings(&state.app_data_dir, &guard);
    Ok(())
}

#[tauri::command]
async fn get_tile_cache_info(state: tauri::State<'_, AppState>) -> Result<TileCacheInfo, String> {
    state.tiles.info().await
}

#[tauri::command]
async fn clear_tile_cache(state: tauri::State<'_, AppState>) -> Result<TileCacheInfo, String> {
    state.tiles.clear().await
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        updater_configured: updater_pubkey_configured(app.config().plugins.0.get("updater")),
    }
}

#[tauri::command]
async fn emit_telemetry(
    event_name: String,
    _payload: Option<serde_json::Value>,
) -> Result<(), String> {
    log::debug!("Telemetry event: {}", event_name);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol(TILE_SCHEME, |ctx, request, responder| {
            let tiles = ctx
                .app_handle()
                .try_state::<AppState>()
                .map(|state| state.tiles.clone());
            tauri::async_runtime::spawn(async move {
                let response = match tiles {
                    Some(tiles) => tiles.respond(&request).await,
                    None => into_response(Err(TileError::NotReady)),
                };
                responder.respond(response);
            });
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            ensure_app_data_dirs(&app_data_dir);

            let cache_dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| app_data_dir.join("cache"));

            let assets_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("assets"));

            let store: Arc<SharedStore> = Arc::new(Mutex::new(AppStore::default()));
            let readers: Arc<SharedGeoReaders> = Arc::new(Mutex::new(GeoReaders::default()));

            configure_geo_database_defaults(&store, &assets_dir, &app_data_dir);
            ensure_readers(&readers, &store);

            let enrichment_ttl = Duration::from_millis(
                store
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .cache_settings
                    .enrichment_ttl_ms,
            );
            let enrichment = Arc::new(EnrichmentService::new(EnrichmentConfig::production(
                cache_dir.join("enrichment-cache.json"),
                enrichment_ttl,
            )));

            let tiles = Arc::new(TileService::new(
                TileStore::new(cache_dir.join("tiles"), DEFAULT_CAP_BYTES),
                HttpFetcher::default(),
            ));
            // Before the webview can ask for a tile.
            tiles.set_online_enabled(
                store
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .preferences
                    .ui
                    .online_imagery(),
            );

            app.manage(AppState {
                store,
                geo_readers: readers,
                enrichment,
                tiles,
                active_runs: create_active_runs(),
                app_data_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            traceroute_run,
            traceroute_cancel,
            get_recent_runs,
            get_geo_database_meta,
            update_geo_database_paths,
            select_geo_db_file,
            download_geo_db,
            get_settings,
            set_settings,
            emit_telemetry,
            get_app_info,
            get_tile_cache_info,
            clear_tile_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
