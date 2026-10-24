Full-registry fixture harness
============================

`raw/v3` and `raw/v4` contain byte-for-byte upstream fixtures. `manifest.json`
records their revision, hashes, virtual files, and rule associations. `rules.json`
snapshots all 130 rules. Dependency manifests are upstream copies, with npm
lockfiles for reproducible installation.

Run from the repository root:

```sh
# Install the copied dependency locks without a sibling checkout.
npm run fixtures:install

# Run and aggregate the complete relevant matrix in parallel.
npm run verify:all

# Recopy upstream fixtures, install dependencies, and materialize projects.
node scripts/all-rules.mjs setup --install true

# Inspect coverage; --details true also lists fixture names and exclusions.
node scripts/all-rules.mjs list --rules floatingEffect,asyncFunction --versions v3,v4

# Compare one rule with native Effect tsgo.
node scripts/all-rules.mjs run --rules floatingEffect --versions v3,v4 \
  --binary target/debug/effect-tsrs --output artifacts/all-rules/floating

# Collect native-reference evidence independently of the candidate.
node scripts/all-rules.mjs reference --rules deterministicKeys \
  --output artifacts/all-rules/deterministic-reference

# Reuse compatible reference results after rebuilding the candidate.
node scripts/all-rules.mjs run --rules deterministicKeys \
  --reuse-reference artifacts/all-rules/deterministic-reference \
  --output artifacts/all-rules/deterministic-new-build

# Aggregate family runs for the current binary; stale binaries do not count.
node scripts/all-rules.mjs aggregate --inputs artifacts/all-rules \
  --binary target/debug/effect-tsrs --output artifacts/all-rules/current-coverage
```

`run` and `reference` need no sibling checkout after fixture setup. Projects under
ignored `cases/` are generated automatically. Install from copied lockfiles with
`npm ci --ignore-scripts --legacy-peer-deps --prefix fixtures/all/deps/v3` and the
corresponding `v4` command.

Every pair preserves stdout, stderr, process metadata, normalized comparison,
and fixture settings. `report.json` records positive native-reference coverage,
zero-reference controls, failures, baseline gaps, and binary/source hashes.
`plan.json` records selected and excluded pairs. A zero/zero comparison does not
establish positive coverage.

`--fixtures REGEX` selects named fixtures. The default `relevant` matrix uses
filename, directive/configuration, and upstream-baseline associations. The 22
unmapped diagnostic fixtures run against every selected rule. Synthetic clean
controls cover both versions. `--scope all` checks every rule/fixture pair,
including pairs outside the registry's supported-version metadata. Those pairs
are checked empirically, without assuming zero diagnostics. `--limit N` produces an
explicitly incomplete debugging run.
`--resume true` requires the same selection and preserves its original binary snapshot.

Reference cache keys include the source, selected rule, complete plugin/compiler
options, physical case root, dependency lockfile, and native binary hash.
Candidate rebuilds may reuse compatible reference results. `aggregate` only
counts candidate reports matching the current binary and raw fixture hashes;
missing pairs and stale reports remain visible.

Each `run` copies its candidate into a read-only `candidate-binary` in the output
directory before any comparisons and executes that snapshot throughout. The
recorded SHA256 hashes those exact bytes. Rebuilding the shared target during a
run cannot mix implementations. `--resume true` verifies and reuses the original
snapshot, even if the shared build has since changed. Legacy runs without a
snapshot cannot satisfy current aggregation.

Preprocessing follows `internal/effecttest/runner.go`: remove `@filename`
boundaries, normalize unit newlines to LF, drop text before the first boundary,
exclude `/node_modules` units from source roots, mount `/.src/package.json`, and
apply compiler defaults. Raw fixture copies preserve CRLF. Each virtual root is
relocated to one physical directory. Absolute `/app` fixtures receive an empty
package boundary at their config directory to prevent repository identity leaks;
that directory matches upstream's fallback key root.

Plugin options, per-file overrides, and source directives remain active. Preview
`@test-config` options are merged as in upstream's preview evaluator. Each pair
sets other registered rules off and retains the selected rule's configured or
default severity, including `off`; source directives may re-enable it. Candidate
`--rules` must gate unrelated rules. Native tsgo has no equivalent gate, so its
full output is retained while comparison selects the requested rule, including
related information.

The oracle is the installed `@effect/tsgo` executable matching root TypeScript.
Checked-in upstream baselines provide associations and positive-count checks,
not replacement oracle output. This matrix uses the default Effect-only command.
Ordinary TypeScript diagnostics are checked by the
[compiler smoke and configuration suites](../../PORTING.md#verification).
