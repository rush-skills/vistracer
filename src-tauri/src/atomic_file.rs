//! File writes that never leave a truncated file behind.

use std::io;
use std::path::Path;

/// Writes through a temporary file in the same directory and a rename, so a
/// crash during the write cannot leave a truncated file. The temporary name
/// is unique, so concurrent writers of the same path (two runs, or two app
/// instances that share a cache folder) never write into each other's
/// temporary file: each rename puts a complete file in place.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let tmp = path.with_file_name(format!(
        "{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// True for the temporary files `write_atomic` leaves behind after a crash.
pub fn is_temp_file(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "tmp")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vistracer-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn writes_replace_the_file_and_leave_no_temporary_files() {
        let dir = temp_dir("atomic");
        let path = dir.join("nested").join("file.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| is_temp_file(p))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_writers_of_one_path_never_tear_the_file() {
        let dir = temp_dir("atomic-race");
        let path = dir.join("tile.jpg");
        let payloads: Vec<Vec<u8>> = (0..8u8).map(|i| vec![i; 64 * 1024]).collect();
        std::thread::scope(|scope| {
            for payload in &payloads {
                let path = &path;
                scope.spawn(move || {
                    for _ in 0..20 {
                        write_atomic(path, payload).unwrap();
                    }
                });
            }
        });
        let written = std::fs::read(&path).unwrap();
        assert!(
            payloads.contains(&written),
            "the file must be one complete payload"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
