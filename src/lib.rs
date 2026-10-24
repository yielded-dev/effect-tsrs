//! A short-lived, single-project diagnostic runner over the native tsrs checker.
//!
//! The compiler's default arenas live until process exit. This entry point is for
//! CLI processes, not repeated project rebuilds in a language server.

mod config;
mod overlay;
pub mod oxlint;
mod project;
mod rules;

use std::path::PathBuf;

use serde::Serialize;

mod registry;
pub use registry::Rule;
pub(crate) mod semantic;

pub(crate) struct EffectVersion {
    pub major: u8,
    pub exact: Option<String>,
}

impl EffectVersion {
    pub fn supported(&self) -> u8 {
        if self.major == 4 { 4 } else { 3 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Message,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Message => "message",
        }
    }
}

#[derive(Debug)]
pub struct CheckOptions {
    pub project: PathBuf,
    /// None uses configured defaults; an empty list disables Effect analysis.
    pub rules: Option<Vec<Rule>>,
    /// JSON options replacing tsconfig plugin options.
    pub lspconfig: Option<String>,
    /// Disable parallel parsing and checking, overriding the project setting.
    pub single_threaded: bool,
}

impl Default for CheckOptions {
    fn default() -> Self {
        Self {
            project: PathBuf::from("tsconfig.json"),
            rules: None,
            lspconfig: None,
            single_threaded: false,
        }
    }
}

/// Offsets and lengths are UTF-16 code units. Lines and columns are one-based.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub file: String,
    pub start: usize,
    pub length: usize,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Serialize)]
pub struct Diagnostic {
    #[serde(flatten)]
    pub location: Location,
    pub severity: Severity,
    pub code: i32,
    pub name: &'static str,
    pub message: String,
    #[serde(rename = "relatedInformation", skip_serializing_if = "Vec::is_empty")]
    pub related_information: Vec<RelatedDiagnostic>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RelatedDiagnostic {
    #[serde(flatten)]
    pub location: Location,
    pub code: i32,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompilerDiagnostic {
    pub code: i32,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files_checked: usize,
    pub errors: usize,
    pub warnings: usize,
    pub messages: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub config_ms: f64,
    pub program_ms: f64,
    pub typescript_ms: f64,
    pub effect_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub diagnostics: Vec<Diagnostic>,
    pub typescript_diagnostics: Vec<CompilerDiagnostic>,
    pub summary: Summary,
    pub timings: Timings,
    #[serde(skip)]
    pub(crate) program_diagnostics: Vec<CompilerDiagnostic>,
}

impl CheckResult {
    pub fn has_errors(&self) -> bool {
        self.summary.errors != 0
            || self
                .typescript_diagnostics
                .iter()
                .any(|d| d.severity == Severity::Error)
    }
}

/// Checks one project on the large stack required by the recursive tsrs checker.
/// All checking and rule evaluation run natively in this process.
pub fn check_project(options: CheckOptions) -> Result<CheckResult, String> {
    std::thread::Builder::new()
        .name("effect-tsrs".into())
        .stack_size(512 << 20)
        .spawn(move || project::check(options))
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "tsrs compiler panicked (see stderr)".to_string())?
}
