mod basic;
mod catches;
mod channels;
mod generators;
mod globals;
mod schema_api;
mod schema_classes;
mod services;
mod stability_common;
mod stability_leak;
mod stability_usage;
mod transforms;

use std::collections::HashMap;
use std::sync::LazyLock;

use tsrs_ast::{Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::{P, TextRange};

use crate::{
    EffectVersion, Rule,
    semantic::{PackageCache, SemanticState},
};

pub(crate) struct RelatedDiagnostic {
    pub file: P<SourceFile>,
    pub range: TextRange,
    pub code: i32,
    pub message: String,
}

pub(crate) struct RuleDiagnostic {
    pub file: P<SourceFile>,
    pub rule: Rule,
    pub code: i32,
    pub range: TextRange,
    pub message: String,
    pub related: Vec<RelatedDiagnostic>,
}

pub(crate) struct RuleContext<'a> {
    pub checker: &'a mut Checker,
    pub program: &'static Program,
    pub file: P<SourceFile>,
    pub enabled: &'a [Rule],
    pub options: &'a serde_json::Value,
    pub effect_version: u8,
    pub detected_effect_version: u8,
    pub effect_version_string: Option<&'a str>,
    pub diagnostics: Vec<RuleDiagnostic>,
    pub semantic: SemanticState,
    pub packages: &'a PackageCache,
}

static MESSAGES: LazyLock<HashMap<i32, String>> = LazyLock::new(|| {
    let data: serde_json::Value = serde_json::from_str(include_str!("../messages.json")).unwrap();
    data.as_object()
        .unwrap()
        .iter()
        .map(|(message, value)| {
            let text = message
                .rsplit_once(" effect(")
                .map_or(message.as_str(), |(base, _)| base);
            (value["code"].as_i64().unwrap() as i32, text.to_string())
        })
        .collect()
});

pub(crate) fn message(code: i32, args: &[String]) -> String {
    let mut text = MESSAGES
        .get(&code)
        .unwrap_or_else(|| panic!("unknown Effect diagnostic code {code}"))
        .clone();
    for (i, arg) in args.iter().enumerate() {
        text = text.replace(&format!("{{{i}}}"), arg);
    }
    text
}

impl RuleContext<'_> {
    pub fn enabled(&self, rule: Rule) -> bool {
        // SupportedEffect is documentation metadata upstream, not a runner
        // filter. Individual rules and recognizers own version-specific logic.
        self.enabled.contains(&rule)
    }

    pub fn emit(&mut self, rule: Rule, node: P<Node>, code: i32, args: &[String]) -> usize {
        let file = tsrs_ast::get_source_file_of_node(node).unwrap_or(self.file);
        self.emit_range(
            rule,
            file,
            tsrs_scanner::get_error_range_for_node(file, node),
            code,
            args,
        )
    }

    pub fn emit_range(
        &mut self,
        rule: Rule,
        file: P<SourceFile>,
        range: TextRange,
        code: i32,
        args: &[String],
    ) -> usize {
        let index = self.diagnostics.len();
        self.diagnostics.push(RuleDiagnostic {
            file,
            rule,
            code,
            range,
            message: message(code, args),
            related: Vec::new(),
        });
        index
    }

    pub fn related(
        &self,
        file: P<SourceFile>,
        node: P<Node>,
        code: i32,
        args: &[String],
    ) -> RelatedDiagnostic {
        RelatedDiagnostic {
            file,
            range: tsrs_scanner::get_error_range_for_node(file, node),
            code,
            message: message(code, args),
        }
    }

    pub fn text(&self, node: P<Node>) -> String {
        let file = tsrs_ast::get_source_file_of_node(node).unwrap_or(self.file);
        let start = tsrs_scanner::get_token_pos_of_node(node, file, false) as usize;
        let end = node.end().expect_source("source node") as usize;
        file.text()[start..end].to_string()
    }

    pub fn option_bool(&self, name: &str, default: bool) -> bool {
        self.options
            .get(name)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(default)
    }
}

pub(crate) fn walk(node: P<Node>, visitor: &mut impl FnMut(P<Node>)) {
    visitor(node);
    node.for_each_child(&mut |child| {
        walk(child, visitor);
        false
    });
}

pub(crate) fn analyze_file(
    checker: &mut Checker,
    program: &'static Program,
    file: P<SourceFile>,
    enabled: &[Rule],
    options: &serde_json::Value,
    version: &EffectVersion,
    packages: &PackageCache,
) -> Vec<RuleDiagnostic> {
    let mut ctx = RuleContext {
        checker,
        program,
        file,
        enabled,
        options,
        effect_version: version.supported(),
        detected_effect_version: version.major,
        effect_version_string: version.exact.as_deref(),
        diagnostics: Vec::new(),
        semantic: SemanticState::default(),
        packages,
    };
    basic::run(&mut ctx);
    globals::run(&mut ctx);
    generators::run(&mut ctx);
    channels::run(&mut ctx);
    schema_api::run(&mut ctx);
    schema_classes::run(&mut ctx);
    services::run(&mut ctx);
    catches::run(&mut ctx);
    transforms::run(&mut ctx);
    stability_usage::run(&mut ctx);
    stability_leak::run(&mut ctx);
    ctx.diagnostics
}
