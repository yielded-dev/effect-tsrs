import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverOxlint, oxlintCommand } from "../bin/oxlint.mjs";
import { argumentsFor, snapshotExecutable } from "./harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = argumentsFor({ project: "", binary: "target/release/effect-tsrs", output: "artifacts/bench-oxlint", samples: "30", warmup: "3", threads: "1" });
assert(args.project, "--project DIRECTORY is required");
for (const key of ["samples", "warmup", "threads"]) { args[key] = Number(args[key]); assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "warmup" ? 0 : 1)); }
const project = path.resolve(args.project), output = path.resolve(root, args.output);
assert(!fs.existsSync(output), "Use a fresh --output directory");
fs.mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const rules = ["floating-effect", "async-function", "unnecessary-pipe", "catch-unfailable-effect", "return-effect-in-gen", "try-catch-in-effect-gen", "global-console-in-effect", "missing-return-yield-star", "promise-in-effect-success", "run-effect-inside-effect"];
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file) : entry.isFile() && /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) ? [file] : [];
  }).sort();
}
const files = filesIn(project);
assert(files.length, "No TypeScript sources found");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const found = discoverOxlint(path.resolve(root, args.binary), root);
const upstream = path.dirname(require.resolve(`@effect/tsgo-${process.platform}-${process.arch}/package.json`));
const name = process.platform === "win32" ? "effect-tsrs.exe" : "effect-tsrs";
const candidate = snapshotExecutable(args.binary, path.join(output, "executables/rust/bin", name));
const oracle = snapshotExecutable(path.join(upstream, "artifacts/oxlint-tsgolint", found.backendVersion, `tsgolint${process.platform === "win32" ? ".exe" : ""}`), path.join(output, "executables/go/tsgolint"));
const frontend = path.join(output, "executables/rust/oxlint", found.version, path.basename(found.frontend));
fs.mkdirSync(path.dirname(frontend), { recursive: true });
fs.copyFileSync(found.frontend, frontend);
const report = { passed: false, createdAt: new Date().toISOString(), project, versions: { effect: JSON.parse(fs.readFileSync(createRequire(path.join(project, "package.json")).resolve("effect/package.json"))).version, oxlint: found.version, tsgolint: found.backendVersion, effectTsgo: JSON.parse(fs.readFileSync(path.join(upstream, "package.json"))).version, node: process.version }, machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length }, candidate, oracle, launcherSha256: hash(path.join(root, "bin/effect-tsrs.js")), adapterSha256: hash(path.join(root, "bin/oxlint.mjs")), frontendSha256: hash(frontend), files: files.map(file => ({ file: path.relative(project, file), sha256: hash(file) })), settings: { ...args, cache: "warm filesystem; fresh processes", concurrency: "Threads setting applies to Oxlint and its backends; the Rust adapter runs its Rust and Go passes sequentially under this limit", environment: "shared machine, no CPU isolation", scope: "Full Oxlint invocation, including parsing, reporting and launcher startup. The mixed case also runs typescript/no-floating-promises. RSS is the maximum observed process, not the sum of overlapping processes." }, scenarios: [], samples: [] };
const save = () => fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
const scenarios = [false, true].map(mixed => {
  const config = path.join(output, mixed ? "mixed.json" : "effect.json");
  fs.writeFileSync(config, JSON.stringify({ plugins: ["effecttsgo", "typescript"], categories: { correctness: "off" }, rules: { ...Object.fromEntries(rules.map(rule => [`effecttsgo/${rule}`, "warn"])), ...(mixed ? { "typescript/no-floating-promises": "warn" } : {}) } }));
  const common = ["--threads", String(args.threads), "--disable-nested-config", "--config", config, "--format", "json", ...files];
  const rust = oxlintCommand(candidate.path, common, root);
  // Match the public wrapper, including its in-process dependency lookup.
  rust.args = [path.join(root, "bin/effect-tsrs.js"), "oxlint", ...common];
  rust.env.EFFECT_TSRS_BINARY = candidate.path;
  const go = { command: process.execPath, args: [found.cli, "--type-aware", ...common], env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: frontend, OXLINT_TSGOLINT_PATH: oracle.path } };
  return { name: mixed ? "mixed" : "effect-only", commands: { rust, go } };
});
const expected = new Map();
function run(scenario, variant, phase, index) {
  const command = scenario.commands[variant];
  const timed = process.platform === "darwin";
  const start = process.hrtime.bigint();
  const result = spawnSync(timed ? "/usr/bin/time" : command.command, timed ? ["-l", command.command, ...command.args] : command.args, { cwd: root, env: { ...command.env, GOMAXPROCS: String(args.threads), RAYON_NUM_THREADS: String(args.threads) }, encoding: "utf8", timeout: 120_000, maxBuffer: 64 << 20 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const cpu = result.stderr?.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
  const record = { scenario: scenario.name, variant, phase, index, elapsedMs, status: result.status, error: result.error?.message, cpuMs: cpu ? (Number(cpu[2]) + Number(cpu[3])) * 1000 : null, maxRssBytes: Number(result.stderr?.match(/(\d+)\s+maximum resident set size/)?.[1]) || null };
  report.samples.push(record);
  const prefix = path.join(output, `${scenario.name}-${variant}-${phase}-${index}`);
  fs.writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
  fs.writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
  save();
  assert(!result.error && result.status === 0, `${prefix} failed`);
  const json = JSON.parse(result.stdout);
  const diagnostics = json.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  record.diagnostics = diagnostics.length;
  record.filesLinted = json.number_of_files;
  if (!expected.has(scenario.name)) expected.set(scenario.name, diagnostics);
  else assert.deepEqual(diagnostics, expected.get(scenario.name), `${scenario.name}: diagnostic parity`);
  assert.equal(json.number_of_files, files.length);
}
function stats(values) {
  const sorted = values.sort((a, b) => a - b), n = sorted.length;
  return { median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, p95: sorted[Math.ceil(n * .95) - 1], min: sorted[0], max: sorted[n - 1], samples: n };
}
try {
  for (const phase of ["warmup", "measured"]) {
    for (let i = 0; i < (phase === "warmup" ? args.warmup : args.samples); i++) {
      for (const scenario of i % 2 ? scenarios.toReversed() : scenarios) {
        for (const variant of i % 2 ? ["rust", "go"] : ["go", "rust"]) run(scenario, variant, phase, i);
      }
      if (phase === "measured" && (i + 1) % 5 === 0) console.log(`${i + 1}/${args.samples} paired rounds complete`);
    }
  }
  for (const scenario of scenarios) {
    const variants = Object.fromEntries(["rust", "go"].map(variant => { const samples = report.samples.filter(s => s.scenario === scenario.name && s.variant === variant && s.phase === "measured"); return [variant, { elapsedMs: stats(samples.map(s => s.elapsedMs)), cpuMs: samples.every(s => s.cpuMs !== null) ? stats(samples.map(s => s.cpuMs)) : null, maxRssBytes: samples.every(s => s.maxRssBytes) ? stats(samples.map(s => s.maxRssBytes)) : null }]; }));
    report.scenarios.push({ name: scenario.name, diagnostics: expected.get(scenario.name).length, variants, speedup: variants.go.elapsedMs.median / variants.rust.elapsedMs.median });
  }
  report.passed = true;
  console.log(JSON.stringify(report.scenarios, null, 2));
} catch (error) { report.error = error.message; console.error(error); process.exitCode = 1; } finally { save(); }
