//! Effect plugin options and source directive resolution.
//!
//! Keep rule selection separate from severity: a selected rule that is disabled
//! in configuration can still be enabled in one section by a source directive.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::{Map, Value, json};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::{P, TextRange, tspath};
use tsrs_tsoptions::{
    CompilerOptionsValue, ExtendedConfigCache, ExtendedConfigCacheEntry, ParseConfigHost,
    ParsedCommandLine,
};
use tsrs_vfs::{FS, osvfs, vfsmatch};

use crate::{Rule, Severity};

const PLUGIN_NAME: &str = "@effect/language-service";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Level {
    Off,
    Visible(Severity),
    SkipFile,
}

impl Level {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" => Self::Off,
            "skip-file" => Self::SkipFile,
            "warning" | "warn" => Self::Visible(Severity::Warning),
            "suggestion" | "message" => Self::Visible(Severity::Message),
            // The original parser deliberately treats unknown levels as errors.
            _ => Self::Visible(Severity::Error),
        }
    }

    fn severity(self) -> Option<Severity> {
        match self {
            Self::Visible(severity) => Some(severity),
            Self::Off | Self::SkipFile => None,
        }
    }
}

pub(crate) struct Configuration {
    active: bool,
    has_plugin: bool,
    options: Value,
    selected: Vec<Rule>,
    explicit_selection: bool,
    overrides: Vec<Override>,
    include_suggestions: bool,
    skip_disabled_optimization: bool,
    diagnostics: Vec<ConfigDiagnostic>,
}

struct Override {
    include: Option<vfsmatch::SpecMatcher>,
    has_include: bool,
    exclude: Option<vfsmatch::SpecMatcher>,
    options: Value,
}

pub(crate) struct FileConfiguration {
    pub options: Value,
    pub enabled: Vec<Rule>,
    defaults: HashMap<Rule, Level>,
    directives: Directives,
    file: P<SourceFile>,
    include_suggestions: bool,
    active: bool,
}

pub(crate) struct ConfigDiagnostic {
    pub file: Option<P<SourceFile>>,
    pub range: Option<TextRange>,
    pub severity: Severity,
    pub code: i32,
    pub name: &'static str,
    pub message: String,
}

/// Resolve one plugin configuration. An explicit LSP object replaces the
/// tsconfig plugin, matching the original CLI rather than merging the two.
pub(crate) fn resolve(
    config: &ParsedCommandLine,
    lspconfig: Option<&str>,
    rules: Option<&[Rule]>,
) -> Result<Configuration, String> {
    let original_plugin = configured_plugin(config);
    let diagnostics = unknown_rule_diagnostics(config, original_plugin.as_ref());
    let plugin = match lspconfig {
        Some(raw) => {
            let decoded: Value = serde_json::from_str(raw)
                .map_err(|error| format!("Invalid JSON lsp config: {error}"))?;
            // The Go CLI accepts any JSON value; non-objects mean defaults.
            Some(decoded.as_object().cloned().unwrap_or_default())
        }
        None => original_plugin,
    };
    // Like the upstream diagnostics command, require a configured plugin or an
    // explicit CLI override. --rules is an effect-tsrs opt-in extension.
    let has_plugin = (plugin.is_some() || rules.is_some())
        && !plugin
            .as_ref()
            .is_some_and(|plugin| plugin.get("diagnosticSeverity").is_some_and(Value::is_null));
    let active = has_plugin
        && plugin.as_ref().is_none_or(|plugin| {
            plugin.get("diagnostics").and_then(Value::as_bool) != Some(false)
                && !plugin.get("diagnosticSeverity").is_some_and(Value::is_null)
        });
    let plugin = plugin.unwrap_or_default();
    let options = normalize_options(&plugin, false);
    let config_path = config
        .compiler_options()
        .map(|options| options.config_file_path.clone())
        .filter(|path| !path.is_empty())
        .or_else(|| {
            config
                .config_file
                .map(|file| file.source_file.file_name().to_string())
        })
        .unwrap_or_default();
    let base_path = if config_path.is_empty() {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned()
    } else {
        tspath::get_directory_path(&config_path)
    };
    let case_sensitive = osvfs::fs().use_case_sensitive_file_names();
    let overrides = plugin
        .get("overrides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|entry| {
            let include = string_array_lossy(entry.get("include"));
            let exclude = string_array_lossy(entry.get("exclude"));
            Override {
                has_include: !include.is_empty(),
                include: vfsmatch::new_spec_matcher(
                    &include,
                    &base_path,
                    vfsmatch::Usage::Files,
                    case_sensitive,
                ),
                exclude: vfsmatch::new_spec_matcher(
                    &exclude,
                    &base_path,
                    vfsmatch::Usage::Exclude,
                    case_sensitive,
                ),
                options: normalize_options(
                    entry
                        .get("options")
                        .and_then(Value::as_object)
                        .unwrap_or(&Map::new()),
                    true,
                ),
            }
        })
        .collect();
    Ok(Configuration {
        active,
        has_plugin,
        options,
        selected: rules
            .map(<[Rule]>::to_vec)
            .unwrap_or_else(|| Rule::ALL.to_vec()),
        explicit_selection: rules.is_some(),
        overrides,
        // This is the diagnostics command. The upstream option only filters
        // suggestions in the patched TypeScript compiler's output.
        include_suggestions: true,
        skip_disabled_optimization: plugin
            .get("skipDisabledOptimization")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        diagnostics,
    })
}

/// Oxlint owns rule selection and severity. Preserve the Effect behavior options
/// and source directives, but ignore tsconfig severity/disable settings, as the
/// upstream Oxlint runner does.
pub(crate) fn resolve_oxlint(
    config: &ParsedCommandLine,
    rules: &[Rule],
) -> Result<Configuration, String> {
    let mut plugin = configured_plugin(config).unwrap_or_default();
    plugin.insert("diagnostics".into(), json!(true));
    plugin.insert("includeSuggestionsInTsc".into(), json!(true));
    let mut levels = Map::new();
    for rule in rules {
        levels.insert(rule.name().into(), json!("error"));
    }
    levels.insert("unusedDirective".into(), json!("off"));
    levels.insert("unknownRuleName".into(), json!("off"));
    plugin.insert("diagnosticSeverity".into(), Value::Object(levels));
    if let Some(overrides) = plugin.get_mut("overrides").and_then(Value::as_array_mut) {
        for scope in overrides {
            if let Some(options) = scope.get_mut("options").and_then(Value::as_object_mut) {
                options.remove("diagnosticSeverity");
            }
        }
    }
    resolve(
        config,
        Some(&Value::Object(plugin).to_string()),
        Some(rules),
    )
}

impl Configuration {
    pub(crate) fn has_plugin(&self) -> bool {
        self.has_plugin
    }

    pub(crate) fn diagnostics(&self) -> &[ConfigDiagnostic] {
        &self.diagnostics
    }

    pub(crate) fn for_file(&self, file: P<SourceFile>) -> FileConfiguration {
        let mut options = self.options.clone();
        for scope in &self.overrides {
            if scope.has_include
                && !scope
                    .include
                    .as_ref()
                    .is_some_and(|matcher| matcher.match_string(file.file_name()))
            {
                continue;
            }
            if scope
                .exclude
                .as_ref()
                .is_some_and(|matcher| matcher.match_string(file.file_name()))
            {
                continue;
            }
            merge_override(&mut options, &scope.options);
        }
        // These getters in the Go implementation fall back after overrides, too.
        apply_getter_defaults(&mut options);
        let configured = options.get("diagnosticSeverity").and_then(Value::as_object);
        let directives = Directives::collect(file.text());
        let mut defaults = HashMap::new();
        let mut enabled = Vec::new();
        for &rule in &self.selected {
            let level = configured
                .and_then(|severities| severities.get(rule.name()))
                .and_then(Value::as_str)
                .map(Level::parse)
                .unwrap_or_else(|| match rule.default_severity() {
                    Some(severity) => Level::Visible(severity),
                    None if self.explicit_selection => Level::Visible(Severity::Warning),
                    None => Level::Off,
                });
            defaults.insert(rule, level);
            if self.active
                && !directives.skip_file(rule)
                && (self.skip_disabled_optimization
                    || self.visible(level)
                    || directives.enables(rule)
                    || (level.severity().is_some() && directives.mentions(rule)))
                && !enabled.contains(&rule)
            {
                enabled.push(rule);
            }
        }
        let active = self.active && !self.selected.is_empty() && !directives.skip_all();
        FileConfiguration {
            options,
            enabled,
            defaults,
            directives,
            file,
            include_suggestions: self.include_suggestions,
            active,
        }
    }

    fn visible(&self, level: Level) -> bool {
        match level.severity() {
            Some(Severity::Message) => self.include_suggestions,
            Some(_) => true,
            None => false,
        }
    }
}

impl FileConfiguration {
    pub(crate) fn severity(&mut self, rule: Rule, byte_start: u32) -> Option<Severity> {
        if !self.enabled.contains(&rule) {
            return None;
        }
        let line = tsrs_scanner::get_ecma_line_and_utf16_character_of_position(
            self.file.get(),
            byte_start,
        )
        .0;
        let severity = self
            .directives
            .level_and_mark_used(rule, line, *self.defaults.get(&rule)?)
            .severity()?;
        if severity == Severity::Message && !self.include_suggestions {
            None
        } else {
            Some(severity)
        }
    }

    pub(crate) fn finish(&self) -> Vec<ConfigDiagnostic> {
        if !self.active {
            return Vec::new();
        }
        let severity = self
            .options
            .get("diagnosticSeverity")
            .and_then(|map| map.get("unusedDirective"))
            .and_then(Value::as_str)
            .map(Level::parse)
            .unwrap_or(Level::Visible(Severity::Warning))
            .severity();
        let Some(severity) = severity else {
            return Vec::new();
        };
        self.directives
            .next_line
            .iter()
            .filter(|directive| {
                !directive.rules.iter().any(|rule| rule.name == "*")
                    && !self.directives.used.contains(&directive.source_line)
            })
            .map(|directive| ConfigDiagnostic {
                file: Some(self.file),
                range: Some(TextRange::new(directive.pos, directive.end)),
                severity,
                code: 377000,
                name: "unusedDirective",
                message: crate::rules::message(377000, &[]),
            })
            .collect()
    }
}

fn string_array_lossy(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn string_array(value: &Value, normalized: bool) -> Option<Value> {
    let values = value.as_array()?;
    let strings: Option<Vec<_>> = values.iter().map(Value::as_str).collect();
    Some(Value::Array(
        strings?
            .into_iter()
            .filter_map(|value| {
                let value = if normalized {
                    value.trim().to_ascii_lowercase()
                } else {
                    value.to_owned()
                };
                (!normalized || !value.is_empty()).then_some(Value::String(value))
            })
            .collect(),
    ))
}

/// Parse the diagnostic-facing subset of options using the original parser's
/// type checks; unknown editor options never affect rule execution.
fn normalize_options(input: &Map<String, Value>, is_override: bool) -> Value {
    let mut result = Map::new();
    if let Some(severities) = input.get("diagnosticSeverity").and_then(Value::as_object) {
        result.insert(
            "diagnosticSeverity".into(),
            Value::Object(
                severities
                    .iter()
                    .filter(|(_, value)| value.is_string())
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
        );
    }
    {
        let key = "extendedKeyDetection";
        if let Some(value) = input.get(key).filter(|value| value.is_boolean()) {
            result.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = input.get("pipeableMinArgCount").and_then(Value::as_f64) {
        result.insert("pipeableMinArgCount".into(), Value::from(value as i64));
    }
    if let Some(value) = input.get("keyPatterns").and_then(Value::as_array) {
        let patterns = value
            .iter()
            .filter_map(Value::as_object)
            .map(|pattern| {
                let mut parsed =
                    json!({"target":"service", "pattern":"default", "skipLeadingPath":["src/"]});
                for key in ["target", "pattern"] {
                    if let Some(value) = pattern.get(key).filter(|value| value.is_string()) {
                        parsed[key] = value.clone();
                    }
                }
                if pattern.get("skipLeadingPath").is_some_and(Value::is_array) {
                    parsed["skipLeadingPath"] =
                        json!(string_array_lossy(pattern.get("skipLeadingPath")));
                }
                parsed
            })
            .collect();
        result.insert("keyPatterns".into(), Value::Array(patterns));
    }
    for key in [
        "allowedUnstableApis",
        "allowedExperimentalApis",
        "allowedDuplicatedPackages",
        "effectFn",
        "namespaceImportPackages",
        "barrelImportPackages",
    ] {
        let Some(value) = input.get(key) else {
            continue;
        };
        let normalized = matches!(key, "namespaceImportPackages" | "barrelImportPackages");
        // Historically these two global options discard non-string entries;
        // per-file overrides and all other lists are strict.
        let parsed = if !is_override
            && matches!(key, "allowedDuplicatedPackages" | "effectFn")
            && value.is_array()
        {
            Some(json!(string_array_lossy(Some(value))))
        } else {
            string_array(value, normalized)
        };
        if let Some(value) = parsed {
            result.insert(key.into(), value);
        }
    }
    if let Some(aliases) = input.get("importAliases").and_then(Value::as_object)
        && aliases.values().all(Value::is_string)
    {
        result.insert(
            "importAliases".into(),
            Value::Object(
                aliases
                    .iter()
                    .filter_map(|(name, value)| {
                        let name = name.trim().to_ascii_lowercase();
                        (!name.is_empty()).then(|| (name, value.clone()))
                    })
                    .collect(),
            ),
        );
    }
    if let Some(mode) = input.get("topLevelNamedReexports").and_then(Value::as_str) {
        let mode = mode.to_ascii_lowercase();
        if matches!(mode.as_str(), "ignore" | "follow") {
            result.insert("topLevelNamedReexports".into(), Value::String(mode));
        }
    }
    Value::Object(result)
}

fn merge_override(target: &mut Value, patch: &Value) {
    for (key, value) in patch.as_object().into_iter().flatten() {
        if key == "diagnosticSeverity" {
            if !target.get(key).is_some_and(Value::is_object) {
                target[key] = json!({});
            }
            target[key]
                .as_object_mut()
                .unwrap()
                .extend(value.as_object().unwrap().clone());
        } else {
            target[key] = value.clone();
        }
    }
}

fn apply_getter_defaults(options: &mut Value) {
    for (key, default) in [
        ("effectFn", json!(["span"])),
        (
            "keyPatterns",
            json!([
                {"target":"service", "pattern":"default", "skipLeadingPath":["src/"]},
                {"target":"custom", "pattern":"default", "skipLeadingPath":["src/"]}
            ]),
        ),
    ] {
        if options
            .get(key)
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            options[key] = default;
        }
    }
    if options
        .get("pipeableMinArgCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        <= 0
    {
        options["pipeableMinArgCount"] = json!(2);
    }
    for key in [
        "allowedUnstableApis",
        "allowedExperimentalApis",
        "allowedDuplicatedPackages",
        "namespaceImportPackages",
        "barrelImportPackages",
    ] {
        if !options.get(key).is_some_and(Value::is_array) {
            options[key] = json!([]);
        }
    }
    if !options.get("importAliases").is_some_and(Value::is_object) {
        options["importAliases"] = json!({});
    }
    if !options
        .get("topLevelNamedReexports")
        .is_some_and(Value::is_string)
    {
        options["topLevelNamedReexports"] = json!("ignore");
    }
    if !options
        .get("extendedKeyDetection")
        .is_some_and(Value::is_boolean)
    {
        options["extendedKeyDetection"] = json!(false);
    }
}

fn to_json(value: &CompilerOptionsValue) -> Value {
    match value {
        CompilerOptionsValue::Null => Value::Null,
        CompilerOptionsValue::Bool(value) => Value::Bool(*value),
        CompilerOptionsValue::Int(value) => json!(value),
        CompilerOptionsValue::Float(value) => json!(value),
        CompilerOptionsValue::String(value) => Value::String(value.clone()),
        CompilerOptionsValue::StringArray(values) => json!(values),
        CompilerOptionsValue::Array(values) => Value::Array(values.iter().map(to_json).collect()),
        CompilerOptionsValue::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect(),
        ),
        CompilerOptionsValue::NilArray => json!([]),
        _ => Value::Null,
    }
}

fn plugin_from_raw(raw: &Value) -> Option<Map<String, Value>> {
    plugin_from_array(raw.get("compilerOptions")?.get("plugins")?)
}

fn plugin_from_array(plugins: &Value) -> Option<Map<String, Value>> {
    plugins
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .find(|plugin| plugin.get("name").and_then(Value::as_str) == Some(PLUGIN_NAME))
        .cloned()
}

fn configured_plugin(config: &ParsedCommandLine) -> Option<Map<String, Value>> {
    let raw = to_json(&config.raw);
    // CompilerOptions.plugins stores names only. The compiler's JSONC parser
    // recovers opaque plugin options, and its extension-cache callback exposes
    // the exact ordered inheritance graph, including package resolution.
    let host = InheritanceHost {
        cwd: std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let canonical = |path: &str| {
        tspath::to_path(path, &host.cwd, host.fs().use_case_sensitive_file_names()).to_string()
    };
    let mut inherited = HashMap::new();
    for path in config.extended_source_files() {
        let Some(text) = osvfs::fs().read_file(&path) else {
            continue;
        };
        let (value, _) =
            tsrs_tsoptions::parse_config_file_text_to_json(&path, Default::default(), &text);
        inherited.insert(canonical(&path), to_json(&value));
    }
    let config_path = config
        .compiler_options()
        .map(|options| options.config_file_path.clone())
        .unwrap_or_default();
    if config_path.is_empty() || inherited.is_empty() {
        return plugin_from_raw(&raw).map(|plugin| prepare_plugin(&plugin, &config_path));
    }
    let root = tspath::to_path(
        &config_path,
        &host.cwd,
        host.fs().use_case_sensitive_file_names(),
    );
    inherited.insert(root.to_string(), raw);
    let graph = InheritanceGraph::default();
    tsrs_tsoptions::parse_extended_config(&config_path, root.clone(), &[], &host, Some(&graph));
    let merged = inherited_plugins(
        &root,
        &inherited,
        &graph.edges.into_inner().unwrap_or_default(),
        &mut HashSet::new(),
    );
    merged.and_then(|value| value.as_object().cloned())
}

struct InheritanceHost {
    cwd: String,
}

impl ParseConfigHost for InheritanceHost {
    fn fs(&self) -> &dyn FS {
        osvfs::fs()
    }

    fn get_current_directory(&self) -> &str {
        &self.cwd
    }
}

#[derive(Default)]
struct InheritanceGraph {
    edges: Mutex<HashMap<String, Vec<String>>>,
}

impl ExtendedConfigCache for InheritanceGraph {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &tspath::Path,
        resolution_stack: &[tspath::Path],
        host: &dyn ParseConfigHost,
    ) -> P<ExtendedConfigCacheEntry> {
        if let Some(parent) = resolution_stack.last() {
            self.edges
                .lock()
                .unwrap()
                .entry(parent.to_string())
                .or_default()
                .push(path.to_string());
        }
        tsrs_tsoptions::parse_extended_config(
            file_name,
            path.clone(),
            resolution_stack,
            host,
            Some(self),
        )
    }
}

fn inherited_plugins(
    config_path: &str,
    inherited: &HashMap<String, Value>,
    graph: &HashMap<String, Vec<String>>,
    visiting: &mut HashSet<String>,
) -> Option<Value> {
    let raw = inherited.get(config_path)?;
    if !visiting.insert(config_path.to_owned()) {
        return None;
    }
    let mut plugin = None;
    for path in graph.get(config_path).into_iter().flatten() {
        let parent_plugin = inherited_plugins(path, inherited, graph, visiting);
        merge_plugin_branch(&mut plugin, parent_plugin, inherited.get(path)?);
    }
    if raw
        .get("compilerOptions")
        .and_then(|options| options.get("plugins"))
        .is_some()
    {
        let local =
            plugin_from_raw(raw).map(|plugin| Value::Object(prepare_plugin(&plugin, config_path)));
        merge_plugin_branch(&mut plugin, local, raw);
    }
    visiting.remove(config_path);
    plugin
}

/// Mirror effectconfigraw.MergeEffectCompilerOptions. A pass-through branch
/// carries its fully resolved options; a local Effect stanza patches only the
/// fields it declares, while severity maps merge and override lists append.
fn merge_plugin_branch(target: &mut Option<Value>, source: Option<Value>, raw: &Value) {
    let local = plugin_from_raw(raw);
    let has_plugins = raw
        .get("compilerOptions")
        .and_then(|options| options.get("plugins"))
        .is_some();
    let Some(source) = source else {
        if has_plugins {
            *target = None;
        }
        return;
    };
    if source.get("diagnosticSeverity").is_some_and(Value::is_null) {
        if has_plugins || target.is_none() {
            *target = Some(source);
        }
        return;
    }
    let Some(local) = local else {
        *target = Some(source);
        return;
    };
    let Some(existing) = target
        .as_mut()
        .filter(|value| !value.get("diagnosticSeverity").is_some_and(Value::is_null))
    else {
        *target = Some(source);
        return;
    };
    for key in local.keys() {
        if key == "name" {
            continue;
        }
        let Some(value) = source.get(key) else {
            continue;
        };
        if key == "diagnosticSeverity" && value.is_object() {
            if !existing.get(key).is_some_and(Value::is_object) {
                existing[key] = json!({});
            }
            existing[key]
                .as_object_mut()
                .unwrap()
                .extend(value.as_object().unwrap().clone());
        } else if key == "overrides" && value.is_array() {
            if !existing.get(key).is_some_and(Value::is_array) {
                existing[key] = json!([]);
            }
            existing[key]
                .as_array_mut()
                .unwrap()
                .extend(value.as_array().unwrap().iter().cloned());
        } else {
            existing[key] = value.clone();
        }
    }
}

fn prepare_plugin(raw: &Map<String, Value>, config_path: &str) -> Map<String, Value> {
    if raw.get("diagnosticSeverity").is_some_and(Value::is_null) {
        return Map::from_iter([("diagnosticSeverity".into(), Value::Null)]);
    }
    let mut parsed = normalize_options(raw, false).as_object().unwrap().clone();
    parsed
        .entry("diagnosticSeverity")
        .or_insert_with(|| json!({}));
    for key in [
        "refactors",
        "diagnostics",
        "includeSuggestionsInTsc",
        "quickinfo",
        "completions",
        "goto",
        "renames",
        "ignoreEffectSuggestionsInTscExitCode",
    ] {
        parsed.insert(
            key.into(),
            json!(raw.get(key).and_then(Value::as_bool).unwrap_or(true)),
        );
    }
    for key in [
        "ignoreEffectWarningsInTscExitCode",
        "ignoreEffectErrorsInTscExitCode",
        "skipDisabledOptimization",
        "noExternal",
        "inlays",
        "extendedKeyDetection",
    ] {
        parsed.insert(
            key.into(),
            json!(raw.get(key).and_then(Value::as_bool).unwrap_or(false)),
        );
    }
    // A present but incorrectly typed local setting still replaces the inherited
    // one with its parser default, just as an explicitly empty list does.
    for key in [
        "keyPatterns",
        "allowedUnstableApis",
        "allowedExperimentalApis",
        "allowedDuplicatedPackages",
        "effectFn",
        "namespaceImportPackages",
        "barrelImportPackages",
    ] {
        parsed.entry(key).or_insert_with(|| json!([]));
    }
    parsed.entry("importAliases").or_insert_with(|| json!({}));
    parsed
        .entry("topLevelNamedReexports")
        .or_insert_with(|| json!("ignore"));
    parsed
        .entry("pipeableMinArgCount")
        .or_insert_with(|| json!(0));
    let base = tspath::get_directory_path(config_path);
    let overrides = raw
        .get("overrides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|entry| {
            let mut scope = Map::new();
            for key in ["include", "exclude"] {
                let specs = string_array_lossy(entry.get(key))
                    .into_iter()
                    .map(|spec| {
                        if config_path.is_empty()
                            || spec.to_ascii_lowercase().starts_with("${configdir}")
                            || tspath::is_rooted_disk_path(&spec)
                        {
                            spec
                        } else {
                            tspath::get_normalized_absolute_path(&spec, &base)
                        }
                    })
                    .collect::<Vec<_>>();
                scope.insert(key.into(), json!(specs));
            }
            scope.insert(
                "options".into(),
                normalize_options(
                    entry
                        .get("options")
                        .and_then(Value::as_object)
                        .unwrap_or(&Map::new()),
                    true,
                ),
            );
            Value::Object(scope)
        })
        .collect();
    parsed.insert("overrides".into(), Value::Array(overrides));
    parsed
}

fn unknown_rule_diagnostics(
    config: &ParsedCommandLine,
    plugin: Option<&Map<String, Value>>,
) -> Vec<ConfigDiagnostic> {
    let Some(plugin) = plugin else {
        return Vec::new();
    };
    if plugin.get("diagnostics").and_then(Value::as_bool) == Some(false)
        || plugin.get("diagnosticSeverity").is_some_and(Value::is_null)
    {
        return Vec::new();
    }
    let severities = plugin.get("diagnosticSeverity").and_then(Value::as_object);
    let severity = severities
        .and_then(|map| map.get("unknownRuleName"))
        .and_then(Value::as_str)
        .map(Level::parse)
        .unwrap_or(Level::Visible(Severity::Warning))
        .severity();
    let Some(severity) = severity else {
        return Vec::new();
    };
    let file = config.config_file.map(|file| file.source_file);
    let syntax = file.and_then(plugin_syntax);
    let mut result = Vec::new();
    append_unknown_rules(
        &mut result,
        severities,
        syntax.and_then(|node| property_value(node, "diagnosticSeverity")),
        file,
        severity,
    );
    let local_overrides: Vec<_> = syntax
        .and_then(|node| property_value(node, "overrides"))
        .filter(|node| node.kind() == Kind::ArrayLiteralExpression)
        .into_iter()
        .flat_map(|node| node.elements().iter().copied())
        .filter(|node| node.kind() == Kind::ObjectLiteralExpression)
        .collect();
    if let Some(overrides) = plugin.get("overrides").and_then(Value::as_array) {
        let local_start = overrides.len().checked_sub(local_overrides.len());
        for (index, scope) in overrides.iter().enumerate() {
            let syntax = local_start
                .and_then(|start| index.checked_sub(start))
                .and_then(|index| local_overrides.get(index))
                .copied()
                .and_then(|node| property_value(node, "options"))
                .and_then(|node| property_value(node, "diagnosticSeverity"));
            append_unknown_rules(
                &mut result,
                scope
                    .get("options")
                    .and_then(|options| options.get("diagnosticSeverity"))
                    .and_then(Value::as_object),
                syntax,
                file,
                severity,
            );
        }
    }
    result
}

fn append_unknown_rules(
    result: &mut Vec<ConfigDiagnostic>,
    severities: Option<&Map<String, Value>>,
    syntax: Option<P<Node>>,
    file: Option<P<SourceFile>>,
    severity: Severity,
) {
    for name in severities.into_iter().flat_map(|map| map.keys()) {
        if matches!(name.as_str(), "unusedDirective" | "unknownRuleName")
            || Rule::ALL.iter().any(|rule| rule.name() == name)
        {
            continue;
        }
        let node = syntax
            .and_then(|syntax| property(syntax, name))
            .and_then(|property| property.name());
        let location = file.zip(node).map(|(file, node)| {
            (
                file,
                TextRange::new(
                    tsrs_scanner::skip_trivia(
                        file.text(),
                        node.pos().expect_source("config property position"),
                    ),
                    node.end().expect_source("config property end"),
                ),
            )
        });
        result.push(ConfigDiagnostic {
            file: location.map(|(file, _)| file),
            range: location.map(|(_, range)| range),
            severity,
            code: 377134,
            name: "unknownRuleName",
            message: crate::rules::message(377134, std::slice::from_ref(name)),
        });
    }
}

fn property(node: P<Node>, name: &str) -> Option<P<Node>> {
    if node.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    node.properties().iter().rev().copied().find(|node| {
        node.kind() == Kind::PropertyAssignment
            && node
                .name()
                .is_some_and(|key| ast::get_text_of_property_name(key) == name)
    })
}

fn property_value(node: P<Node>, name: &str) -> Option<P<Node>> {
    property(node, name)?.initializer()
}

fn plugin_syntax(file: P<SourceFile>) -> Option<P<Node>> {
    let root = file.as_node().statements().first()?.expression()?;
    let compiler_options = property_value(root, "compilerOptions")?;
    let plugins = property_value(compiler_options, "plugins")?;
    if plugins.kind() != Kind::ArrayLiteralExpression {
        return None;
    }
    plugins.elements().iter().copied().find(|node| {
        property_value(*node, "name").is_some_and(|name| {
            matches!(
                name.kind(),
                Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
            ) && name.text() == PLUGIN_NAME
        })
    })
}

#[derive(Default, Debug)]
struct Directives {
    file: Vec<RuleLevel>,
    next_line: Vec<Directive>,
    sections: Vec<Directive>,
    used: HashSet<usize>,
}

#[derive(Debug)]
struct Directive {
    line: usize,
    source_line: usize,
    pos: u32,
    end: u32,
    rules: Vec<RuleLevel>,
}

#[derive(Debug)]
struct RuleLevel {
    name: String,
    level: Level,
}

impl RuleLevel {
    fn matches(&self, rule: Rule) -> bool {
        self.name == "*" || self.name.eq_ignore_ascii_case(rule.name())
    }
}

impl Directives {
    fn collect(source: &str) -> Self {
        let mut result = Self::default();
        let mut offset = 0;
        for (line, text) in source.split('\n').enumerate() {
            let current_offset = offset;
            offset += text.len() + 1;
            let Some((is_next, rules, start, end)) = parse_directive_range(text) else {
                continue;
            };
            let has_skip = rules.iter().any(|rule| rule.level == Level::SkipFile);
            result.file.extend(
                rules
                    .iter()
                    .filter(|rule| rule.level == Level::SkipFile)
                    .map(|rule| RuleLevel {
                        name: rule.name.clone(),
                        level: rule.level,
                    }),
            );
            let directive = Directive {
                line: line + usize::from(is_next),
                source_line: line,
                pos: (current_offset + start) as u32,
                end: (current_offset + end) as u32,
                rules,
            };
            if is_next {
                result.next_line.push(directive);
            } else if !has_skip {
                // The source implementation discards the entire section if
                // any pair on this directive is a skip-file pair.
                result.sections.push(directive);
            }
        }
        result
    }

    fn skip_file(&self, rule: Rule) -> bool {
        self.file.iter().any(|entry| entry.matches(rule))
    }

    fn skip_all(&self) -> bool {
        self.file.iter().any(|entry| entry.name == "*")
    }

    fn mentions(&self, rule: Rule) -> bool {
        self.file.iter().any(|entry| entry.matches(rule))
            || self
                .next_line
                .iter()
                .chain(&self.sections)
                .any(|directive| directive.rules.iter().any(|entry| entry.matches(rule)))
    }

    fn enables(&self, rule: Rule) -> bool {
        self.next_line
            .iter()
            .chain(&self.sections)
            .any(|directive| {
                directive
                    .rules
                    .iter()
                    .any(|entry| entry.matches(rule) && entry.level.severity().is_some())
            })
    }

    fn level(&self, rule: Rule, line: usize, default: Level) -> Level {
        if self.skip_file(rule) {
            return Level::SkipFile;
        }
        for directive in self
            .next_line
            .iter()
            .filter(|directive| directive.line == line)
        {
            if let Some(entry) = directive.rules.iter().find(|entry| entry.matches(rule)) {
                return entry.level;
            }
        }
        for directive in self
            .sections
            .iter()
            .rev()
            .filter(|directive| directive.line <= line)
        {
            if let Some(entry) = directive.rules.iter().find(|entry| entry.matches(rule)) {
                return entry.level;
            }
        }
        default
    }

    fn level_and_mark_used(&mut self, rule: Rule, line: usize, default: Level) -> Level {
        if self.skip_file(rule) {
            return Level::SkipFile;
        }
        for directive in self
            .next_line
            .iter()
            .filter(|directive| directive.line == line)
        {
            if let Some(entry) = directive.rules.iter().find(|entry| entry.matches(rule)) {
                self.used.insert(directive.source_line);
                return entry.level;
            }
        }
        self.level(rule, line, default)
    }
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn directive_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | 0x0c)
}

/// Equivalent to the two small Go directive regular expressions, including
/// matching within strings and consuming only the first directive per line.
#[cfg(test)]
fn parse_directive(line: &str) -> Option<(bool, Vec<RuleLevel>)> {
    parse_directive_range(line).map(|(next, rules, _, _)| (next, rules))
}

fn parse_directive_range(line: &str) -> Option<(bool, Vec<RuleLevel>, usize, usize)> {
    let prefix = "@effect-diagnostics";
    for (offset, _) in line.match_indices(prefix) {
        let mut remaining = &line[offset + prefix.len()..];
        let is_next = remaining.starts_with("-next-line");
        if is_next {
            remaining = &remaining["-next-line".len()..];
        }
        if !remaining
            .as_bytes()
            .first()
            .is_some_and(|byte| directive_space(*byte))
        {
            continue;
        }
        remaining =
            remaining.trim_start_matches(|ch: char| ch.is_ascii() && directive_space(ch as u8));
        let mut length = 0;
        for byte in remaining.bytes() {
            if word(byte) || matches!(byte, b':' | b'-' | b'*') || directive_space(byte) {
                length += 1;
            } else {
                break;
            }
        }
        let bytes = &remaining.as_bytes()[..length];
        let mut cursor = 0;
        let mut rules = Vec::new();
        while cursor < bytes.len() {
            let start = cursor;
            if bytes[cursor] == b'*' {
                cursor += 1;
            } else {
                while cursor < bytes.len() && word(bytes[cursor]) {
                    cursor += 1;
                }
            }
            let name_end = cursor;
            if name_end == start || bytes.get(cursor) != Some(&b':') {
                cursor = start + 1;
                continue;
            }
            cursor += 1;
            let level_start = cursor;
            while cursor < bytes.len() && word(bytes[cursor]) {
                cursor += 1;
            }
            if cursor == level_start {
                continue;
            }
            if bytes.get(cursor) == Some(&b'-')
                && bytes.get(cursor + 1).is_some_and(|byte| word(*byte))
            {
                cursor += 1;
                while cursor < bytes.len() && word(bytes[cursor]) {
                    cursor += 1;
                }
            }
            rules.push(RuleLevel {
                name: remaining[start..name_end].to_owned(),
                level: Level::parse(&remaining[level_start..cursor]),
            });
        }
        let rules_start = line.len() - remaining.len();
        let end = rules_start
            + remaining[..length]
                .trim_end_matches(|ch: char| ch.is_ascii() && directive_space(ch as u8))
                .len();
        return (!rules.is_empty()).then_some((is_next, rules, offset, end));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directives_preserve_rule_sections_and_next_line_precedence() {
        let directives = Directives::collect(
            "// @effect-diagnostics *:off\n// @effect-diagnostics floatingEffect:warning\n// @effect-diagnostics-next-line FLOATINGEFFECT:error\nfoo\nbar\n// @effect-diagnostics floatingEffect:off\n",
        );
        assert_eq!(
            directives.level(Rule::FloatingEffect, 0, Level::Visible(Severity::Error)),
            Level::Off
        );
        assert_eq!(
            directives.level(Rule::FloatingEffect, 3, Level::Off),
            Level::Visible(Severity::Error)
        );
        assert_eq!(
            directives.level(Rule::FloatingEffect, 4, Level::Off),
            Level::Visible(Severity::Warning)
        );
        assert_eq!(
            directives.level(Rule::FloatingEffect, 6, Level::Visible(Severity::Error)),
            Level::Off
        );
        assert_eq!(
            directives.level(Rule::AsyncFunction, 4, Level::Visible(Severity::Error)),
            Level::Off
        );
        assert!(directives.enables(Rule::FloatingEffect));
        assert!(!directives.enables(Rule::AsyncFunction));
    }

    #[test]
    fn skip_file_always_wins_and_mixed_sections_are_discarded() {
        let directives = Directives::collect(
            "// @effect-diagnostics floatingEffect:skip-file asyncFunction:error\n// @effect-diagnostics-next-line floatingEffect:warning\nfoo",
        );
        assert!(directives.skip_file(Rule::FloatingEffect));
        assert_eq!(
            directives.level(Rule::FloatingEffect, 2, Level::Off),
            Level::SkipFile
        );
        assert_eq!(
            directives.level(Rule::AsyncFunction, 2, Level::Off),
            Level::Off
        );
    }

    #[test]
    fn scoped_options_replace_lists_and_merge_severity() {
        let mut base = normalize_options(json!({"effectFn":["span"],"diagnosticSeverity":{"floatingEffect":"off","asyncFunction":"error"}}).as_object().unwrap(), false);
        let scoped = normalize_options(json!({"effectFn":[],"diagnosticSeverity":{"floatingEffect":"warn"},"namespaceImportPackages":[" EFFECT ",""]}).as_object().unwrap(), true);
        merge_override(&mut base, &scoped);
        apply_getter_defaults(&mut base);
        assert_eq!(base["effectFn"], json!(["span"]));
        assert_eq!(base["namespaceImportPackages"], json!(["effect"]));
        assert_eq!(
            base["diagnosticSeverity"],
            json!({"floatingEffect":"warn","asyncFunction":"error"})
        );
        assert_eq!(base["pipeableMinArgCount"], json!(2));
    }

    #[test]
    fn invalid_directives_and_levels_match_original_parser() {
        assert!(
            parse_directive("// @effect-diagnostics-disable-next-line floatingEffect:off")
                .is_none()
        );
        assert_eq!(
            parse_directive("// @effect-diagnostics floatingEffect:mistyped")
                .unwrap()
                .1[0]
                .level,
            Level::Visible(Severity::Error)
        );
        assert_eq!(
            parse_directive("// @effect-diagnostics floatingEffect:warn asyncFunction:off")
                .unwrap()
                .1
                .len(),
            2
        );
    }

    #[test]
    fn effect_inheritance_merges_maps_and_appends_scopes_from_their_declaring_directory() {
        let configs = HashMap::from([
            (
                "/repo/app/tsconfig.json".to_owned(),
                json!({"compilerOptions":{"plugins":[{"name":PLUGIN_NAME,"diagnosticSeverity":{"globalDate":"error"},"overrides":[{"include":["test/**"],"options":{"pipeableMinArgCount":3}}]}]}}),
            ),
            (
                "/repo/base/tsconfig.json".to_owned(),
                json!({"compilerOptions":{"plugins":[{"name":PLUGIN_NAME,"pipeableMinArgCount":5,"allowedDuplicatedPackages":["effect"],"diagnosticSeverity":{"floatingEffect":"off"},"overrides":[{"include":["src/**"],"options":{"pipeableMinArgCount":4}}]}]}}),
            ),
        ]);
        let graph = HashMap::from([(
            "/repo/app/tsconfig.json".to_owned(),
            vec!["/repo/base/tsconfig.json".to_owned()],
        )]);
        let options = inherited_plugins(
            "/repo/app/tsconfig.json",
            &configs,
            &graph,
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(
            options["diagnosticSeverity"],
            json!({"floatingEffect":"off","globalDate":"error"})
        );
        assert_eq!(options["pipeableMinArgCount"], json!(5));
        assert_eq!(options["allowedDuplicatedPackages"], json!(["effect"]));
        assert_eq!(
            options["overrides"][0]["include"],
            json!(["/repo/base/src/**"])
        );
        assert_eq!(
            options["overrides"][1]["include"],
            json!(["/repo/app/test/**"])
        );
    }

    #[test]
    fn explicit_empty_plugins_clears_but_partial_effect_plugin_inherits() {
        let mut configs = HashMap::from([
            (
                "/root.json".to_owned(),
                json!({"compilerOptions":{"plugins":[]}}),
            ),
            (
                "/base.json".to_owned(),
                json!({"compilerOptions":{"plugins":[{"name":PLUGIN_NAME,"diagnostics":false,"diagnosticSeverity":{"floatingEffect":"off"}}]}}),
            ),
        ]);
        let graph = HashMap::from([("/root.json".to_owned(), vec!["/base.json".to_owned()])]);
        assert!(inherited_plugins("/root.json", &configs, &graph, &mut HashSet::new()).is_none());
        configs.get_mut("/root.json").unwrap()["compilerOptions"]["plugins"] =
            json!([{"name":PLUGIN_NAME,"pipeableMinArgCount":3}]);
        let options =
            inherited_plugins("/root.json", &configs, &graph, &mut HashSet::new()).unwrap();
        assert_eq!(options["diagnostics"], json!(false));
        assert_eq!(options["pipeableMinArgCount"], json!(3));
        assert_eq!(
            options["diagnosticSeverity"]["floatingEffect"],
            json!("off")
        );
    }

    #[test]
    fn used_next_line_suppression_tracks_ranges_and_ignores_section_directives() {
        let source = "// café\n// @effect-diagnostics-next-line floatingEffect:off   \nvalue\n// @effect-diagnostics floatingEffect:error\n";
        let mut directives = Directives::collect(source);
        let directive = &directives.next_line[0];
        assert_eq!(
            &source[directive.pos as usize..directive.end as usize],
            "@effect-diagnostics-next-line floatingEffect:off"
        );
        assert!(directives.used.is_empty());
        assert_eq!(
            directives.level_and_mark_used(
                Rule::FloatingEffect,
                2,
                Level::Visible(Severity::Error)
            ),
            Level::Off
        );
        assert!(directives.used.contains(&1));
        assert_eq!(
            directives.level_and_mark_used(Rule::FloatingEffect, 4, Level::Off),
            Level::Visible(Severity::Error)
        );
        assert_eq!(directives.used.len(), 1);
    }

    #[test]
    fn native_config_parser_preserves_partial_plugin_inheritance_and_typo_locations() {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "effect-tsrs-config-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(directory.join("base")).unwrap();
        std::fs::write(directory.join("base/tsconfig.json"), r#"{
          // JSONC must use the compiler parser.
          "files":[],"compilerOptions":{"plugins":[{"name":"@effect/language-service","pipeableMinArgCount":5,"diagnosticSeverity":{"floatingEffect":"off"},"overrides":[{"include":["src/**"],"options":{"diagnosticSeverity":{"asyncFunction":"warning"}}}]}]}
        }"#).unwrap();
        std::fs::write(directory.join("tsconfig.json"), r#"{"extends":"./base/tsconfig.json","files":[],"compilerOptions":{"plugins":[{"name":"@effect/language-service","diagnosticSeverity":{"floatingEfect":"error"}}]}}"#).unwrap();
        let host = InheritanceHost {
            cwd: directory.to_string_lossy().into_owned(),
        };
        let (parsed, _) = tsrs_tsoptions::get_parsed_command_line_of_config_file(
            "tsconfig.json",
            None,
            None,
            &host,
            None,
        );
        let parsed = parsed.unwrap();
        let plugin = configured_plugin(&parsed).unwrap();
        assert_eq!(plugin["pipeableMinArgCount"], json!(5));
        assert_eq!(plugin["diagnosticSeverity"]["floatingEffect"], json!("off"));
        assert_eq!(
            plugin["overrides"][0]["include"],
            json!([tspath::to_path(
                &format!("{}/base/src/**", host.cwd),
                &host.cwd,
                host.fs().use_case_sensitive_file_names(),
            )
            .to_string()])
        );
        let config = resolve(&parsed, None, None).unwrap();
        assert_eq!(config.diagnostics.len(), 1);
        let diagnostic = &config.diagnostics[0];
        let file = diagnostic.file.unwrap();
        let range = diagnostic.range.unwrap();
        assert_eq!(diagnostic.code, 377134);
        assert_eq!(
            &file.text()
                [range.source_pos().unwrap() as usize..range.source_end().unwrap() as usize],
            "\"floatingEfect\""
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
