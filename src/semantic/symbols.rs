use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use tsrs_ast::{self as ast, Kind, Node, NodeFlags, SourceFile, Symbol, SymbolFlags};
use tsrs_core::P;

use super::{PackageCache, PackageMetadata};
use crate::rules::RuleContext;

impl PackageCache {
    /// Resolves the nearest package.json of every program file. Each package
    /// directory is read and parsed once, including failed reads or parses.
    pub(crate) fn new(program: &tsrs_compiler::Program) -> Self {
        let mut directories: HashMap<String, PackageMetadata> = HashMap::new();
        let files = program
            .source_files()
            .iter()
            .map(|&file| {
                let package = Path::new(file.file_name()).parent().and_then(|directory| {
                    let package_directory = program
                        .get_nearest_ancestor_directory_with_package_json(directory.to_str()?);
                    if package_directory.is_empty() {
                        return None;
                    }
                    directories
                        .entry(package_directory)
                        .or_insert_with_key(|directory| {
                            let path = format!("{directory}/package.json");
                            let contents = program.host().fs().read_file(&path)?;
                            serde_json::from_str(&contents).ok().map(Arc::new)
                        })
                        .clone()
                });
                (file, package)
            })
            .collect();
        Self { files }
    }

    pub(crate) fn get(&self, file: P<SourceFile>) -> Option<Arc<serde_json::Value>> {
        self.files.get(&file).cloned().flatten()
    }
}

impl RuleContext<'_> {
    pub(crate) fn symbol(&mut self, node: P<Node>) -> Option<P<Symbol>> {
        if let Some(&symbol) = self.semantic.symbols.get(&node) {
            return symbol;
        }
        let symbol = if node.kind() == Kind::MetaProperty {
            None
        } else {
            let target = if node.parent().is_some_and(|parent| {
                parent.kind() == Kind::PropertyAccessExpression && parent.name() == Some(node)
            }) {
                node.parent().unwrap()
            } else {
                node
            };
            let mut parent = target.parent();
            while parent.is_some_and(|p| p.kind() == Kind::ParenthesizedExpression) {
                parent = parent.unwrap().parent();
            }
            if matches!(
                target.kind(),
                Kind::PropertyAccessExpression | Kind::ElementAccessExpression
            ) && parent.is_some_and(|p| p.kind() == Kind::DeleteExpression)
            {
                None
            } else {
                self.checker.get_symbol_at_location_exported(node)
            }
        };
        self.semantic.symbols.insert(node, symbol);
        symbol
    }

    pub(crate) fn resolve_symbol(&mut self, mut symbol: P<Symbol>) -> P<Symbol> {
        let mut seen = HashSet::new();
        while seen.insert(symbol) {
            symbol = self.checker.get_merged_symbol(symbol);
            if symbol.flags().intersects(SymbolFlags::Alias) {
                // Synthetic default aliases can have no alias declaration;
                // the public resolver panics when asked to resolve those.
                if !symbol
                    .declarations()
                    .iter()
                    .any(|&declaration| ast::is_alias_symbol_declaration(declaration))
                {
                    break;
                }
                symbol = self.checker.get_aliased_symbol(symbol);
            } else if symbol.flags().intersects(SymbolFlags::ExportValue)
                && let Some(export) = symbol.export_symbol()
            {
                symbol = export;
            } else {
                break;
            }
        }
        self.checker.get_merged_symbol(symbol)
    }

    pub(crate) fn same_symbol(&mut self, left: P<Symbol>, right: P<Symbol>) -> bool {
        self.resolve_symbol(left) == self.resolve_symbol(right)
    }

    pub(crate) fn reference_symbol(&mut self, node: P<Node>) -> Option<P<Symbol>> {
        if let Some(&symbol) = self.semantic.references.get(&node) {
            return symbol;
        }
        let mut result = self
            .symbol(node)
            .or_else(|| {
                if node.kind() == Kind::PropertyAccessExpression {
                    self.symbol(node.as_property_access_expression().name())
                } else {
                    None
                }
            })
            .map(|symbol| self.resolve_symbol(symbol));
        if node.kind() == Kind::Identifier && !ast::is_declaration_name(node) {
            let mut seen = HashSet::new();
            while let Some(symbol) = result {
                if !seen.insert(symbol) {
                    break;
                }
                let Some(declaration) = symbol.value_declaration() else {
                    break;
                };
                if declaration.kind() != Kind::VariableDeclaration
                    || !declaration.parent().is_some_and(|parent| {
                        parent.kind() == Kind::VariableDeclarationList
                            && parent.flags().intersects(NodeFlags::Const)
                    })
                {
                    break;
                }
                let Some(initializer) = declaration.as_variable_declaration().initializer() else {
                    break;
                };
                let Some(next) = self.symbol(ast::skip_parentheses(initializer)) else {
                    break;
                };
                result = Some(self.resolve_symbol(next));
            }
        }
        self.semantic.references.insert(node, result);
        result
    }

    pub(crate) fn resolve_global_symbol(&mut self, mut symbol: P<Symbol>) -> P<Symbol> {
        symbol = self.resolve_symbol(symbol);
        for _ in 0..2 {
            let Some(declaration) = symbol.value_declaration() else {
                break;
            };
            if declaration.kind() != Kind::VariableDeclaration {
                break;
            }
            let Some(initializer) = declaration.as_variable_declaration().initializer() else {
                break;
            };
            let Some(next) = self.symbol(initializer) else {
                break;
            };
            let next = self.resolve_symbol(next);
            if next == symbol {
                break;
            }
            symbol = next;
        }
        symbol
    }

    pub(crate) fn is_global(&mut self, node: P<Node>, name: &str) -> bool {
        let Some(global) =
            self.checker
                .resolve_name_exported(name, None, SymbolFlags::Value, false)
        else {
            return false;
        };
        let Some(symbol) = self.symbol(node) else {
            return false;
        };
        let symbol = self.resolve_global_symbol(symbol);
        self.same_symbol(global, symbol)
    }

    pub(crate) fn is_global_member(&mut self, node: P<Node>, global: &str, member: &str) -> bool {
        let Some(global) =
            self.checker
                .resolve_name_exported(global, None, SymbolFlags::Value, false)
        else {
            return false;
        };
        let Some(ty) = self
            .checker
            .get_type_of_symbol_at_location(global, Some(node))
        else {
            return false;
        };
        let Some(expected) = self.checker.get_property_of_type(ty, member) else {
            return false;
        };
        let Some(actual) = self.reference_symbol(node) else {
            return false;
        };
        self.same_symbol(expected, actual)
    }

    pub(crate) fn package_json(&mut self, file: P<SourceFile>) -> Option<Arc<serde_json::Value>> {
        self.packages.get(file)
    }

    pub(crate) fn is_source_file_in_package(&mut self, file: P<SourceFile>, package: &str) -> bool {
        self.package_json(file).is_some_and(|json| {
            json.get("name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(package))
        })
    }

    pub(crate) fn is_api(&mut self, node: P<Node>, module: &str, member: &str) -> bool {
        let (package, module) = if module == "SqlModel" {
            ("@effect/sql", module)
        } else {
            ("effect", module)
        };
        self.is_export(node, package, module, member)
    }

    pub(crate) fn is_package_api(&mut self, node: P<Node>, package: &str, member: &str) -> bool {
        self.is_export(node, package, "", member)
    }

    fn is_export(&mut self, node: P<Node>, package: &str, module: &str, member: &str) -> bool {
        let Some(symbol) = self.reference_symbol(node) else {
            return false;
        };
        let key = (
            symbol,
            package.to_owned(),
            module.to_owned(),
            member.to_owned(),
        );
        if let Some(&result) = self.semantic.api_matches.get(&key) {
            return result;
        }
        let result = symbol.declarations().iter().copied().any(|declaration| {
            let Some(file) = ast::get_source_file_of_node(declaration) else {
                return false;
            };
            if !self.is_source_file_in_package(file, package)
                || !self.module_file_matches(file, module)
            {
                return false;
            }
            let Some(module_symbol) = self
                .checker
                .get_symbol_of_declaration_exported(file.as_node())
            else {
                return false;
            };
            let Some(exported) = self
                .checker
                .try_get_member_in_module_exports_and_properties(member, module_symbol)
            else {
                return false;
            };
            self.same_symbol(exported, symbol)
        });
        self.semantic.api_matches.insert(key, result);
        result
    }

    pub(crate) fn is_module(&mut self, node: P<Node>, module: &str) -> bool {
        let Some(symbol) = self.reference_symbol(node) else {
            return false;
        };
        symbol.declarations().iter().copied().any(|declaration| {
            ast::get_source_file_of_node(declaration).is_some_and(|file| {
                self.is_source_file_in_package(
                    file,
                    if module == "SqlModel" {
                        "@effect/sql"
                    } else {
                        "effect"
                    },
                ) && self.module_file_matches(file, module)
            })
        })
    }

    fn module_file_matches(&mut self, file: P<SourceFile>, module: &str) -> bool {
        if module.is_empty() {
            return true;
        }
        let key = (file, module.to_owned());
        if let Some(&result) = self.semantic.module_matches.get(&key) {
            return result;
        }
        let Some(symbol) = self
            .checker
            .get_symbol_of_declaration_exported(file.as_node())
        else {
            return false;
        };
        let result = match module {
            "Effect" | "Stream" | "Layer" | "Schema" => self
                .checker
                .try_get_member_in_module_exports_and_properties(module, symbol)
                .is_some_and(|export| {
                    let export = self.resolve_symbol(export);
                    let ty = self.checker.get_declared_type_of_symbol(export);
                    match module {
                        "Effect" => self.effect_type(ty).is_some(),
                        "Stream" => self.stream_type(ty).is_some(),
                        "Layer" => self.layer_type(ty).is_some(),
                        _ => self.is_schema_type(ty),
                    }
                }),
            "Context" => self.module_has_all(
                symbol,
                &[
                    "Context",
                    if self.effect_version == 4 {
                        "Service"
                    } else {
                        "Tag"
                    },
                ],
            ),
            "Option" => self.module_has_all(symbol, &["Option", "some", "none", "isOption"]),
            "Cause" => self.module_has_all(symbol, &["Cause", "isCause", "NoSuchElementError"]),
            "Duration" => {
                self.module_has_all(symbol, &["Duration", "zero", "millis", "isDuration"])
            }
            "Predicate" => self.module_has_all(
                symbol,
                &["Predicate", "Refinement", "hasProperty", "isTagged"],
            ),
            "ParseResult" => {
                self.module_has_all(symbol, &["ParseIssue", "decodeSync", "encodeSync"])
            }
            "SchemaParser" => self.module_has_all(symbol, &["decodeEffect", "encodeEffect"]),
            "SqlModel" => {
                self.module_has_all(symbol, &["Class", "makeRepository", "makeDataLoaders"])
            }
            "Model" => {
                self.module_has_all(symbol, &["Class", "FieldOption"])
                    && ["Generated", "GeneratedByDb", "GeneratedByApp"]
                        .iter()
                        .any(|name| self.module_has_all(symbol, &[*name]))
            }
            "Data" => {
                self.module_has_all(symbol, &["TaggedError"])
                    && (self.module_has_all(symbol, &["TaggedEnum"])
                        || self.module_has_all(symbol, &["taggedEnum"]))
            }
            _ => self.module_has_all(symbol, &[module]),
        };
        self.semantic.module_matches.insert(key, result);
        result
    }

    fn module_has_all(&mut self, symbol: P<Symbol>, names: &[&str]) -> bool {
        names.iter().all(|name| {
            self.checker
                .try_get_member_in_module_exports_and_properties(name, symbol)
                .is_some()
        })
    }
}
