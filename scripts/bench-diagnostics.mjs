import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { argumentsFor, assertEqual, candidateTypeScript, checkParity, commands, metadata, normalizedDiagnostics, parseTypeScript, root, run, snapshotExecutable, timestamp, writeJson } from "./harness.mjs";

// The same project is scanned for every selection, so per-rule measurements
// include startup, parsing and checking rather than pretending to time a callback.
const rules = [
  "floatingEffect", "asyncFunction", "unnecessaryPipe", "catchUnfailableEffect",
  "returnEffectInGen", "tryCatchInEffectGen", "globalConsoleInEffect",
  "missingReturnYieldStar", "promiseInEffectSuccess", "runEffectInsideEffect",
];
const args = argumentsFor({ binary: "target/release/effect-tsrs", output: `artifacts/ten-diagnostics-${timestamp()}`, modules: "120", samples: "30", warmup: "3", "gate-only": "false" });
for (const key of ["modules", "samples", "warmup"]) {
  args[key] = Number(args[key]);
  if (!Number.isSafeInteger(args[key]) || args[key] < (key === "warmup" ? 0 : 1)) throw new Error(`Invalid --${key}`);
}
if (!["true", "false"].includes(args["gate-only"])) throw new Error("Invalid --gate-only");
const output = path.resolve(root, args.output);
if (fs.existsSync(output)) throw new Error(`Use a fresh output directory: ${output}`);
const project = path.join(output, "workload");
fs.mkdirSync(project, { recursive: true });
writeJson(path.join(project, "tsconfig.json"), { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true, singleThreaded: true, types: [] }, include: ["*.ts"] });
fs.writeFileSync(path.join(project, "shared.ts"), 'export { Effect as Fx, Stream as Flow } from "effect"\nexport { pipe as pipeline } from "effect/Function"\n');
for (let i = 0; i < args.modules; i++) {
  fs.writeFileSync(path.join(project, `module-${String(i).padStart(3, "0")}.ts`), `import { Fx, Flow, pipeline } from "./shared.js"
const seed = ${i}
const value: Fx.Effect<number> = Fx.succeed(seed)
function make(): Fx.Effect<number> { return value }
// 😀 exercise UTF-16 locations in each module.
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
export const redundantCatch = value.pipe(Fx.catchIf(() => true, () => Fx.succeed(0)))
export const nested = Fx.gen(function*() { return Fx.fail("nested") })
export const caught = Fx.gen(function*() {
  try { return yield* value } catch { return 0 }
})
export const logged = Fx.gen(function*() { console.log(seed); return yield* value })
export const missingReturn = Fx.gen(function*() {
  if (seed % 2 === 0) { yield* Fx.fail("even") }
  return seed
})
export const promiseSuccess = Fx.succeed(Promise.resolve(seed))
export const nestedRun = Fx.gen(function*() { return Fx.runSync(value) })
// Clean controls for generator, catch, Promise, and method recognition.
export const validCatch = Fx.fail("expected").pipe(Fx.catchIf(() => true, () => value))
export const validPromise = Fx.promise(() => Promise.resolve(seed))
const lookalike = { pipe: () => seed }
lookalike.pipe()
`);
}

const registry = JSON.parse(fs.readFileSync(path.join(root, "fixtures/all/rules.json"), "utf8"));
const candidate = snapshotExecutable(args.binary, path.join(output, "executables/candidate"));
const reference = snapshotExecutable(commands(project, candidate.path).reference.command, path.join(output, "executables/reference"));
reference.resources = [];
for (const name of fs.readdirSync(path.dirname(reference.original)).filter((name) => name.endsWith(".d.ts"))) {
  const contents = fs.readFileSync(path.join(path.dirname(reference.original), name));
  const destination = path.join(path.dirname(reference.path), name);
  fs.writeFileSync(destination, contents, { mode: 0o444 });
  reference.resources.push({ name, sha256: createHash("sha256").update(contents).digest("hex") });
}
const selections = [...rules.map((rule) => ({ name: rule, rules: [rule] })), { name: "combined", rules }];
for (const selection of selections) {
  // Keep the normal disabled-rule optimization: true would run all 130 Go
  // rules and discard their results, while --rules still gates the Rust side.
  const lspconfig = { diagnosticSeverity: Object.fromEntries(registry.map((rule) => [rule.name, selection.rules.includes(rule.name) ? "warning" : "off"])), skipDisabledOptimization: false };
  selection.commands = commands(project, candidate.path, { rules: selection.rules, lspconfig });
  selection.commands.reference.command = reference.path;
  selection.commands.typescript.command = reference.path;
}
const report = {
  ...metadata([project], candidate.path), binaries: { candidate, reference },
  rules, selections, samplesPerVariant: args.samples, warmupPerVariant: args.warmup,
  workload: { modules: args.modules, sourceFiles: args.modules + 1, description: "Effect v4 generated project with ten positive diagnostic patterns, shared aliases, Unicode, and clean controls; identical sources for every selection" },
  measurement: "Fresh native CLI processes; warm filesystem caches; single-thread settings from harness; wall time includes startup and JSON output; macOS peak RSS from /usr/bin/time -l. Rotate selection order each round and alternate variant order per selection. No concurrent benchmark processes.",
  measurementContext: "Normal shared machine activity; no idle-machine assertion or CPU isolation.",
  comparisonLimits: [
    "These are per-selection CLI timings, not isolated rule execution times or editor latency.",
    "TSRS also performs complete ordinary TypeScript checking; the TSGO Effect CLI does not perform the same complete TypeScript diagnostic pass. Selected Effect output is matched, full work is not identical.",
    "Synthetic repeated modules; the resolved Effect version is recorded in versions.effect. Results do not establish performance on arbitrary projects or Effect v3.",
    "Both runtimes use one worker (tsconfig singleThreaded=true, GOMAXPROCS=1, RAYON_NUM_THREADS=1); this is not a default multi-core comparison.",
    "All selected rules use warning severity and skipDisabledOptimization=false in both implementations, so disabled rules are skipped.",
  ],
  gatePassed: false, passed: false, samples: [],
};
report.settings.rules = "See each selection's explicit --lspconfig; selected rules warning, all other rules off";
report.settings.singleThreaded = true;
writeJson(path.join(output, "report.json"), report);

function stats(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  return { samples: n, median: n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, p95: sorted[Math.ceil(n * 0.95) - 1], min: sorted[0], max: sorted.at(-1), mean, standardDeviation: n > 1 ? Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)) : 0 };
}

try {
  const ts = run(selections[0].commands.typescript, path.join(output, "gate/typescript"), { json: false, allowedStatuses: [0, 1, 2] });
  assertEqual(parseTypeScript(ts, project), [], "Generated workload must be TypeScript-correct");
  assertEqual(ts.status, 0, "TypeScript compiler must exit successfully");
  const expected = new Map();
  report.diagnostics = {};
  for (const selection of selections) {
    const prefix = path.join(output, "gate", selection.name);
    const ref = run(selection.commands.reference, `${prefix}-reference`);
    const cand = run(selection.commands.candidate, `${prefix}-candidate`);
    assertEqual(candidateTypeScript(cand.data, project), [], "TSRS ordinary TypeScript diagnostics must be empty");
    for (const result of [ref, cand]) assertEqual(result.data.summary.filesChecked, args.modules + 1, "Source file counts differ");
    const diagnostics = checkParity(ref, cand, project, prefix, { rules: selection.rules });
    const counts = Object.fromEntries(selection.rules.map((rule) => [rule, diagnostics.filter((d) => d.name === rule).length]));
    for (const [rule, count] of Object.entries(counts)) if (count < args.modules) throw new Error(`Lost positive coverage for ${rule}: ${count} < ${args.modules}`);
    expected.set(selection.name, diagnostics);
    report.diagnostics[selection.name] = { total: diagnostics.length, perRule: counts };
    console.log(`Parity passed: ${selection.name}: ${diagnostics.length} identical diagnostics`);
  }
  report.gatePassed = true;
  writeJson(path.join(output, "report.json"), report);
  const rounds = args["gate-only"] === "true" ? 0 : args.warmup + args.samples;
  for (let round = 0; round < rounds; round++) {
    const phase = round < args.warmup ? "warmup" : "sample";
    const index = phase === "warmup" ? round + 1 : round - args.warmup + 1;
    const ordered = selections.map((_, i) => selections[(i + round) % selections.length]);
    for (const selection of ordered) {
      const variants = (round + selections.indexOf(selection)) % 2 ? ["reference", "candidate"] : ["candidate", "reference"];
      for (const variant of variants) {
        const prefix = path.join(output, phase, `${String(index).padStart(2, "0")}-${selection.name}-${variant}`);
        const result = run(selection.commands[variant], prefix, { timed: true });
        // Save timing before validation, so even a failed sample stays visible.
        report.samples.push({ phase, index, selection: selection.name, variant, position: variants.indexOf(variant), elapsedMs: result.elapsedMs, maxRssBytes: result.maxRssBytes, status: result.status, timings: result.data.timings ?? null, validated: false });
        writeJson(path.join(output, "report.json"), report);
        assertEqual(normalizedDiagnostics(result.data, project, selection.rules), expected.get(selection.name), `Timed ${selection.name}/${variant} diagnostic mismatch`);
        assertEqual(result.data.summary.filesChecked, args.modules + 1, "Timed source file count differs");
        if (variant === "candidate") assertEqual(candidateTypeScript(result.data, project), [], "Timed TSRS TypeScript errors");
        report.samples.at(-1).validated = true;
      }
    }
    writeJson(path.join(output, "report.json"), report);
    console.log(`${phase} ${index}/${phase === "warmup" ? args.warmup : args.samples}: completed ${selections.length * 2} validated runs`);
  }
  report.statistics = Object.fromEntries(selections.map(({ name }) => [name, Object.fromEntries(["candidate", "reference"].map((variant) => {
    const rows = report.samples.filter((s) => s.phase === "sample" && s.selection === name && s.variant === variant);
    return [variant, { wallMs: stats(rows.map((s) => s.elapsedMs)), maxRssBytes: stats(rows.map((s) => s.maxRssBytes)), effectMs: stats(rows.map((s) => s.timings?.effectMs ?? null)) }];
  }))]));
  report.measurementVerified = rounds > 0;
  report.passed = true;
  if (rounds) {
    const lines = ["| Rule selection | Findings | TSRS median / p95 ms | TSGO median / p95 ms | TSGO / TSRS median |", "| --- | ---: | ---: | ---: | ---: |"];
    for (const { name } of selections) {
      const { candidate: c, reference: r } = report.statistics[name];
      lines.push(`| ${name} | ${report.diagnostics[name].total} | ${c.wallMs.median.toFixed(1)} / ${c.wallMs.p95.toFixed(1)} | ${r.wallMs.median.toFixed(1)} / ${r.wallMs.p95.toFixed(1)} | ${(r.wallMs.median / c.wallMs.median).toFixed(2)} |`);
    }
    console.log(lines.join("\n"));
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  writeJson(path.join(output, "report.json"), report);
  const { samples, fixtureHashes, selections: specs, ...summary } = report;
  writeJson(path.join(output, "summary.json"), summary);
  console.log(`Evidence: ${path.relative(root, output)}/report.json`);
}
