use std::io::{self, Write};

use effect_tsrs::{CheckOptions, Location, Rule, Severity, check_project};

#[global_allocator]
static ALLOCATOR: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

fn main() {
    #[cfg(target_os = "linux")]
    tsrs_core::allocator::init_mimalloc();
    if std::env::args().nth(1).as_deref() == Some("headless") {
        std::process::exit(effect_tsrs::oxlint::run_headless(
            std::env::args().skip(2).collect(),
        ));
    }
    std::process::exit(run().unwrap_or_else(|error| {
        eprintln!("effect-tsrs: {error}");
        2
    }));
}

fn run() -> Result<i32, String> {
    let mut options = CheckOptions::default();
    let mut json = false;
    let mut strict = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "diagnostics" => {}
            "--strict" => strict = true,
            "--type-check" => options.type_check = true,
            "--singleThreaded" => options.single_threaded = true,
            "-p" | "--project" => {
                options.project = args.next().ok_or("--project requires a path")?.into();
            }
            "--format" => match args.next().as_deref() {
                Some("json") => json = true,
                Some("text") => json = false,
                _ => return Err("--format must be json or text".into()),
            },
            "--rules" => {
                let names = args
                    .next()
                    .ok_or("--rules requires a comma-separated list, all, or none")?;
                let mut rules = Vec::new();
                if names == "all" {
                    rules.extend(Rule::ALL);
                } else if names != "none" {
                    for name in names.split(',') {
                        let rule = Rule::ALL
                            .into_iter()
                            .find(|r| r.name() == name)
                            .ok_or_else(|| format!("unsupported rule: {name}"))?;
                        if !rules.contains(&rule) {
                            rules.push(rule);
                        }
                    }
                }
                options.rules = Some(rules);
            }
            "--lspconfig" => {
                options.lspconfig = Some(args.next().ok_or("--lspconfig requires a JSON object")?)
            }
            "-h" | "--help" => {
                println!(
                    "effect-tsrs diagnostics [-p tsconfig.json] [--format text|json] [--strict]\n\
                          \n\
                          Native Effect diagnostics for v3 and v4, powered by tsrs.\n\
                          --rules all|none|name[,name...] selects from all 130 rules.\n\
                          Default: configured root files, Effect plugin options and original rule severities.\n\
                          --lspconfig JSON replaces the tsconfig plugin options.\n\
                          --singleThreaded uses one thread for parsing and checking.\n\
                          --strict makes warnings fail the command without changing their severity.\n\
                          --type-check also reports ordinary TypeScript errors.\n\
                          Use --type-check --rules none to check TypeScript without Effect analysis.\n\
                          Exit: 0 success, 1 project/diagnostic errors or warnings with --strict, 2 invalid arguments."
                );
                return Ok(0);
            }
            "-V" | "--version" => {
                println!(
                    "effect-tsrs {} (tsrs 8f135f106a63)",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(0);
            }
            _ => return Err(format!("unknown argument: {arg}; use --help")),
        }
    }
    let result = match check_project(options) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("effect-tsrs: {error}");
            return Ok(1);
        }
    };
    let exit = i32::from(
        result.has_errors()
            || (strict
                && (result.summary.warnings != 0
                    || result
                        .typescript_diagnostics
                        .iter()
                        .any(|d| d.severity == Severity::Warning))),
    );
    let mut output = io::BufWriter::new(io::stdout().lock());
    if json {
        serde_json::to_writer_pretty(&mut output, &result).map_err(|e| e.to_string())?;
        writeln!(output).map_err(|e| e.to_string())?;
    } else {
        for diagnostic in &result.typescript_diagnostics {
            if let Some(location) = &diagnostic.location {
                write_location(&mut output, location).map_err(|e| e.to_string())?;
            }
            writeln!(
                output,
                "{} TS{}: {}",
                diagnostic.severity.as_str(),
                diagnostic.code,
                diagnostic.message
            )
            .map_err(|e| e.to_string())?;
        }
        for diagnostic in &result.diagnostics {
            write_location(&mut output, &diagnostic.location).map_err(|e| e.to_string())?;
            writeln!(
                output,
                "{} TS{}: {} effect({})",
                diagnostic.severity.as_str(),
                diagnostic.code,
                diagnostic.message,
                diagnostic.name
            )
            .map_err(|e| e.to_string())?;
            for related in &diagnostic.related_information {
                write!(output, "  ").map_err(|e| e.to_string())?;
                write_location(&mut output, &related.location).map_err(|e| e.to_string())?;
                writeln!(output, "TS{}: {}", related.code, related.message)
                    .map_err(|e| e.to_string())?;
            }
        }
        writeln!(output, "{} files checked; {} Effect errors, {} warnings, {} suggestions; {} TypeScript diagnostics.",
            result.summary.files_checked, result.summary.errors, result.summary.warnings,
            result.summary.messages, result.typescript_diagnostics.len()).map_err(|e| e.to_string())?;
    }
    output.flush().map_err(|e| e.to_string())?;
    Ok(exit)
}

fn write_location(output: &mut impl Write, location: &Location) -> io::Result<()> {
    write!(
        output,
        "{}({},{}): ",
        location.file, location.line, location.column
    )
}
