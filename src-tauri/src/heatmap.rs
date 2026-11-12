//! Wi-Fi Heatmap storage (same layout as the Mac's HeatmapStore): <app data>/heatmaps/<id>/heatmap.json, plus
//! plan.png (the floor plan), base.png (a map picture a plan can be laid over), overlay.png / overlay-original.png.
//! The window does the pictures (canvas) and the math (ui/heatmap.js); this only reads and writes the files.

use base64::Engine;
use std::path::PathBuf;

/// The pictures a heatmap folder may hold.
const FILES: [&str; 4] = ["plan.png", "base.png", "overlay.png", "overlay-original.png"];

fn root(dir: &std::path::Path) -> PathBuf {
    dir.join("heatmaps")
}

/// A heatmap id is a UUID: letters, digits and dashes only (it becomes a folder name).
fn folder(dir: &std::path::Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Unknown heatmap".into());
    }
    Ok(root(dir).join(id))
}

fn file(dir: &std::path::Path, id: &str, name: &str) -> Result<PathBuf, String> {
    if !FILES.contains(&name) {
        return Err(format!("Unknown file {name}"));
    }
    Ok(folder(dir, id)?.join(name))
}

/// Every heatmap's heatmap.json (unreadable folders are skipped).
pub fn list(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root(dir)) else { return vec![] };
    entries.flatten().filter_map(|e| std::fs::read_to_string(e.path().join("heatmap.json")).ok()).collect()
}

pub fn save(dir: &std::path::Path, id: &str, json: &str) -> Result<(), String> {
    let d = folder(dir, id)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join("heatmap.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join("heatmap.json")).map_err(|e| e.to_string())
}

/// Moves the heatmap's folder to the Recycle Bin (the Trash on a Mac).
pub fn delete(dir: &std::path::Path, id: &str) -> Result<(), String> {
    let d = folder(dir, id)?;
    if !d.exists() {
        return Ok(());
    }
    trash::delete(&d).or_else(|_| std::fs::remove_dir_all(&d)).map_err(|e| e.to_string())
}

/// A picture as base64 (for a data: URL), or None when it isn't there.
pub fn read_file(dir: &std::path::Path, id: &str, name: &str) -> Result<Option<String>, String> {
    match std::fs::read(file(dir, id, name)?) {
        Ok(b) => Ok(Some(base64::engine::general_purpose::STANDARD.encode(b))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes a picture (base64); an empty string removes it.
pub fn write_file(dir: &std::path::Path, id: &str, name: &str, data: &str) -> Result<(), String> {
    let f = file(dir, id, name)?;
    if data.is_empty() {
        let _ = std::fs::remove_file(&f);
        return Ok(());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "That picture couldn\u{2019}t be read.".to_string())?;
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("png.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

/// Copies one picture to another name in the same heatmap (plan.png → base.png, base.png → plan.png).
pub fn copy_file(dir: &std::path::Path, id: &str, from: &str, to: &str) -> Result<(), String> {
    std::fs::copy(file(dir, id, from)?, file(dir, id, to)?).map(|_| ()).map_err(|e| e.to_string())
}

/// Save as New Heatmap: the pictures of `from` copied into `to` (its heatmap.json is written by the window).
pub fn duplicate(dir: &std::path::Path, from: &str, to: &str) -> Result<(), String> {
    let d = folder(dir, to)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    for name in FILES {
        let src = file(dir, from, name)?;
        if src.exists() {
            std::fs::copy(&src, d.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_reads_copies_and_refuses_odd_names() {
        let dir = std::env::temp_dir().join(format!("arpradar-heatmap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save(&dir, "A1B2-C3", "{\"id\":\"A1B2-C3\"}").unwrap();
        assert_eq!(list(&dir), vec!["{\"id\":\"A1B2-C3\"}".to_string()]);
        write_file(&dir, "A1B2-C3", "plan.png", "iVBORw0K").unwrap();
        assert_eq!(read_file(&dir, "A1B2-C3", "plan.png").unwrap().as_deref(), Some("iVBORw0K"));
        assert_eq!(read_file(&dir, "A1B2-C3", "base.png").unwrap(), None);
        copy_file(&dir, "A1B2-C3", "plan.png", "base.png").unwrap();
        duplicate(&dir, "A1B2-C3", "D4E5").unwrap();
        assert!(read_file(&dir, "D4E5", "base.png").unwrap().is_some());
        write_file(&dir, "A1B2-C3", "plan.png", "").unwrap();
        assert_eq!(read_file(&dir, "A1B2-C3", "plan.png").unwrap(), None);
        assert!(save(&dir, "../evil", "{}").is_err());
        assert!(read_file(&dir, "A1B2-C3", "../../data.json").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
