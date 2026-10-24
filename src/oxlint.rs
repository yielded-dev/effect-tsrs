//! Oxlint's version-2 headless protocol. Effect rules execute in Rust; other
//! type-aware rules are passed to the original, version-matched tsgolint binary.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tsrs_core::tspath;
use tsrs_vfs::{FS, bundled, osvfs};

use crate::overlay::{Overlay, path_key};
use crate::project::{ConfigHost, check_with_fs};
use crate::project_resolver::Resolver;
use crate::{CheckOptions, CompilerDiagnostic, Diagnostic, Location, Rule};

#[derive(Clone, Deserialize, Serialize)]
struct Payload {
    version: u32,
    configs: Vec<FileConfig>,
    #[serde(default)]
    source_overrides: Option<BTreeMap<String, String>>,
    #[serde(default)]
    report_syntactic: bool,
    #[serde(default)]
    report_semantic: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct FileConfig {
    file_paths: Vec<String>,
    rules: Vec<RuleConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RuleConfig {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<Value>,
}

fn kebab(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut output = String::new();
    for (i, ch) in chars.iter().copied().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0
                && (chars[i - 1].is_ascii_lowercase()
                    || chars.get(i + 1).is_some_and(char::is_ascii_lowercase))
            {
                output.push('-');
            }
            output.push(ch.to_ascii_lowercase());
        } else {
            output.push(ch);
        }
    }
    output
}

fn message(output: &mut dyn Write, kind: u8, data: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(data).map_err(|error| error.to_string())?;
    let len = u32::try_from(payload.len()).map_err(|error| error.to_string())?;
    output
        .write_all(&len.to_le_bytes())
        .and_then(|()| output.write_all(&[kind]))
        .and_then(|()| output.write_all(&payload))
        .map_err(|error| error.to_string())
}

fn byte_offset(source: &str, utf16: usize) -> Result<usize, String> {
    let mut units = 0;
    for (offset, ch) in source.char_indices() {
        if units == utf16 {
            return Ok(offset);
        }
        units += ch.len_utf16();
    }
    if units == utf16 {
        Ok(source.len())
    } else {
        Err("Invalid UTF-16 diagnostic offset".into())
    }
}

fn range(location: &Location, fs: &dyn FS) -> Result<Value, String> {
    let source = fs
        .read_file(&location.file)
        .ok_or_else(|| format!("Cannot read diagnostic source {}", location.file))?;
    Ok(
        json!({"pos": byte_offset(&source, location.start)?, "end": byte_offset(&source, location.start + location.length)?}),
    )
}

fn report_effect(
    diagnostic: &Diagnostic,
    fs: &dyn FS,
    file_path: &str,
    output: &mut dyn Write,
) -> Result<(), String> {
    let mut labels = Vec::new();
    for related in &diagnostic.related_information {
        // The protocol only supports secondary labels in the primary file.
        if related.location.file == diagnostic.location.file {
            labels.push(json!({"label": related.message, "range": range(&related.location, fs)?}));
        }
    }
    message(
        output,
        1,
        &json!({
            "kind": 0, "range": range(&diagnostic.location, fs)?,
            "rule": format!("effecttsgo/{}", kebab(diagnostic.name)),
            "message": {"id": format!("TS{}", diagnostic.code), "description": diagnostic.message},
            "file_path": file_path, "labeled_ranges": labels,
        }),
    )
}

fn report_program(
    diagnostic: &CompilerDiagnostic,
    fs: &dyn FS,
    project: &str,
    output: &mut dyn Write,
) -> Result<(), String> {
    let location = diagnostic.location.as_ref();
    message(
        output,
        1,
        &json!({
            "kind": 1, "range": location.map(|location| range(location, fs)).transpose()?,
            "message": {"id": "tsconfig-error", "description": "Invalid tsconfig", "help": diagnostic.message},
            "file_path": location.map(|location| location.file.as_str()).unwrap_or(project),
        }),
    )
}

fn original_backend() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("EFFECT_TSRS_OXLINT_DELEGATE") {
        return Ok(path.into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut name = executable.as_os_str().to_os_string();
    name.push(".effect-tsrs-original");
    let original = PathBuf::from(name);
    if original.is_file() {
        Ok(original)
    } else {
        Err("Original tsgolint backend is missing; run effect-tsrs patch --oxlint again".into())
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let threads = std::env::var("EFFECT_TSRS_THREADS")
        .ok()
        .map(|value| {
            value
                .parse::<NonZeroUsize>()
                .map_err(|_| "EFFECT_TSRS_THREADS must be a positive integer".to_string())
        })
        .transpose()?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let payload: Payload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Oxlint request: {error}"))?;
    if payload.version != 2 {
        return Err(format!(
            "Unsupported Oxlint protocol version {} (expected 2)",
            payload.version
        ));
    }
    let mut ordinary = payload.clone();
    let names: BTreeMap<String, Rule> = Rule::ALL
        .into_iter()
        .map(|rule| (format!("effecttsgo/{}", kebab(rule.name())), rule))
        .collect();
    let cwd = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut selected: BTreeMap<String, Vec<Rule>> = BTreeMap::new();
    let mut filenames = BTreeMap::new();
    for config in &payload.configs {
        let mut effect_rules = Vec::new();
        for rule in &config.rules {
            if let Some(effect) = names.get(&rule.name) {
                effect_rules.push(*effect);
            } else if rule.name.starts_with("effecttsgo/") {
                return Err(format!("Unknown Effect rule {}", rule.name));
            }
        }
        for file in &config.file_paths {
            filenames.insert(
                path_key(file, &cwd),
                tspath::get_normalized_absolute_path(file, &cwd),
            );
            if !effect_rules.is_empty() {
                selected.insert(path_key(file, &cwd), effect_rules.clone());
            }
        }
    }
    for config in &mut ordinary.configs {
        config.rules.retain(|rule| !names.contains_key(&rule.name));
    }
    let delegate = ordinary.report_semantic
        || ordinary.report_syntactic
        || ordinary
            .configs
            .iter()
            .any(|config| !config.rules.is_empty());

    // A requested limit is shared across engines, not a separate allowance
    // for each. Keep their passes sequential when the caller sets a limit.
    if threads.is_some() {
        let effects = run_effects(&payload, selected, filenames, cwd, !delegate, threads);
        let generic = if delegate {
            run_original(&ordinary, args).and_then(|bytes| {
                std::io::stdout()
                    .write_all(&bytes)
                    .map_err(|e| e.to_string())
            })
        } else {
            Ok(())
        };
        return effects.and(generic);
    }

    // Each engine owns its checker. Run them concurrently, buffering the
    // delegate's frames so their writes cannot interleave with Rust's frames.
    std::thread::scope(|scope| {
        let worker = delegate.then(|| scope.spawn(|| run_original(&ordinary, args)));
        let effects = run_effects(&payload, selected, filenames, cwd, !delegate, None);
        let generic = if let Some(worker) = worker {
            worker
                .join()
                .map_err(|_| "Oxlint delegate thread panicked".to_string())?
                .and_then(|bytes| {
                    std::io::stdout()
                        .write_all(&bytes)
                        .map_err(|e| e.to_string())
                })
        } else {
            Ok(())
        };
        effects.and(generic)
    })
}

fn run_effects(
    payload: &Payload,
    selected: BTreeMap<String, Vec<Rule>>,
    filenames: BTreeMap<String, String>,
    cwd: String,
    report_config: bool,
    threads: Option<NonZeroUsize>,
) -> Result<(), String> {
    let source_overrides = payload
        .source_overrides
        .as_ref()
        .cloned()
        .unwrap_or_default();
    let mut overrides: BTreeMap<String, String> = source_overrides
        .iter()
        .map(|(file, text)| (path_key(file, &cwd), text.clone()))
        .collect();
    let base: Arc<dyn FS> = Arc::new(bundled::wrap_fs(osvfs::fs()));
    // Keep editor buffers visible after the compiler canonicalizes a symlink.
    for (file, text) in &source_overrides {
        overrides.insert(path_key(&base.realpath(file), &cwd), text.clone());
    }
    let fs: Arc<dyn FS> = Arc::new(Overlay {
        base: Arc::clone(&base),
        cwd: cwd.clone(),
        files: overrides.clone(),
    });
    let mut resolver = Resolver::new(ConfigHost {
        cwd: cwd.clone(),
        fs: Arc::clone(&fs),
    });
    let mut groups: BTreeMap<Option<String>, BTreeMap<String, Vec<Rule>>> = BTreeMap::new();
    for (file, rules) in selected {
        groups
            .entry(resolver.find(&filenames[&file])?)
            .or_default()
            .insert(file, rules);
    }
    let mut output = std::io::BufWriter::new(std::io::stdout());
    for (project, files) in groups {
        let is_inferred = project.is_none();
        let project = project.unwrap_or_else(|| format!("{cwd}/.effect-tsrs-oxlint-inferred.json"));
        let fs: Arc<dyn FS> = if is_inferred {
            let mut inferred = overrides.clone();
            inferred.insert(path_key(&project, &cwd), json!({"compilerOptions": {"allowJs": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022", "jsx": "react-jsx", "allowImportingTsExtensions": true, "strictNullChecks": true, "strictFunctionTypes": true, "esModuleInterop": true, "resolveJsonModule": true, "noEmit": true}, "files": files.keys().map(|key| &filenames[key]).collect::<Vec<_>>()}).to_string());
            Arc::new(Overlay {
                base: Arc::clone(&base),
                cwd: cwd.clone(),
                files: inferred,
            })
        } else {
            Arc::clone(&fs)
        };
        let mut rules = Vec::new();
        for rule in files.values().flatten() {
            if !rules.contains(rule) {
                rules.push(*rule);
            }
        }
        let result = check_with_fs(
            CheckOptions {
                type_check: false,
                project: project.clone().into(),
                rules: Some(rules),
                lspconfig: None,
                single_threaded: false,
            },
            Arc::clone(&fs),
            Some(&files),
            threads,
        )?;
        for diagnostic in result.diagnostics {
            let file = &filenames[&path_key(&diagnostic.location.file, &cwd)];
            report_effect(&diagnostic, &*fs, file, &mut output)?;
        }
        if report_config {
            for diagnostic in result.program_diagnostics {
                report_program(&diagnostic, &*fs, &project, &mut output)?;
            }
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn run_original(ordinary: &Payload, args: &[String]) -> Result<Vec<u8>, String> {
    let backend = original_backend()?;
    if std::fs::canonicalize(&backend).ok()
        == std::env::current_exe()
            .ok()
            .and_then(|p| std::fs::canonicalize(p).ok())
    {
        return Err("Oxlint delegate points to the Rust adapter itself".into());
    }
    let mut child = Command::new(backend)
        .arg("headless")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| error.to_string())?;
    let sent = serde_json::to_writer(child.stdin.take().ok_or("Missing backend stdin")?, ordinary);
    let mut output = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or("Missing backend stdout")?
        .read_to_end(&mut output);
    let status = child.wait().map_err(|error| error.to_string())?;
    sent.map_err(|error| error.to_string())?;
    read.map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("Original tsgolint backend failed: {status}"));
    }
    Ok(output)
}

/// Runs a single headless request on the compiler's required large stack.
pub fn run_headless(args: Vec<String>) -> i32 {
    let result = std::thread::Builder::new()
        .name("effect-tsrs-oxlint".into())
        .stack_size(512 << 20)
        .spawn(move || run(&args));
    let result = result
        .map_err(|error| error.to_string())
        .and_then(|thread| {
            thread
                .join()
                .map_err(|_| "Rust Oxlint backend panicked".into())
        })
        .and_then(|result| result);
    match result {
        Ok(()) => 0,
        Err(error) => {
            let _ = message(&mut std::io::stdout(), 0, &json!({"error": error}));
            eprintln!("effect-tsrs Oxlint: {error}");
            1
        }
    }
}
