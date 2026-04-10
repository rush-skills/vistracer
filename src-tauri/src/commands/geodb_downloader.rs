use crate::commands::geo::reload_geo_databases;
use crate::commands::geo::SharedGeoReaders;
use crate::commands::persistence::SharedStore;
use crate::types::GeoDbDownloadProgress;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const EDITIONS: &[&str] = &["GeoLite2-City", "GeoLite2-ASN"];

fn build_download_url(edition: &str, license_key: &str) -> String {
    format!(
        "https://download.maxmind.com/app/geoip_download?edition_id={}&license_key={}&suffix=tar.gz",
        edition,
        urlencoding::encode(license_key)
    )
}

fn emit_progress(app: &AppHandle, progress: &GeoDbDownloadProgress) {
    if let Err(e) = app.emit("vistracer:geo:download-progress", progress) {
        log::warn!("Failed to emit download progress: {}", e);
    }
}

async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .header(
            "User-Agent",
            "VisTracer/0.2 (GeoIP database downloader)",
        )
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "MaxMind download failed ({}): {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    tokio::fs::write(dest, &bytes)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

pub fn extract_mmdb_from_tar_gz(
    tar_gz_path: &Path,
    edition: &str,
    output_path: &Path,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::fs::File;
    use tar::Archive;

    let file = File::open(tar_gz_path).map_err(|e| format!("Failed to open tar.gz: {}", e))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);

    let mmdb_filename = format!("{}.mmdb", edition);

    for entry in archive
        .entries()
        .map_err(|e| format!("Failed to read tar entries: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("Failed to read tar entry: {}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("Failed to get entry path: {}", e))?;

        if path
            .file_name()
            .and_then(|f| f.to_str())
            .map_or(false, |name| name == mmdb_filename)
        {
            let mut output_file = std::fs::File::create(output_path)
                .map_err(|e| format!("Failed to create output file: {}", e))?;
            std::io::copy(&mut entry, &mut output_file)
                .map_err(|e| format!("Failed to extract file: {}", e))?;
            return Ok(());
        }
    }

    Err(format!("{} not found in downloaded archive", mmdb_filename))
}

async fn download_and_extract(
    edition: &str,
    license_key: &str,
    db_dir: &Path,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let url = build_download_url(edition, license_key);
    log::info!("[geodb] Downloading {}", edition);

    tokio::fs::create_dir_all(db_dir)
        .await
        .map_err(|e| format!("Failed to create database directory: {}", e))?;

    emit_progress(
        app,
        &GeoDbDownloadProgress {
            stage: "downloading".to_string(),
            edition: edition.to_string(),
            percent: Some(0),
            error: None,
        },
    );

    let tar_gz_path = db_dir.join(format!("{}.tar.gz", edition));
    download_file(&url, &tar_gz_path).await?;

    emit_progress(
        app,
        &GeoDbDownloadProgress {
            stage: "downloading".to_string(),
            edition: edition.to_string(),
            percent: Some(100),
            error: None,
        },
    );

    emit_progress(
        app,
        &GeoDbDownloadProgress {
            stage: "extracting".to_string(),
            edition: edition.to_string(),
            percent: None,
            error: None,
        },
    );

    let mmdb_path = db_dir.join(format!("{}.mmdb", edition));
    let tar_gz_clone = tar_gz_path.clone();
    let mmdb_clone = mmdb_path.clone();
    let edition_str = edition.to_string();

    tokio::task::spawn_blocking(move || {
        extract_mmdb_from_tar_gz(&tar_gz_clone, &edition_str, &mmdb_clone)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Clean up tar.gz
    let _ = tokio::fs::remove_file(&tar_gz_path).await;

    emit_progress(
        app,
        &GeoDbDownloadProgress {
            stage: "complete".to_string(),
            edition: edition.to_string(),
            percent: Some(100),
            error: None,
        },
    );

    Ok(mmdb_path)
}

pub async fn download_geo_databases(
    license_key: &str,
    app_data_dir: &Path,
    app: &AppHandle,
    store: &SharedStore,
    readers: &SharedGeoReaders,
) -> Result<(String, String), String> {
    let db_dir = app_data_dir.join("databases");
    let mut results: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();

    for edition in EDITIONS {
        match download_and_extract(edition, license_key, &db_dir, app).await {
            Ok(path) => {
                log::info!("Downloaded {} to {:?}", edition, path);
                results.insert(edition.to_string(), path);
            }
            Err(e) => {
                log::error!("Failed to download {}: {}", edition, e);
                emit_progress(
                    app,
                    &GeoDbDownloadProgress {
                        stage: "error".to_string(),
                        edition: edition.to_string(),
                        percent: None,
                        error: Some(e.clone()),
                    },
                );
                return Err(e);
            }
        }
    }

    let city_path = results
        .get("GeoLite2-City")
        .ok_or("City database not downloaded")?
        .to_string_lossy()
        .to_string();
    let asn_path = results
        .get("GeoLite2-ASN")
        .ok_or("ASN database not downloaded")?
        .to_string_lossy()
        .to_string();

    // Update settings
    {
        let mut guard = store.lock().unwrap();
        guard.geo.city_db_path = Some(city_path.clone());
        guard.geo.asn_db_path = Some(asn_path.clone());
        guard.geo.last_updated = Some(chrono::Utc::now().timestamp_millis() as f64);
    }

    reload_geo_databases(readers, store);

    Ok((city_path, asn_path))
}
