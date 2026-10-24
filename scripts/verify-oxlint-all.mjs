import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { home, plan, prepare, readJson, writeJson } from "./all-rules-lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = { binary: "target/release/effect-tsrs", output: "artifacts/verify-oxlint-all", jobs: "4", fixtures: "all", limit: "0", backend: "7.0.2005", corrections: "none" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  assert(Object.hasOwn(args, key) && process.argv[i + 1], `Unknown or incomplete option: ${process.argv[i]}`);
  args[key] = process.argv[i + 1];
}
for (const key of ["jobs", "limit"]) {
  args[key] = Number(args[key]);
  assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "jobs" ? 1 : 0));
}
assert(["none", "fixes", "suggestions", "all"].includes(args.corrections), "--corrections must be none, fixes, suggestions, or all");
const correctionFlags = args.corrections === "none" ? [] : args.corrections === "fixes" ? ["--fix"] : args.corrections === "suggestions" ? ["--fix-suggestions"] : ["--fix", "--fix-suggestions"];
const output = path.resolve(root, args.output);
assert(!fs.existsSync(output), "Use a fresh output directory to preserve previous evidence");
fs.mkdirSync(output, { recursive: true });
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const binaryName = process.platform === "win32" ? "effect-tsrs.exe" : "effect-tsrs";
const binary = path.join(output, binaryName);
fs.copyFileSync(path.resolve(root, args.binary), binary);
fs.chmodSync(binary, 0o555);
const require = createRequire(import.meta.url);
const upstream = path.dirname(require.resolve(`@effect/tsgo-${process.platform}-${process.arch}/package.json`));
const oracle = path.join(upstream, "artifacts/oxlint-tsgolint", args.backend, `tsgolint${process.platform === "win32" ? ".exe" : ""}`);
const manifest = readJson(path.join(home, "manifest.json"));
const inventory = readJson(path.join(home, "rules.json"));
const kebab = name => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
const qualified = new Map(inventory.map(rule => [`effecttsgo/${kebab(rule.name)}`, rule.name]));
const entries = plan(manifest, inventory, ["v3", "v4"], args.fixtures, "relevant").entries;
const groups = new Map();
for (const { fixture, rule } of entries) {
  if (!groups.has(fixture.id)) groups.set(fixture.id, { fixture, rules: [] });
  groups.get(fixture.id).rules.push(rule);
}
const selected = [...groups.values()].slice(0, args.limit || undefined);
for (const group of selected) group.prepared = prepare(group.fixture);
const report = {
  passed: false, createdAt: new Date().toISOString(), binarySha256: hash(binary), oracleSha256: hash(oracle),
  source: manifest.source, settings: args, protocol: 2,
  versions: { effectTsgo: readJson(path.join(upstream, "package.json")).version, backend: args.backend, ...Object.fromEntries(["v3", "v4"].map(v => [v, readJson(path.join(home, "deps", v, "node_modules/effect/package.json")).version])) },
  expectedFixtures: selected.length, expectedPairs: selected.reduce((n, group) => n + group.rules.length, 0),
  scope: `Every pair in the standalone relevant-fixture matrix. Rules associated with each fixture run together through the real Oxlint headless protocol. Corrections: ${args.corrections}.`,
  results: [], coverage: {}, correctionCoverage: {},
};
const save = () => writeJson(path.join(output, "report.json"), report);
save();
console.log(`Prepared ${selected.length} fixtures / ${report.expectedPairs} rule-fixture pairs; ${args.jobs} workers`);
function invoke(executable, prepared, payload) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(executable, ["headless", ...correctionFlags], { cwd: prepared.cwd, env: { ...process.env, GOMAXPROCS: "1", RAYON_NUM_THREADS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let failure;
    const timeout = setTimeout(() => { failure = "Timed out after 120 seconds"; child.kill("SIGKILL"); }, 120_000);
    child.stdout.on("data", data => stdout.push(data));
    child.stderr.on("data", data => stderr.push(data));
    child.stdin.on("error", error => { failure = error.message; });
    child.on("error", error => { failure = error.message; });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, failure, elapsedMs: performance.now() - started, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
function decode(buffer) {
  const frames = [];
  for (let offset = 0; offset < buffer.length;) {
    assert(offset + 5 <= buffer.length, "Incomplete frame header");
    const length = buffer.readUInt32LE(offset), kind = buffer[offset + 4];
    assert(offset + 5 + length <= buffer.length, "Incomplete frame body");
    frames.push({ kind, data: JSON.parse(buffer.subarray(offset + 5, offset + 5 + length)) });
    offset += length + 5;
  }
  return frames;
}
const sort = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function normalize(frames, prepared) {
  return sort(frames.map(({ kind, data }) => {
    assert.equal(kind, 1, `Unexpected protocol frame: ${JSON.stringify(data)}`);
    const file = data.file_path ? path.relative(prepared.caseRoot, data.file_path).split(path.sep).join("/") : null;
    const range = value => value ? { pos: value.pos, end: value.end } : null;
    const message = value => ({ id: value.id ?? null, description: value.description, help: value.help ?? null });
    const fixes = values => (values ?? []).map(fix => ({ range: range(fix.range), text: fix.text }));
    return { kind: data.kind, file, rule: data.rule ?? null, range: range(data.range),
      message: message(data.message),
      labels: (data.labeled_ranges ?? []).map(label => ({ label: label.label, range: range(label.range) })),
      fixes: fixes(data.fixes),
      suggestions: (data.suggestions ?? []).map(suggestion => ({ message: message(suggestion.message), fixes: fixes(suggestion.fixes) })),
    };
  }));
}
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const { fixture, rules, prepared } = selected[cursor++];
    const prefix = path.join(output, fixture.id);
    const payload = { version: 2, configs: [{ file_paths: prepared.roots, rules: rules.map(rule => ({ name: `effecttsgo/${kebab(rule.name)}` })) }] };
    const result = { fixture: fixture.id, rules: rules.map(rule => rule.name), status: "failed" };
    try {
      const go = await invoke(oracle, prepared, payload);
      const rust = await invoke(binary, prepared, payload);
      const normalized = {};
      for (const [name, value] of [["go", go], ["rust", rust]]) {
        fs.mkdirSync(path.dirname(prefix), { recursive: true });
        fs.writeFileSync(`${prefix}.${name}.stderr.txt`, value.stderr);
        fs.writeFileSync(`${prefix}.${name}.stdout.bin`, value.stdout);
        result[name] = { status: value.status, signal: value.signal, error: value.failure, elapsedMs: value.elapsedMs };
        assert.equal(value.status, 0, `${name}: ${value.failure ?? value.stderr}`);
        assert(!value.failure && !value.signal, `${name}: ${value.failure ?? value.signal}`);
        normalized[name] = normalize(decode(value.stdout), prepared);
      }
      writeJson(`${prefix}.comparison.json`, normalized);
      result.referenceCount = normalized.go.length;
      result.candidateCount = normalized.rust.length;
      result.status = JSON.stringify(normalized.go) === JSON.stringify(normalized.rust) ? "matched" : "mismatch";
      for (const diagnostic of normalized.go) {
        if (!qualified.has(diagnostic.rule)) continue;
        const name = qualified.get(diagnostic.rule);
        report.coverage[name] = (report.coverage[name] ?? 0) + 1;
        if (diagnostic.fixes.length || diagnostic.suggestions.length) {
          const coverage = report.correctionCoverage[name] ??= { diagnostics: 0, fixes: 0, suggestions: 0, edits: 0 };
          coverage.diagnostics++;
          coverage.fixes += diagnostic.fixes.length;
          coverage.suggestions += diagnostic.suggestions.length;
          coverage.edits += diagnostic.fixes.length + diagnostic.suggestions.reduce((n, suggestion) => n + suggestion.fixes.length, 0);
        }
      }
    } catch (error) { result.error = error.message.slice(0, 1500); }
    report.results.push(result);
    save();
    if (result.status !== "matched") console.log(`${fixture.id}: ${result.status} ${result.error ?? "(see comparison)"}`);
    else if (report.results.length % 25 === 0) console.log(`${report.results.length}/${selected.length} fixtures compared`);
  }
}
await Promise.all(Array.from({ length: Math.min(args.jobs, selected.length) }, worker));
report.missingPositiveRules = inventory.filter(rule => !report.coverage[rule.name]).map(rule => rule.name);
report.binaryIntegrityVerified = hash(binary) === report.binarySha256 && hash(oracle) === report.oracleSha256;
report.passed = report.binaryIntegrityVerified && report.results.length === selected.length && report.results.every(r => r.status === "matched") && (args.limit > 0 || args.fixtures !== "all" || report.missingPositiveRules.length === 0);
report.finishedAt = new Date().toISOString();
save();
console.log(`${report.results.filter(r => r.status === "matched").length}/${selected.length} fixtures matched, ${Object.keys(report.coverage).length}/${inventory.length} rules with positive oracle coverage. ${path.relative(root, output)}/report.json`);
process.exitCode = report.passed ? 0 : 1;
