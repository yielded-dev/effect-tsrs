use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::SystemTime;

use tsrs_core::tspath;
use tsrs_vfs::{Entries, FS, FileInfo, FileMode, osvfs};

pub(crate) fn path_key(path: &str, cwd: &str) -> String {
    tspath::get_canonical_file_name(
        &tspath::get_normalized_absolute_path(path, cwd),
        osvfs::fs().use_case_sensitive_file_names(),
    )
}

/// Request-local editor buffers. Never writes unsaved source to the filesystem.
pub(crate) struct Overlay {
    pub base: Arc<dyn FS>,
    pub cwd: String,
    pub files: BTreeMap<String, String>,
}

impl Overlay {
    fn key(&self, path: &str) -> String {
        path_key(path, &self.cwd)
    }
}

impl FS for Overlay {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.base.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        self.files.contains_key(&self.key(path)) || self.base.file_exists(path)
    }
    fn read_file(&self, path: &str) -> Option<String> {
        self.files
            .get(&self.key(path))
            .cloned()
            .or_else(|| self.base.read_file(path))
    }
    fn directory_exists(&self, path: &str) -> bool {
        let prefix = format!("{}/", self.key(path).trim_end_matches('/'));
        self.base.directory_exists(path) || self.files.keys().any(|file| file.starts_with(&prefix))
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        let mut entries = self.base.get_accessible_entries(path);
        let prefix = format!("{}/", self.key(path).trim_end_matches('/'));
        for file in self.files.keys() {
            if let Some(relative) = file.strip_prefix(&prefix) {
                if let Some((directory, _)) = relative.split_once('/') {
                    if !entries.directories.iter().any(|entry| entry == directory) {
                        entries.directories.push(directory.into());
                    }
                } else if !entries.files.iter().any(|entry| entry == relative) {
                    entries.files.push(relative.into());
                }
            }
        }
        entries
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        if let Some(contents) = self.files.get(&self.key(path)) {
            return Some(FileInfo {
                name: tspath::get_base_file_name(path),
                size: contents.len() as i64,
                mode: FileMode::None,
                mod_time: None,
            });
        }
        self.base.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        if self.files.contains_key(&self.key(path)) && !self.base.file_exists(path) {
            tspath::get_normalized_absolute_path(path, &self.cwd)
        } else {
            self.base.realpath(path)
        }
    }
    fn write_file(&self, _path: &str, _data: &str) -> Result<(), String> {
        Err("Oxlint source overlay is read-only".into())
    }
    fn append_file(&self, _path: &str, _data: &str) -> Result<(), String> {
        Err("Oxlint source overlay is read-only".into())
    }
    fn remove(&self, _path: &str) -> Result<(), String> {
        Err("Oxlint source overlay is read-only".into())
    }
    fn chtimes(&self, _path: &str, _a: SystemTime, _m: SystemTime) -> Result<(), String> {
        Err("Oxlint source overlay is read-only".into())
    }
}
