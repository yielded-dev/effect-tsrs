import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { argumentsFor, assertEqual, candidateTypeScript, checkParity, commands, metadata, normalizedDiagnostics, root, run, snapshotExecutable, statistics, timestamp, writeJson } from "./harness.mjs";

const tenRules = ["floatingEffect", "asyncFunction", "unnecessaryPipe", "catchUnfailableEffect", "returnEffectInGen", "tryCatchInEffectGen", "globalConsoleInEffect", "missingReturnYieldStar", "promiseInEffectSuccess", "runEffectInsideEffect"];
const args = argumentsFor({ project: "", provenance: "", binary: "target/release/effect-tsrs", output: `artifacts/project-bench-${timestamp()}`, samples: "30", warmup: "3", "gate-only": "false", "allow-mismatch": "false" });
if (!args.project) throw new Error("--project /path/to/tsconfig.json is required");
for (const key of ["samples", "warmup"]) {
  args[key] = Number(args[key]);
  if (!Number.isSafeInteger(args[key]) || args[key] < (key === "warmup" ? 0 : 1)) throw new Error(`Invalid --${key}`);
}
for (const key of ["gate-only", "allow-mismatch"]) if (!["true", "false"].includes(args[key])) throw new Error(`Invalid --${key}`);
const config = path.resolve(args.project);
const project = path.dirname(config);
const projectEffectPath = createRequire(path.join(project, "package.json")).resolve("effect/package.json");
const projectEffect = JSON.parse(fs.readFileSync(projectEffectPath, "utf8"));
const output = path.resolve(root, args.output);
if (fs.existsSync(output)) throw new Error(`Use a fresh output directory: ${output}`);
const candidate = snapshotExecutable(args.binary, path.join(output, "executables/candidate"));
const reference = snapshotExecutable(commands(project, candidate.path).reference.command, path.join(output, "executables/reference"));
for (const name of fs.readdirSync(path.dirname(reference.original)).filter((name) => name.endsWith(".d.ts"))) {
  fs.copyFileSync(path.join(path.dirname(reference.original), name), path.join(path.dirname(reference.path), name));
}
const registry = JSON.parse(fs.readFileSync(path.join(root, "fixtures/all/rules.json"), "utf8"));
const lspconfig = { diagnosticSeverity: Object.fromEntries(registry.map((rule) => [rule.name, tenRules.includes(rule.name) ? "warning" : "off"])), skipDisabledOptimization: false };
lspconfig.diagnosticSeverity.unusedDirective = "off";
lspconfig.diagnosticSeverity.unknownRuleName = "off";
const specs = commands(project, candidate.path, { rules: tenRules, lspconfig });
specs.candidate.args.push("--singleThreaded");
specs.candidate.args[specs.candidate.args.indexOf("-p") + 1] = config;
const refOptions = JSON.parse(specs.reference.args[1]);
refOptions.project = path.basename(config);
specs.reference = { command: reference.path, args: ["--effect-cli-diagnostics", JSON.stringify(refOptions)] };
const report = {
  ...metadata([project], candidate.path), binaries: { candidate, reference }, project: config,
  provenance: args.provenance ? JSON.parse(fs.readFileSync(path.resolve(args.provenance), "utf8")) : null,
  rules: tenRules, lspconfig, commands: { candidate: specs.candidate, reference: specs.reference },
  samplesPerVariant: args.samples, warmupPerVariant: args.warmup,
  measurement: "Fresh native CLI processes, warm filesystem, alternating variant order; Rust uses --singleThreaded, Go uses GOMAXPROCS=1. Wall time includes startup and output, peak RSS via macOS time -l. Normal shared machine activity.",
  comparisonLimits: [
    "TSRS performs full ordinary TypeScript checking; TSGO's Effect diagnostics command does not perform the same full check. These are command timings, not isolated rule costs.",
    "Both runners target configured roots, including declarations and referenced projects; file counts and exact Effect diagnostics are checked.",
    "Existing source directives remain active; the ten selected rules are warning severity, other rules are off, and disabled-rule optimization is enabled.",
    "A mismatch invalidates an equal-output performance comparison, even when each implementation's output is stable over repeated runs.",
  ],
  gatePassed: false, measurementVerified: false, passed: false, samples: [],
};
report.settings.rules = lspconfig.diagnosticSeverity;
report.settings.singleThreaded = true;
report.versions.effect = projectEffect.version;
report.projectEffect = { version: projectEffect.version, packagePath: projectEffectPath };
writeJson(path.join(output, "report.json"), report);
function stats(values) {
  const summary = statistics(values);
  if (!summary) return null;
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return { ...summary, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
try {
  const baseline = {};
  for (const variant of ["reference", "candidate"]) {
    baseline[variant] = run(specs[variant], path.join(output, `gate/${variant}`));
    console.log(`${variant}: ${baseline[variant].data.summary.filesChecked} files, ${baseline[variant].data.diagnostics.length} Effect diagnostics, ${baseline[variant].data.typescriptDiagnostics?.length ?? "unreported"} TypeScript diagnostics, ${baseline[variant].elapsedMs.toFixed(1)} ms`);
  }
  report.diagnostics = Object.fromEntries(Object.entries(baseline).map(([variant, result]) => [variant, {
    filesChecked: result.data.summary.filesChecked,
    effect: result.data.diagnostics.length,
    perRule: Object.fromEntries(tenRules.map((rule) => [rule, result.data.diagnostics.filter((d) => d.name === rule).length])),
    typescript: result.data.typescriptDiagnostics?.length ?? null,
  }]));
  report.fileCountsMatch = baseline.candidate.data.summary.filesChecked === baseline.reference.data.summary.filesChecked;
  report.matchedFullWork = false;
  try {
    checkParity(baseline.reference, baseline.candidate, project, path.join(output, "gate/effect"), { rules: tenRules });
    report.gatePassed = true;
  } catch (error) {
    report.parityError = error.message;
    if (args["allow-mismatch"] !== "true") throw error;
    console.log("WARNING: diagnostic parity failed; recording command timings with unequal results explicitly marked.");
  }
  const expected = Object.fromEntries(Object.entries(baseline).map(([variant, result]) => [variant, normalizedDiagnostics(result.data, project, tenRules)]));
  const expectedTs = candidateTypeScript(baseline.candidate.data, project);
  const sourceFiles = new Set(expectedTs.filter((d) => d.file).map((d) => d.file));
  for (const values of Object.values(expected)) for (const d of values) sourceFiles.add(d.file);
  report.diagnosticSourceHashes = Object.fromEntries([...sourceFiles].sort().map((file) => [file, createHash("sha256").update(fs.readFileSync(path.resolve(project, file))).digest("hex")]));
  const rounds = args["gate-only"] === "true" ? 0 : args.warmup + args.samples;
  for (let round = 0; round < rounds; round++) {
    const phase = round < args.warmup ? "warmup" : "sample";
    const index = phase === "warmup" ? round + 1 : round - args.warmup + 1;
    const order = round % 2 ? ["reference", "candidate"] : ["candidate", "reference"];
    for (const variant of order) {
      const result = run(specs[variant], path.join(output, phase, `${index}-${variant}`), { timed: true });
      report.samples.push({ phase, index, variant, position: order.indexOf(variant), elapsedMs: result.elapsedMs, maxRssBytes: result.maxRssBytes, status: result.status, timings: result.data.timings ?? null, validated: false });
      writeJson(path.join(output, "report.json"), report);
      assertEqual(normalizedDiagnostics(result.data, project, tenRules), expected[variant], `Unstable ${variant} Effect output`);
      assertEqual(result.data.summary.filesChecked, baseline[variant].data.summary.filesChecked, `Unstable ${variant} file count`);
      if (variant === "candidate") assertEqual(candidateTypeScript(result.data, project), expectedTs, "Unstable TypeScript output");
      report.samples.at(-1).validated = true;
    }
    writeJson(path.join(output, "report.json"), report);
    console.log(`${phase} ${index}: ${report.samples.slice(-2).map((s) => `${s.variant} ${s.elapsedMs.toFixed(1)} ms`).join(", ")}`);
  }
  report.statistics = Object.fromEntries(["candidate", "reference"].map((variant) => {
    const rows = report.samples.filter((s) => s.phase === "sample" && s.variant === variant);
    return [variant, { wallMs: stats(rows.map((s) => s.elapsedMs)), maxRssBytes: stats(rows.map((s) => s.maxRssBytes)), effectMs: stats(rows.map((s) => s.timings?.effectMs ?? null)) }];
  }));
  report.measurementVerified = rounds > 0;
  report.passed = report.gatePassed;
  console.log(JSON.stringify({ gatePassed: report.gatePassed, statistics: report.statistics }, null, 2));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  writeJson(path.join(output, "report.json"), report);
  const { samples, diagnosticSourceHashes, ...summary } = report;
  writeJson(path.join(output, "summary.json"), summary);
  console.log(`Evidence: ${path.relative(root, output)}/report.json`);
}
