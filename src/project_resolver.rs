//! Configured-project discovery for the Oxlint runner.
use crate::overlay::path_key;
use crate::project::ConfigHost;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use tsrs_core::tspath;
use tsrs_tsoptions::get_parsed_command_line_of_config_file;

#[derive(Clone)]
struct ConfigInfo {
    roots: BTreeSet<String>,
    references: Vec<String>,
    stop_ancestor_search: bool,
}

pub(crate) struct Resolver {
    host: ConfigHost,
    cache: BTreeMap<String, ConfigInfo>,
}

impl Resolver {
    pub(crate) fn new(host: ConfigHost) -> Self {
        Self {
            host,
            cache: BTreeMap::new(),
        }
    }

    fn config(&mut self, path: &str) -> Result<ConfigInfo, String> {
        if let Some(info) = self.cache.get(path) {
            return Ok(info.clone());
        }
        let (config, fatal) =
            get_parsed_command_line_of_config_file(path, None, None, &self.host, None);
        if !fatal.is_empty() {
            return Err(format!("Cannot load TypeScript project {path}"));
        }
        let config = config.ok_or_else(|| format!("Cannot parse TypeScript project {path}"))?;
        let info = ConfigInfo {
            roots: config
                .parsed_config
                .file_names
                .iter()
                .map(|file| path_key(file, &self.host.cwd))
                .collect(),
            references: config.resolved_project_reference_paths().to_vec(),
            stop_ancestor_search: config
                .compiler_options()
                .is_some_and(|options| options.disable_solution_searching.is_true()),
        };
        self.cache.insert(path.into(), info.clone());
        Ok(info)
    }

    pub(crate) fn find(&mut self, file: &str) -> Result<Option<String>, String> {
        let key = path_key(file, &self.host.cwd);
        let absolute = tspath::get_normalized_absolute_path(file, &self.host.cwd);
        let mut directory = Path::new(&absolute).parent();
        let mut visited = BTreeSet::new();
        while let Some(dir) = directory {
            for name in ["tsconfig.json", "jsconfig.json"] {
                let config = dir.join(name).to_string_lossy().replace('\\', "/");
                if !self.host.fs.file_exists(&config) {
                    continue;
                }
                let mut queue = VecDeque::from([config.clone()]);
                while let Some(candidate) = queue.pop_front() {
                    if !visited.insert(candidate.clone()) {
                        continue;
                    }
                    let info = self.config(&candidate)?;
                    if info.roots.contains(&key) {
                        return Ok(Some(candidate));
                    }
                    queue.extend(info.references);
                }
                if self.config(&config)?.stop_ancestor_search {
                    return Ok(None);
                }
                // tsconfig takes precedence over jsconfig in the same directory.
                break;
            }
            directory = dir.parent();
        }
        Ok(None)
    }
}
