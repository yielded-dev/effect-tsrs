use std::sync::{Arc, Mutex};
use std::time::Instant;

use tsrs_ast::SourceFile;
use tsrs_compiler::{
    Program, ProgramOptions, diagnosticwriter, new_compiler_host, new_program,
    sort_and_deduplicate_diagnostics,
};
use tsrs_core::{P, TextRange, Tristate, context::Context};
use tsrs_tsoptions::{ParseConfigHost, ParsedCommandLine, get_parsed_command_line_of_config_file};
use tsrs_vfs::{FS, bundled, osvfs};

use crate::{
    CheckOptions, CheckResult, CompilerDiagnostic, Diagnostic, Location, RelatedDiagnostic,
    Severity,
    config::{self as effect_config, FileConfiguration},
    rules::{self, RuleDiagnostic},
    semantic::PackageCache,
};

pub(crate) struct ConfigHost {
    pub cwd: String,
    pub fs: Arc<dyn FS>,
}

impl ParseConfigHost for ConfigHost {
    fn fs(&self) -> &dyn FS {
        &*self.fs
    }

    fn get_current_directory(&self) -> &str {
        &self.cwd
    }
}

pub(crate) fn check(options: CheckOptions) -> Result<CheckResult, String> {
    check_with_fs(options, Arc::new(bundled::wrap_fs(osvfs::fs())), None, None)
}

fn configure_threads(
    config: &mut ParsedCommandLine,
    single_threaded: bool,
    checker_limit: Option<std::num::NonZeroUsize>,
) {
    if !single_threaded && checker_limit.is_none() {
        return;
    }
    let mut options = (*config.compiler_options().expect("parsed compiler options")).clone();
    if single_threaded || checker_limit.is_some_and(|limit| limit.get() == 1) {
        options.single_threaded = Tristate::True;
    }
    if let Some(limit) = checker_limit {
        let limit = i64::try_from(limit.get()).unwrap_or(i64::MAX);
        options.checkers = Some(options.checkers.unwrap_or(limit).min(limit));
    }
    config.set_compiler_options(P::new(options));
}

pub(crate) fn check_with_fs(
    options: CheckOptions,
    fs: Arc<dyn FS>,
    file_rules: Option<&std::collections::BTreeMap<String, Vec<crate::Rule>>>,
    checker_limit: Option<std::num::NonZeroUsize>,
) -> Result<CheckResult, String> {
    let total_start = Instant::now();
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut path = cwd.join(&options.project);
    if path.is_dir() {
        path.push("tsconfig.json");
    }
    let cwd = cwd.to_string_lossy().into_owned();
    let host = ConfigHost {
        cwd: cwd.clone(),
        fs: Arc::clone(&fs),
    };
    let mut result = CheckResult::default();
    let start = Instant::now();
    let (config, fatal) =
        get_parsed_command_line_of_config_file(&path.to_string_lossy(), None, None, &host, None);
    result.timings.config_ms = start.elapsed().as_secs_f64() * 1000.0;
    result
        .typescript_diagnostics
        .extend(fatal.into_iter().map(compiler_diagnostic));
    let Some(mut config) = config else {
        result.timings.total_ms = total_start.elapsed().as_secs_f64() * 1000.0;
        return Ok(result);
    };
    configure_threads(&mut config, options.single_threaded, checker_limit);
    let configuration = if file_rules.is_some() {
        effect_config::resolve_oxlint(&config, options.rules.as_deref().unwrap_or_default())?
    } else {
        effect_config::resolve(
            &config,
            options.lspconfig.as_deref(),
            options.rules.as_deref(),
        )?
    };
    result.timings.config_ms = start.elapsed().as_secs_f64() * 1000.0;
    result
        .typescript_diagnostics
        .extend(configuration.diagnostics().iter().map(|diagnostic| {
            CompilerDiagnostic {
                code: diagnostic.code,
                severity: diagnostic.severity,
                message: diagnostic.message.clone(),
                location: diagnostic
                    .file
                    .zip(diagnostic.range)
                    .map(|(file, range)| location(file, range)),
            }
        }));

    let start = Instant::now();
    let compiler_host = new_compiler_host(&cwd, fs, &bundled::default_lib_path(), None, None, None);
    let mut program_options = ProgramOptions::new(P::new(config), compiler_host);
    program_options.canonical_diagnostics = false;
    if file_rules.is_some() {
        program_options.use_source_of_project_reference = true;
    }
    // Keep the AST and checker alive for the Effect pass after checking.
    // ProgramOptions::new already disables leaf reclamation and checker recycling.
    let program = new_program(program_options);
    result.timings.program_ms = start.elapsed().as_secs_f64() * 1000.0;
    let context = Context::background();

    let start = Instant::now();
    let mut compiler_errors = program.get_config_file_parsing_diagnostics();
    compiler_errors.extend(program.get_program_diagnostics());
    if file_rules.is_some() {
        result
            .program_diagnostics
            .extend(compiler_errors.iter().copied().map(compiler_diagnostic));
        if !compiler_errors.is_empty() {
            return Ok(result);
        }
    } else {
        compiler_errors.extend(program.get_syntactic_diagnostics(&context, None));
        compiler_errors.extend(program.get_global_diagnostics(&context));
        compiler_errors.extend(program.get_semantic_diagnostics(&context, None));
    }
    result.timings.typescript_ms += start.elapsed().as_secs_f64() * 1000.0;

    let start = Instant::now();
    let mut files = Vec::new();
    let mut file_configs = Vec::new();
    for &file in program.source_files() {
        if file.is_declaration_file() || program.is_source_file_from_external_library(file) {
            continue;
        }
        let requested = file_rules
            .and_then(|files| files.get(&crate::overlay::path_key(file.file_name(), &cwd)));
        if file_rules.is_some() && requested.is_none() {
            continue;
        }
        let mut file_config = configuration.for_file(file);
        if let Some(requested) = requested {
            file_config.enabled.retain(|rule| requested.contains(rule));
        }
        files.push(file);
        file_configs.push(file_config);
    }
    result.summary.files_checked = files.len();
    let analyses = analyze_files(program, &files, &file_configs);
    for (mut file_config, found) in file_configs.into_iter().zip(analyses) {
        for found in found {
            let Some(severity) = file_config.severity(
                found.rule,
                found
                    .range
                    .source_pos()
                    .expect("diagnostic source position"),
            ) else {
                continue;
            };
            result.diagnostics.push(Diagnostic {
                location: location(found.file, found.range),
                severity,
                code: found.code,
                name: found.rule.name(),
                message: found.message,
                related_information: found
                    .related
                    .into_iter()
                    .map(|related| RelatedDiagnostic {
                        location: location(related.file, related.range),
                        code: related.code,
                        message: related.message,
                    })
                    .collect(),
            });
        }
        for diagnostic in file_config.finish() {
            result.diagnostics.push(Diagnostic {
                location: location(
                    diagnostic.file.expect("directive source file"),
                    diagnostic.range.expect("directive source range"),
                ),
                severity: diagnostic.severity,
                code: diagnostic.code,
                name: diagnostic.name,
                message: diagnostic.message,
                related_information: Vec::new(),
            });
        }
    }
    result.timings.effect_ms = start.elapsed().as_secs_f64() * 1000.0;
    result.typescript_diagnostics.extend(
        sort_and_deduplicate_diagnostics(&compiler_errors)
            .into_iter()
            .map(compiler_diagnostic),
    );
    result
        .diagnostics
        .sort_by(|a, b| diagnostic_key(a).cmp(&diagnostic_key(b)));
    // The compiler merges equal diagnostics; Oxlint preserves each emission.
    if file_rules.is_none() {
        result.diagnostics.dedup_by(|later, earlier| {
            if diagnostic_key(later) != diagnostic_key(earlier) {
                return false;
            }
            earlier
                .related_information
                .append(&mut later.related_information);
            earlier.related_information.sort_by(|a, b| {
                (
                    &a.location.file,
                    a.location.start,
                    a.location.length,
                    a.code,
                    &a.message,
                )
                    .cmp(&(
                        &b.location.file,
                        b.location.start,
                        b.location.length,
                        b.code,
                        &b.message,
                    ))
            });
            earlier.related_information.dedup();
            true
        });
    }
    for diagnostic in &result.diagnostics {
        match diagnostic.severity {
            Severity::Error => result.summary.errors += 1,
            Severity::Warning => result.summary.warnings += 1,
            Severity::Message => result.summary.messages += 1,
        }
    }
    result.timings.total_ms = total_start.elapsed().as_secs_f64() * 1000.0;
    Ok(result)
}

fn diagnostic_key(d: &Diagnostic) -> (&str, usize, usize, i32, &str, &str, &str) {
    (
        &d.location.file,
        d.location.start,
        d.location.length,
        d.code,
        d.severity.as_str(),
        d.name,
        &d.message,
    )
}

/// Runs each file's enabled rules on the checker that checked it, one thread per
/// checker, like the compiler's own diagnostic passes. Results follow `files`.
fn analyze_files(
    program: &'static Program,
    files: &[P<SourceFile>],
    configs: &[FileConfiguration],
) -> Vec<Vec<RuleDiagnostic>> {
    let found: Vec<Mutex<Vec<RuleDiagnostic>>> = files.iter().map(|_| Mutex::default()).collect();
    if configs.iter().any(|config| !config.enabled.is_empty()) {
        let packages = PackageCache::new(program);
        let effect_version = detect_effect_version(program, &packages);
        let ran = program.for_each_checker_group(files, |checker, index, file| {
            let config = &configs[index];
            if config.enabled.is_empty() {
                return;
            }
            *found[index].lock().unwrap() = rules::analyze_file(
                checker,
                program,
                file,
                &config.enabled,
                &config.options,
                &effect_version,
                &packages,
            );
        });
        assert!(ran, "programs from new_program own their checker pool");
    }
    found
        .into_iter()
        .map(|found| found.into_inner().unwrap())
        .collect()
}

/// Preserve raw and exact detection; helpers choose the upstream fallback.
fn detect_effect_version(program: &Program, packages: &PackageCache) -> crate::EffectVersion {
    let mut detected = None;
    let mut exact = None;
    let mut conflicting_versions = false;
    for &file in program.source_files() {
        let Some(package) = packages.get(file) else {
            continue;
        };
        if package["name"] != "effect" {
            continue;
        }
        let major = match package["version"]
            .as_str()
            .and_then(|version| version.as_bytes().first())
        {
            Some(b'3') => 3,
            Some(b'4') => 4,
            _ => 0,
        };
        detected = Some(if detected.is_some_and(|version| version != major) {
            0
        } else {
            major
        });
        if let Some(version) = package["version"].as_str() {
            if exact.as_deref().is_some_and(|previous| previous != version) {
                conflicting_versions = true;
            } else {
                exact = Some(version.to_string());
            }
        }
    }
    crate::EffectVersion {
        major: detected.unwrap_or(0),
        exact: if conflicting_versions { None } else { exact },
    }
}

fn location(file: P<SourceFile>, range: TextRange) -> Location {
    let start = range
        .source_pos()
        .expect("diagnostics have source positions");
    let end = range
        .source_end()
        .expect("diagnostics have source positions");
    let (line, column) =
        tsrs_scanner::get_ecma_line_and_utf16_character_of_position(file.get(), start);
    let (end_line, end_column) =
        tsrs_scanner::get_ecma_line_and_utf16_character_of_position(file.get(), end);
    let text = file.text();
    Location {
        file: file.file_name().to_string(),
        start: text[..start as usize].encode_utf16().count(),
        length: text[start as usize..end as usize].encode_utf16().count(),
        line: line + 1,
        column: column as usize + 1,
        end_line: end_line + 1,
        end_column: end_column as usize + 1,
    }
}

fn compiler_diagnostic(d: P<tsrs_ast::Diagnostic>) -> CompilerDiagnostic {
    CompilerDiagnostic {
        code: d.code(),
        severity: match d.category() {
            tsrs_diagnostics::Category::Error => Severity::Error,
            tsrs_diagnostics::Category::Warning => Severity::Warning,
            tsrs_diagnostics::Category::Suggestion | tsrs_diagnostics::Category::Message => {
                Severity::Message
            }
        },
        message: diagnosticwriter::flatten_diagnostic_message(d, "\n"),
        location: d
            .file()
            .zip(d.loc())
            .map(|(file, range)| location(file, range)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroUsize;

    #[test]
    fn thread_limits_reach_the_compiler_pool() {
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let names: Vec<_> = (0..8)
            .map(|i| format!("{cwd}/thread-limit-{i}.ts"))
            .collect();
        let fs: Arc<dyn FS> = Arc::new(crate::overlay::Overlay {
            base: Arc::new(bundled::wrap_fs(osvfs::fs())),
            cwd: cwd.clone(),
            files: names
                .iter()
                .map(|name| {
                    (
                        crate::overlay::path_key(name, &cwd),
                        "export const n = 1;".into(),
                    )
                })
                .collect(),
        });
        for (configured, config_single, cli_single, limit, expected, single) in [
            (8, false, false, None, 8, false),
            (8, false, false, Some(1), 1, true),
            (8, false, false, Some(4), 4, false),
            (2, false, false, Some(4), 2, false),
            (8, true, false, Some(4), 1, true),
            (8, false, true, None, 1, true),
        ] {
            let mut config = tsrs_tsoptions::new_parsed_command_line(
                P::new(tsrs_core::CompilerOptions {
                    no_lib: Tristate::True,
                    checkers: Some(configured),
                    single_threaded: if config_single {
                        Tristate::True
                    } else {
                        Tristate::False
                    },
                    ..Default::default()
                }),
                names.clone(),
                Vec::new(),
                tsrs_core::tspath::ComparePathsOptions {
                    current_directory: cwd.clone(),
                    use_case_sensitive_file_names: fs.use_case_sensitive_file_names(),
                },
            );
            configure_threads(&mut config, cli_single, limit.and_then(NonZeroUsize::new));
            let host = new_compiler_host(
                &cwd,
                Arc::clone(&fs),
                &bundled::default_lib_path(),
                None,
                None,
                None,
            );
            let mut options = ProgramOptions::new(P::new(config), host);
            options.canonical_diagnostics = false;
            let program = new_program(options);
            assert_eq!(program.single_threaded(), single);
            assert_eq!(program.checker_count(), expected);
        }
    }
}
