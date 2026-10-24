import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { argumentsFor, assertEqual, candidateTypeScript, checkParity, commands, metadata, parseTypeScript, root, run, selectedRules, snapshotExecutable, statistics, timestamp, writeJson } from "./harness.mjs";

const args = argumentsFor({ binary: "target/release/effect-tsrs", output: `artifacts/bench-${timestamp()}`, modules: "120", samples: "7", warmup: "1", rules: selectedRules.join(","), baseline: "", "baseline-sha256": "", "gate-only": "false", activity: "" });
for (const key of ["modules", "samples", "warmup"]) {
  args[key] = Number(args[key]);
  if (!Number.isSafeInteger(args[key]) || args[key] < (key === "warmup" ? 0 : 1)) throw new Error(`Invalid --${key}`);
}
const registry = JSON.parse(fs.readFileSync(path.join(root, "fixtures/all/rules.json"), "utf8"));
const rules = args.rules === "all" ? registry.map((r) => r.name) : [...new Set(args.rules.split(","))];
for (const name of rules) if (!registry.some((r) => r.name === name)) throw new Error(`Unknown rule: ${name}`);
if (args.baseline && rules.some((name) => !selectedRules.includes(name))) throw new Error("The preserved baseline implements only floatingEffect, asyncFunction, and unnecessaryPipe; compare it with the same selection");
const severityNames = { SeverityError: "error", SeverityWarning: "warning", SeveritySuggestion: "suggestion", SeverityMessage: "message", SeverityOff: "warning" };
const diagnosticSeverity = Object.fromEntries(registry.map((rule) => [rule.name, rules.includes(rule.name) ? severityNames[rule.severity] : "off"]));
diagnosticSeverity.unusedDirective = "off";
diagnosticSeverity.unknownRuleName = "off";
const lspconfig = { diagnosticSeverity, skipDisabledOptimization: true };
const output = path.resolve(root, args.output);
const project = path.join(output, "workload");
fs.mkdirSync(project, { recursive: true });
// Remove only the generated modules when reusing an output directory with a smaller workload.
for (const file of fs.readdirSync(project)) if (/^module-\d+\.ts$/.test(file)) fs.unlinkSync(path.join(project, file));
writeJson(path.join(project, "tsconfig.json"), { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true, singleThreaded: true, types: [] }, include: ["*.ts"] });
fs.writeFileSync(path.join(project, "shared.ts"), 'export { Effect as Fx, Stream as Flow } from "effect"\nexport { pipe as pipeline } from "effect/Function"\n');
for (let i = 0; i < args.modules; i++) {
  fs.writeFileSync(path.join(project, `module-${String(i).padStart(3, "0")}.ts`), `import { Fx, Flow, pipeline } from "./shared.js"
import { Option, Exit } from "effect"
const seed = ${i}
const value: Fx.Effect<number> = Fx.succeed(seed)
function make(): Fx.Effect<number> { return value }
// 😀 exercise UTF-16 locations on every module.
"😀"; make()
const stream: Flow.Stream<number> = Flow.succeed(seed)
stream
export const mapped = value.pipe(Fx.map((n) => n + 1))
export const generated = Fx.gen(function*() {
  const n = yield* mapped
  return n * 2
})
export const emptyPipe = pipeline(value)
export const emptyMethod = generated.pipe()
export async function calculate() { return seed + 1 }
let assignment = value
assignment = mapped
assignment ??= generated
Option.some(seed)
Exit.succeed(seed)
const lookalike = { pipe: () => seed }
lookalike.pipe()
`);
}

const candidateBinary = snapshotExecutable(args.binary, path.join(output, "executables/candidate"));
const specs = commands(project, candidateBinary.path, { rules, lspconfig });
const referenceBinary = snapshotExecutable(specs.reference.command, path.join(output, "executables/reference"));
// The npm native compiler reads its standard-library declarations beside the
// executable. Keep those resources with the immutable native snapshot.
referenceBinary.resources = [];
for (const name of fs.readdirSync(path.dirname(referenceBinary.original)).filter((name) => name.endsWith(".d.ts"))) {
  const from = path.join(path.dirname(referenceBinary.original), name);
  const to = path.join(path.dirname(referenceBinary.path), name);
  const temporary = `${to}.${process.pid}.tmp`;
  fs.copyFileSync(from, temporary, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(temporary, 0o444);
  fs.renameSync(temporary, to);
  referenceBinary.resources.push({ name, bytes: fs.statSync(to).size });
}
specs.reference.command = referenceBinary.path;
specs.typescript.command = referenceBinary.path;
let baselineBinary;
if (args.baseline) {
  baselineBinary = snapshotExecutable(args.baseline, path.join(output, "executables/baseline"), args["baseline-sha256"] || undefined);
  // The preserved three-rule CLI predates --lspconfig. Its fixed severities
  // match this selection; the parity gate verifies that assumption.
  specs.baseline = commands(project, baselineBinary.path, { rules, lspconfig, candidateLspconfig: false }).candidate;
  // That CLI always performs the full TypeScript check and predates this flag.
  specs.baseline.args = specs.baseline.args.filter(arg => arg !== "--type-check");
}
const runMetadata = metadata([project], candidateBinary.path);
runMetadata.settings.rules = diagnosticSeverity;
const workloadFiles = fs.readdirSync(project).filter((file) => file.endsWith(".ts")).sort();
const workloadHash = createHash("sha256");
let sourceBytes = 0;
for (const file of workloadFiles) {
  const contents = fs.readFileSync(path.join(project, file));
  workloadHash.update(file).update("\0").update(contents);
  sourceBytes += contents.length;
}
const report = {
  ...runMetadata,
  mode: args["gate-only"] === "true" ? "gate-only" : "benchmark",
  binaries: { candidate: candidateBinary, reference: referenceBinary, ...(baselineBinary ? { baseline: baselineBinary } : {}) },
  selectedRules: rules,
  lspconfig,
  workload: { modules: args.modules, sourceFiles: args.modules + 1, sourceBytes, contentSha256: workloadHash.digest("hex"), description: "Real Effect v4 typed values/functions, generators, Streams, aliases, pipes, assignments, async functions, and Unicode" },
  samplesPerVariant: args.samples,
  warmupPerVariant: args.warmup,
  measurement: "Independent CLI processes, interleaved rotating order, elapsed wall time including process startup and JSON output; macOS max RSS via /usr/bin/time -l",
  measurementContext: args.activity || "No background-activity assertion; machine was not held idle.",
  comparisonLimits: [
    "Reference Effect CLI checks selected Effect diagnostics but does not run the same complete ordinary TypeScript diagnostic pass as the Rust candidate.",
    "compilerOnly disables the Effect pass, so it is not an equal-result comparison.",
    "Native-reference and candidate wall times describe these commands; their full workloads are not identical, so no equal-work speedup is claimed.",
    ...(baselineBinary ? ["Preserved and current Rust three-rule binaries have matched selected diagnostics and ordinary TypeScript outputs; their wall times measure regression on the same compiler workload."] : []),
  ],
  commands: specs,
  gatePassed: false,
  passed: false,
  samples: [],
};
writeJson(path.join(output, "report.json"), report);
try {
  // Check exact selected diagnostics and ordinary compiler output before timing anything.
  const reference = run(specs.reference, path.join(output, "gate/reference"));
  const candidate = run(specs.candidate, path.join(output, "gate/candidate"));
  const compilerOnly = run(specs.compilerOnly, path.join(output, "gate/compiler-only"));
  const originalCompiler = run(specs.typescript, path.join(output, "gate/typescript"), { json: false, allowedStatuses: [0, 1, 2] });
  const expectedTs = parseTypeScript(originalCompiler, project);
  assertEqual(expectedTs, [], "Generated benchmark must be TypeScript-correct");
  assertEqual(candidateTypeScript(candidate.data, project), expectedTs, "Benchmark compiler parity failed");
  assertEqual(candidateTypeScript(compilerOnly.data, project), expectedTs, "Compiler-only diagnostics differ");
  assertEqual(compilerOnly.data.diagnostics, [], "Compiler-only emitted Effect diagnostics");
  const expected = checkParity(reference, candidate, project, path.join(output, "gate/effect"), { rules });
  if (baselineBinary) {
    const baseline = run(specs.baseline, path.join(output, "gate/baseline"));
    assertEqual(candidateTypeScript(baseline.data, project), expectedTs, "Preserved baseline compiler diagnostics differ");
    checkParity(reference, baseline, project, path.join(output, "gate/baseline-effect"), { rules });
    assertEqual(baseline.data.summary.filesChecked, candidate.data.summary.filesChecked, "Baseline and candidate checked different source-file counts");
  }
  const perRule = Object.fromEntries(rules.map((name) => [name, expected.filter((d) => d.name === name).length]));
  // Protect the representative workload without assuming full-port rules add
  // no additional diagnostics.
  for (const [name, minimum] of Object.entries({ floatingEffect: args.modules * 2, asyncFunction: args.modules, unnecessaryPipe: args.modules * 3 })) {
    if (rules.includes(name) && perRule[name] < minimum) throw new Error(`Benchmark lost expected ${name} coverage: ${perRule[name]} < ${minimum}`);
  }
  if (!expected.length) throw new Error("Benchmark produced no positive diagnostic coverage");
  assertEqual(candidate.data.summary.filesChecked, args.modules + 1, "Candidate source-file count differs from workload");
  assertEqual(reference.data.summary.filesChecked, args.modules + 1, "Reference source-file count differs from workload");
  report.diagnostics = { total: expected.length, perRule, rulesWithFindings: Object.entries(perRule).filter(([, count]) => count > 0).map(([name]) => name), typescript: expectedTs.length };
  report.gatePassed = true;
  writeJson(path.join(output, "report.json"), report);
  console.log(`Parity gate passed: ${args.modules + 1} files, ${expected.length} identical diagnostics.`);

  const variants = [...(baselineBinary ? ["baseline"] : []), "candidate", "reference", "compilerOnly"];
  const rounds = args["gate-only"] === "true" ? 0 : args.warmup + args.samples;
  for (let round = 0; round < rounds; round++) {
    const phase = round < args.warmup ? "warmup" : "sample";
    const index = phase === "warmup" ? round : round - args.warmup;
    const order = variants.map((_, i) => variants[(i + round) % variants.length]);
    for (const variant of order) {
      const prefix = path.join(output, phase, `${String(index + 1).padStart(2, "0")}-${variant}`);
      const result = run(specs[variant], prefix, { timed: true });
      assertEqual(candidateTypeScript({ typescriptDiagnostics: result.data.typescriptDiagnostics ?? [] }, project), [], `Timed ${variant} produced TypeScript errors`);
      if (variant === "compilerOnly") assertEqual(result.data.diagnostics, [], "Timed compiler-only emitted Effect diagnostics");
      else checkParity(reference, result, project, prefix, { rules });
      report.samples.push({ phase, index: index + 1, variant, order, elapsedMs: result.elapsedMs, maxRssBytes: result.maxRssBytes, status: result.status, timings: result.data.timings ?? null });
      writeJson(path.join(output, "report.json"), report);
      console.log(`${phase} ${index + 1} ${variant}: ${result.elapsedMs.toFixed(1)} ms${result.maxRssBytes ? `, ${(result.maxRssBytes / 1024 / 1024).toFixed(1)} MiB RSS` : ""}`);
    }
  }
  report.statistics = Object.fromEntries(variants.map((variant) => {
    const rows = report.samples.filter((s) => s.phase === "sample" && s.variant === variant);
    return [variant, { wallMs: statistics(rows.map((s) => s.elapsedMs)), maxRssBytes: statistics(rows.map((s) => s.maxRssBytes)), effectMs: statistics(rows.map((s) => s.timings?.effectMs ?? null)), phases: Object.fromEntries(["configMs", "programMs", "typescriptMs", "effectMs", "totalMs"].map((phase) => [phase, statistics(rows.map((s) => s.timings?.[phase] ?? null))])) }];
  }));
  if (rounds) {
    report.comparisons = {
      ...(baselineBinary ? {
        currentVsPreservedThreeRules: {
          matchedWork: true,
          wallMedianRatio: report.statistics.candidate.wallMs.median / report.statistics.baseline.wallMs.median,
          wallMedianChangePercent: (report.statistics.candidate.wallMs.median / report.statistics.baseline.wallMs.median - 1) * 100,
          rssMedianRatio: report.statistics.candidate.maxRssBytes && report.statistics.baseline.maxRssBytes ? report.statistics.candidate.maxRssBytes.median / report.statistics.baseline.maxRssBytes.median : null,
        },
      } : {}),
      candidateVsNativeReference: {
        matchedEffectOutput: true, matchedFullWork: false,
        commandWallMedianRatio: report.statistics.candidate.wallMs.median / report.statistics.reference.wallMs.median,
        note: "The Rust command also performs complete ordinary TypeScript checking; this ratio is not an equal-work speedup claim.",
      },
    };
  }
  report.measurementVerified = rounds > 0;
  report.passed = true;
  console.log(`${rounds ? "Benchmark complete" : "Parity gate complete (no timing samples)"}. Evidence: ${path.relative(root, output)}/report.json`);
  if (rounds) console.log(JSON.stringify(report.statistics, null, 2));
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeJson(path.join(output, "report.json"), report);
  writeJson(path.join(output, "summary.json"), {
    mode: report.mode, passed: report.passed, gatePassed: report.gatePassed,
    measurementVerified: report.measurementVerified ?? false, error: report.error ?? null,
    versions: report.versions, machine: report.machine, workload: report.workload,
    measurementContext: report.measurementContext,
    enabledRuleCount: rules.length, diagnostics: report.diagnostics,
    binaries: report.binaries, samplesPerVariant: report.samplesPerVariant,
    statistics: report.statistics ?? null, comparisons: report.comparisons ?? null,
    comparisonLimits: report.comparisonLimits,
  });
}
