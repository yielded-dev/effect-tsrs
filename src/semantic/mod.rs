mod context;
pub(crate) mod flow;
pub(crate) use flow::*;
mod symbols;
mod types;

use std::collections::HashMap;
use std::sync::Arc;

use tsrs_ast::{Node, SourceFile, Symbol};
use tsrs_checker::Type;
use tsrs_core::P;

type TypePair = (P<Type>, P<Type>);
type PackageMetadata = Option<Arc<serde_json::Value>>;

/// Immutable package metadata shared by every file analysis in one program.
/// Built once before the Effect pass, so checker threads read it without locks.
pub(crate) struct PackageCache {
    files: HashMap<P<SourceFile>, PackageMetadata>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Channels {
    pub a: P<Type>,
    pub e: P<Type>,
    pub r: P<Type>,
}

#[derive(Clone, Copy, Default)]
struct ContextInfo {
    flags: u8,
    generator: Option<P<Node>>,
}

/// All caches are scoped to a RuleContext and its checker. No compiler arena
/// handles are retained after the analysis of the file completes.
#[derive(Default)]
pub(crate) struct SemanticState {
    pub flows: Option<Vec<PipingFlow>>,
    pub flows_with_fn: Option<Vec<PipingFlow>>,
    pub pipeable_shapes: HashMap<
        (
            P<tsrs_checker::Signature>,
            P<tsrs_checker::Signature>,
            usize,
        ),
        bool,
    >,
    types: HashMap<P<Node>, P<Type>>,
    symbols: HashMap<P<Node>, Option<P<Symbol>>>,
    references: HashMap<P<Node>, Option<P<Symbol>>>,
    api_matches: HashMap<(P<Symbol>, String, String, String), bool>,
    module_matches: HashMap<(P<SourceFile>, String), bool>,
    effects: HashMap<P<Type>, Option<Channels>>,
    streams: HashMap<P<Type>, Option<Channels>>,
    layers: HashMap<P<Type>, Option<Channels>>,
    schemas: HashMap<P<Type>, Option<TypePair>>,
    services: HashMap<P<Type>, Option<TypePair>>,
    context_tags: HashMap<P<Type>, Option<TypePair>>,
    scopes: HashMap<P<Type>, bool>,
    global_errors: HashMap<P<Type>, bool>,
    yieldable_errors: HashMap<P<Type>, bool>,
    yieldable_error_type: Option<Option<P<Type>>>,
    promises: HashMap<P<Type>, Option<P<Type>>>,
    contexts: HashMap<P<Node>, ContextInfo>,
    context_files: HashMap<P<SourceFile>, bool>,
    gen_functions: HashMap<P<Node>, Option<P<Node>>>,
}
