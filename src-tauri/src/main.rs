// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

mod commands;
mod net;
mod types;

use commands::geo::{
    ensure_readers, reload_geo_databases, GeoReaders, SharedGeoReaders,
};
use commands::geodb_downloader::download_geo_databases;
use commands::persistence::{
    configure_geo_database_defaults, ensure_app_data_dirs, save_persisted_settings, AppStore,
    SharedStore,
};
use commands::traceroute::{cancel_traceroute, create_active_runs, run_traceroute, ActiveRuns};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use types::*;

struct AppState {
    store: SharedStore,
    geo_readers: SharedGeoReaders,
    active_runs: ActiveRuns,
    app_data_dir: PathBuf,
}

#[tauri::command]
async fn traceroute_run(
    request: TracerouteRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TracerouteExecutionResult, String> {
    run_traceroute(
        request,
        app,
        &state.store,
        &state.geo_readers,
        &state.active_runs,
    )
    .await
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
    let guard = state.store.lock().unwrap();
    Ok(guard.get_recent_runs(5))
}

#[tauri::command]
async fn get_geo_database_meta(
    state: tauri::State<'_, AppState>,
) -> Result<GeoDatabaseMeta, String> {
    let guard = state.store.lock().unwrap();
    let city_path = guard.geo.city_db_path.clone();
    let asn_path = guard.geo.asn_db_path.clone();
    let updated = guard.geo.last_updated;
    drop(guard);

    let city_exists = city_path
        .as_ref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);
    let asn_exists = asn_path
        .as_ref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);

    let city_status = if city_path.is_some() {
        if city_exists {
            "loaded"
        } else {
            "error"
        }
    } else {
        "missing"
    };

    let asn_status = if asn_path.is_some() {
        if asn_exists {
            "loaded"
        } else {
            "error"
        }
    } else {
        "missing"
    };

    let status_message = if !city_exists && !asn_exists {
        Some("GeoIP databases not found. Fallback services will attempt lookups but accuracy may vary.".to_string())
    } else if !city_exists {
        Some("City database not found. Location accuracy will rely on fallback providers.".to_string())
    } else if !asn_exists {
        Some("ASN database not found. ASN details will rely on fallback providers.".to_string())
    } else {
        None
    };

    Ok(GeoDatabaseMeta {
        city_db_path: city_path,
        asn_db_path: asn_path,
        updated_at: updated,
        city_db_status: city_status.to_string(),
        asn_db_status: asn_status.to_string(),
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
        let mut guard = state.store.lock().unwrap();
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

    Ok(file.map(|f| f.into_path().unwrap_or_default().to_string_lossy().to_string()))
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
    let guard = state.store.lock().unwrap();

    match key.as_str() {
        "geo" => serde_json::to_value(&guard.geo).map_err(|e| e.to_string()),
        "preferences" => serde_json::to_value(&guard.preferences).map_err(|e| e.to_string()),
        "preferences.onboarding" => {
            serde_json::to_value(&guard.preferences.onboarding).map_err(|e| e.to_string())
        }
        "integrations" => {
            serde_json::to_value(&guard.integrations).map_err(|e| e.to_string())
        }
        "cache" => {
            serde_json::to_value(&guard.cache_settings).map_err(|e| e.to_string())
        }
        _ => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
async fn set_settings(
    key: String,
    value: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.store.lock().unwrap();

    match key.as_str() {
        "integrations" => {
            guard.integrations =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        "preferences.onboarding" => {
            guard.preferences.onboarding =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        "preferences" => {
            guard.preferences =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        "geo" => {
            guard.geo =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
        }
        _ => {
            log::warn!("Unknown settings key: {}", key);
        }
    }

    save_persisted_settings(&state.app_data_dir, &guard);
    Ok(())
}

#[tauri::command]
async fn emit_telemetry(event_name: String, _payload: Option<serde_json::Value>) -> Result<(), String> {
    log::debug!("Telemetry event: {}", event_name);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
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

            let assets_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("assets"));

            let store: SharedStore = Mutex::new(AppStore::default());
            let readers: SharedGeoReaders = Mutex::new(GeoReaders::default());
            let active_runs = create_active_runs();

            // Configure geo database defaults synchronously on setup
            {
                let rt = tokio::runtime::Runtime::new()
                    .expect("Failed to create tokio runtime for setup");
                rt.block_on(configure_geo_database_defaults(&store, &assets_dir, &app_data_dir));
            }

            ensure_readers(&readers, &store);

            app.manage(AppState {
                store,
                geo_readers: readers,
                active_runs,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
