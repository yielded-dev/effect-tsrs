# Porting notes

All 130 registered diagnostic rules have native Rust implementations. The port
shares semantic helpers across rule families, supports Effect v3/v4 recognition,
and retains the source diagnostic templates. The standalone CLI and Oxlint Effect
rules execute entirely in Rust. In Oxlint mode, ordinary TypeScript rules and
`--type-check` delegate to the consumer's stock Go backend concurrently.

## Build from source

Requires rustup, a C compiler, CMake, and Node/npm. The build wrapper selects the
pinned Rust toolchain and verifies the pinned tsrs checkout and compiler patch.

```sh
rustup toolchain install 1.99.1 --profile minimal --component clippy --component rustfmt
npm ci --ignore-scripts
npm run setup
npm run build:release

./target/release/effect-tsrs diagnostics -p /path/to/tsconfig.json --format json
```

`npm run setup` creates `.repos/tsrs` at the revision in `upstream.json` and applies
`patches/checker-extensions.patch`. It preserves local changes and rejects an
unexpected revision or incompatible patch. Builds also perform this check.

## Structure

| Responsibility | Implementation |
| --- | --- |
| CLI, output formats, exit codes | `src/main.rs`, `src/lib.rs` |
| Config parsing, compiler program, checking, UTF-16 locations | `src/project.rs` |
| Oxlint headless protocol, project discovery, UTF-8 output | `src/oxlint.rs`, `src/project_resolver.rs`, `src/overlay.rs` |
| Oxlint wrapper, version validation, reversible patching | `bin/oxlint.mjs` |
| Effect options, inheritance, file overrides, directives | `src/config.rs` |
| Complete rule registry and defaults | `src/registry.rs` |
| Package/export identity, types, generator context, pipe/flow recognition | `src/semantic/` |
| Rule implementations and original messages | `src/rules/`, `src/messages.json` |
| Original fixtures, provenance, dependency locks | `fixtures/all/` |
| Exact comparison, snapshots, reference reuse, coverage | `scripts/all-rules*.mjs`, `scripts/verify-all.mjs` |

```text
tsconfig + source files
  → tsrs config parser / compiler host / Program
  → compiler checking
  → retained checker and AST + per-file Effect configuration
  → shared semantic helpers and enabled rule families
  → directive processing, duplicate compaction, UTF-16 output
```

Checking uses the compiler's checker pool, as `tsrs` does. Checker handles are
exclusive: collecting program diagnostics while holding one can deadlock. All
ordinary checking completes before the Effect pass. The Effect pass then runs
through `Program::for_each_checker_group`: one thread per checker, each file on
the checker that checked it, so the types the checker recorded for the file are
still there. Type handles and semantic caches stay within that file's analysis.
Package metadata is resolved once per program before the pass, by source file
and package directory, and then shared read-only by every checker thread.
Results are collected per file and sorted, so output does not depend on the
checker count. The tsconfig `checkers` and `singleThreaded` options apply.
The standalone `--singleThreaded` flag overrides the project setting without
modifying the config, as used by the real-project benchmark. Generated benchmarks
set `singleThreaded: true` in their tsconfig; `RAYON_NUM_THREADS=1` alone does not
limit the compiler's separate checker pool.

The runner preserves both raw detected Effect versions and the normalized version
used by upstream rules. An unknown/conflicting version is distinct from v3 where
the original recognizer makes that distinction. Supported-version labels in the
registry are documentation metadata; explicit rule guards control behavior.

## Project selection

`src/project.rs` assigns the [standalone targets](README.md#standalone-type-aware-linter)
to loaded compiler programs. `disableReferencedProjectLoad` stops target discovery
through that project's references. Ownership considers every containing program,
including membership through imports. A single containing program that does not
treat the file as a project-reference source wins; otherwise the first containing
program in canonical config-path order wins. Reference array order does not break
ties. Path identity and ordering use the compiler's canonicalization, including
its case-insensitive filename rules.

Selection does not guarantee rule evaluation. Standalone diagnostics honor the
selected program's `skip_type_checking` predicate and require JavaScript checking
to be enabled for JS/JSX files. This skips `noCheck`, `@ts-nocheck`, and redirected
project-reference sources. Declaration files, external-library files, and JSON
also receive no Effect diagnostics. These filters precede file configuration and
directive finalization, so skipped files cannot emit unused-directive warnings.
Oxlint retains its separate input-file eligibility in `src/project_resolver.rs`
and `src/project.rs`.

The standalone JSON summary counts targets before those eligibility filters:

- `totalFiles` counts distinct configured roots, including missing files.
- `filesChecked` counts targets present in their selected program with a configured
  or explicitly activated plugin. `diagnosticSeverity: null` makes a plugin absent;
  `diagnostics: false` and file eligibility skips leave this count intact.
- `filesWithoutPlugin` counts present targets without a plugin by that definition.
  An explicit `--lspconfig` suppresses this count even when it makes the plugin absent.

## Compiler extensions

The initial three-rule spike used public APIs alone. The full rule set needs a
small source patch, checked in as `patches/checker-extensions.patch`. It provides:

- Recorded failed type relations and expression types from ordinary checking.
- The contextual type retained for object literals and resolved generic arguments.
- Narrow accessors for assignment checks, constant evaluation, contextual checking,
  signature construction, concrete generic base types, and alias identity.
- Contextual inference replay for stability diagnostics on generic object literals.

`scripts/setup-tsrs.mjs` checks the exact upstream revision and applies the patch
idempotently. The root Cargo dependencies all point at that one checkout, avoiding
mixed compiler/type identities. Cargo and npm lockfiles pin the other dependencies.

No checker is recycled or AST reclaimed before analysis. Like tsrs's CLI, checking
runs on a thread with a 512 MiB reserved stack. The process lifetime owns the arenas;
this API is not a repeated-rebuild language-server implementation.

## Oxlint boundary

The npm launcher loads a version-matched frontend binding from `@effect/tsgo`
to register the `effecttsgo/*` rules. `scripts/oxlint-artifacts.mjs` copies only
these frontend bindings into the native packages. Schema and presets retain the
upstream names. Supported frontend/backend versions are pinned in
[the Oxlint metadata](bin/oxlint-metadata.json); unsupported versions fail before
patching.

`effect-tsrs headless` accepts Oxlint protocol v2 and emits its length-prefixed
binary JSON frames. It discovers projects and references per input file, creates
an inferred project for excluded files, and overlays unsaved sources without
writing them to disk. Oxlint owns rule severity, suppression and formatting.
Lint mode requests types as needed rather than running a full compiler check.
Compiler checks required internally by individual Effect rules remain intact.
The headless path preserves duplicate emissions. Stability analysis reads cached
or annotated types without speculatively inferring unchecked initializers and bodies.

Generic rules and explicit TypeScript checking are delegated to the installed
`oxlint-tsgolint` binary. Its output is buffered while the Rust pass runs so frames
cannot interleave. The wrapper uses environment overrides; optional patching
preserves byte-for-byte backups, rejects conflicting edits, and restores original
files on failure. Effect code actions and per-rule timings remain unported.

The wrapper and patched Oxlint CLI forward positive `--threads N` values through
`EFFECT_TSRS_THREADS`, `RAYON_NUM_THREADS`, and `GOMAXPROCS`. Rust caps the project
checker count at N; 1 additionally enables single-threaded compilation. Under a
limit the Rust and Go passes run sequentially so they share the worker budget.
Without a limit, the existing concurrent backend behavior remains. The optional
patch includes the CLI entry point in its atomic backup/restore plan.

```sh
npm run prepare:oxlint
npm run verify:oxlint
npm run verify:oxlint:all
npm run bench:oxlint -- --project path/to/app --samples 30 --warmup 3
```

`verify:oxlint` checks the actual Oxlint frontend against the Go oracle, including
mixed rules, severities, overrides, comments, related ranges, unsaved Unicode
sources/imports, inferred projects, references, config errors, standard fixes and
patch/unpatch. `verify:package` checks an offline install without `@effect/tsgo`.
`verify:oxlint:all` groups the 4,263 relevant rule/fixture pairs into 614 projects
and compares diagnostic messages, byte ranges, duplicates and related labels.
Release CI requires all 130 rules to have positive oracle coverage and checks
that the verified executable is the one being packaged.

For the correction-port follow-up, add `--corrections suggestions` (or `fixes`,
`all`) to `verify:oxlint:all`. It also compares suggestion titles, edit order,
byte ranges and replacement text, and reports positive correction coverage per
rule. These modes currently expose the unported Effect suggestions; the default
mode continues to check diagnostics without requesting corrections.

### Oxlint measurements

With Effect 4.0.6, Oxlint 1.89.0 and oxlint-tsgolint 7.0.2004, 30 interleaved
samples per variant after three warmups gave the following complete-command
medians on an Apple M4 Max. Both tools returned identical diagnostics on every
run. Ten Effect rules were selected; mixed mode also enabled
`typescript/no-floating-promises`.

| Workload | Mode | Rust adapter | Effect TSGO | Speedup |
| --- | --- | ---: | ---: | ---: |
| Generated, 121 files | Effect only | 151.7 ms | 243.2 ms | 1.60× |
| Generated, 121 files | Mixed | 209.3 ms | 244.6 ms | 1.17× |
| Application API, 139 files | Effect only | 2,508.2 ms | 7,692.2 ms | 3.07× |
| Application API, 139 files | Mixed | 7,231.9 ms | 7,756.8 ms | 1.07× |

The app used an isolated source snapshot, with Effect overridden to 4.0.6. The timed workloads emitted 1,560 and 10 findings respectively. The added
TypeScript rule produced no extra findings; integration checks separately verify
positive TypeScript diagnostics and fixes.

Each backend used one worker. At that revision mixed mode ran Rust and Go concurrently and used
30% more total CPU on the generated project and 26% more on the app. Its smaller
elapsed time comes with that resource cost. Reported RSS measures the largest
individual process, not combined memory across both engines. These results cover
fresh CLI processes with warm filesystem caches, not editor latency.

[Compact evidence, p95s, hashes and raw-report paths](benchmarks/oxlint-port.json).
These measurements identify the pre-release executable by hash; they predate the
final duplicate-emission and unchecked stability-analysis parity corrections.

## Verification

```sh
npm run check
npm test
npm run verify -- --binary target/release/effect-tsrs
npm run verify:config -- --binary target/release/effect-tsrs
npm run verify:project -- --binary target/release/effect-tsrs
npm run fixtures:install
npm run verify:all
```

The matrix covers every one of the 612 copied upstream fixtures, plus v3/v4 clean
controls. Every rule needs positive reference coverage; empty output alone does
not count as implementation evidence. Codes, messages, severity, paths, all UTF-16
positions, and related information are compared exactly. The compiler smoke and
configuration suites explicitly use `--type-check` to check ordinary TypeScript
diagnostics, including aliases, Unicode, clean input, and a deliberate TS2322 error.

`verify:project` compares the native oracle with standalone diagnostics and, where
applicable, the Oxlint entry point. It covers defaults, root/reference selection,
overlap ownership, compiler eligibility, canonical paths, deleted roots, plugin
summary counts, strict exit behavior, and `--type-check` cases.

Fixture preprocessing follows the upstream virtual-file runner: preserve raw
bytes, normalize materialized unit newlines, expand `@filename` units, mount the
matching dependency package, and apply the original options. Native output is
retained before filtering to the selected rule. An immutable candidate snapshot
prevents concurrent rebuilds from mixing implementations in a report.

The default 4,263-pair matrix uses fixture names, original diagnostic associations,
configuration references, and broad negative controls. `--scope all` runs every
rule against every fixture. Configuration tests separately exercise inherited
option merging, override paths, suppression use tracking, and unknown rule names.

Run `npm run fixtures:install && npm run verify:all`. Detailed comparisons and
process metadata are written under `artifacts/all-rules/`; summaries reject stale
candidate hashes or changed fixture/dependency/preprocessing inputs.

[Retained full-port verification](fixtures/all/verification.json) records the
baseline's source tree, executable, checks, upstream revisions, and per-rule coverage.
Current candidate reports are written to the artifact directories described above.

## Performance

For a repeated comparison of ten representative diagnostics individually and
together, run `npm run bench:diagnostics`. Defaults are 120 generated modules,
three warmups and 30 measured runs per selection and implementation. Override
with `-- --modules 120 --samples 30 --warmup 3`. The same project is used for
every selection; exact Effect output, file counts and ordinary TypeScript
correctness are checked before timing, and every measured output is validated.
Selection order rotates and native process order alternates. Reports include
median, p95, range, memory, raw outputs and binary hashes under
`artifacts/ten-diagnostics-*`. macOS memory collection requires permission to
read the `/usr/bin/time -l` system counters.

This ten-rule harness keeps `skipDisabledOptimization: false`, so both tools
skip disabled rules. The older harness and historical results below use `true`,
which makes the Go runner execute disabled rules and filter their output;
the Rust `--rules` selection still limits execution. Do not interpret those
historical subset timings as matching the set of executed rules. All timings
are whole CLI invocations, not isolated rule costs or editor response times.

To run the same ten rules together against an application, use
`npm run bench:project -- --project /path/to/tsconfig.json`. This keeps the
application source/configuration intact and overrides only diagnostic options
for the command. It validates selected Effect output across implementations
and checks each implementation's output stays stable over 30 measured runs.
The benchmark explicitly enables `--type-check` to record ordinary TypeScript
errors. Both runners target configured root files, including declarations and
referenced projects. Earlier reports predate this file-selection alignment.
These remain CLI comparisons with different total work because the Rust benchmark
also reports ordinary compiler errors. Optional `--provenance /path/to/snapshot.json`
records an application's revision and dependency setup with the report.

The benchmark generates 120 Effect modules and a shared re-export module. It
checks exact diagnostics and ordinary TypeScript correctness before collecting
interleaved fresh-process samples. The original three-rule mode is retained for
regression comparison; `--rules all` exercises the full port. Peak RSS uses macOS
`/usr/bin/time -l`; raw samples, environment details, source and binary hashes are
retained with each report.

The final run used an Apple M4 Max, one warmup and seven interleaved samples per
variant, with the eight-process fixture suite active. All-rule output matched
726 diagnostics; the three-rule comparison matched 720. The generated TypeScript
project was error-free. Four rules produced findings in the all-rule workload.

| Command | Selected rules | Median wall time | Range | Median peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Preserved spike executable | 3 | 111.1 ms | 94.1–122.3 ms | 53.2 MiB |
| Current effect-tsrs | 3 | 75.3 ms | 71.7–92.3 ms | 54.4 MiB |
| Current effect-tsrs | 130 | 194.7 ms | 191.8–220.8 ms | 77.0 MiB |
| effect-tsgo | 130 | 264.7 ms | 257.4–273.8 ms | 134.2 MiB |

The current three-rule path has no measured latency regression against the preserved
spike. The full Effect pass took a median 120.5 ms. These are command measurements
on a generated project: the Rust command also performs and reports a complete
ordinary TypeScript diagnostic pass, so the Go comparison does not isolate compiler
or language speed. It does not measure a long-lived editor or every Effect workload.

[Final samples, settings, and hashes](benchmarks/full-port.json) retain both
comparisons. [benchmarks/spike.json](benchmarks/spike.json) archives the earlier
three-rule run under its original conditions.

## Remaining integration work

The diagnostic rules and their configuration are implemented here. Integrating
these results into tsrs's own command-line driver or language server, preserving
watch/snapshot lifetimes, and porting editor actions are separate changes. No quick
fixes, refactors, completions, or hover providers are supplied by this CLI.

## Releasing

Keep the version in `Cargo.toml`, `Cargo.lock`, `package.json`, and the native
`optionalDependencies` in sync, then update `package-lock.json`. Regenerate
`THIRD-PARTY-NOTICES` with `node scripts/third-party-notices.mjs` after changing
`Cargo.lock`. Push a matching
`vX.Y.Z` tag to release. The `release-packages.yml` workflow builds and verifies all
five platforms, including the configuration and project-selection oracle suites,
and runs the complete rule comparisons on macOS ARM64. Publication prerequisites
in [scripts/publish-npm.mjs](scripts/publish-npm.mjs) require verification reports
for the packaged executable. Tag releases publish the native packages and wait
for all five to become publicly available before publishing the launcher.

Publishing uses npm's trusted publisher for `yielded-dev/effect-tsrs` and
`release-packages.yml`, with GitHub OIDC and provenance. No npm token is needed.
Pull requests and manual dispatches without `resume_run_id` build and verify
packages without publishing.

If all native uploads were accepted but the registry availability check timed out,
the workflow automatically continues from the original verified artifacts without
repeating native uploads. Each check waits up to ten minutes; after 36 checks it
stops with an explicit registry-pending failure. Integrity or upload errors fail
immediately rather than scheduling a continuation.

For manual recovery, dispatch the workflow with `resume_run_id` set to the original
release run ID and `release_tag` set to its version tag. The original manifest and
successful builds are validated before checking native integrity and publishing
the launcher. An already-published launcher with matching integrity is a no-op.
