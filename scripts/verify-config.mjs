import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import getExePath from "@effect/tsgo/lib/getExePath";

// Usage: node scripts/verify-config.mjs [--binary PATH] [--output DIR]
// The fixtures and complete native/candidate process output are retained under
// output. These checks deliberately do not pass --lspconfig: tsconfig merging
// and native compiler-option diagnostics are part of the behavior under test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { binary: "target/debug/effect-tsrs", output: "artifacts/verify-config" };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index].replace(/^--/, "");
  if (!Object.hasOwn(args, name) || !process.argv[index].startsWith("--") || !process.argv[index + 1]) {
    throw new Error("Expected --binary PATH and/or --output DIR");
  }
  args[name] = process.argv[index + 1];
}
const binary = path.resolve(root, args.binary);
const output = path.resolve(root, args.output);
const native = getExePath();
const environment = { ...process.env, GOMAXPROCS: "1", RAYON_NUM_THREADS: "1" };
const catalog = JSON.parse(fs.readFileSync(path.join(root, "fixtures/rule-catalog.json"), "utf8"));
assert(catalog.length >= 130 && new Set(catalog.map((rule) => rule.name)).size === catalog.length, "Incomplete rule catalog");
const allOff = Object.fromEntries(catalog.map((rule) => [rule.name, "off"]));
const rules = ["floatingEffect", "unnecessaryPipe"];
const plugin = (options) => ({ name: "@effect/language-service", ...options });
const basic = 'import { Effect, pipe } from "effect"\nEffect.succeed(1)\nexport const value = pipe(1)\n';
const cases = [
  { name: "severity-merge", base: { diagnosticSeverity: { ...allOff, floatingEffect: "off", unnecessaryPipe: "warning" } }, child: { diagnosticSeverity: { unnecessaryPipe: "error" } }, source: basic, expected: [[377013, "error"]] },
  { name: "scalar-inheritance", base: { diagnostics: false, diagnosticSeverity: { ...allOff, floatingEffect: "warning" } }, child: { diagnosticSeverity: { unnecessaryPipe: "error" } }, source: basic, expected: [] },
  { name: "override-path-and-append", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" }, overrides: [{ include: ["../src/**/*.ts"], options: { diagnosticSeverity: { floatingEffect: "error" } } }] }, child: { overrides: [{ include: ["../src/**/*.ts"], options: { diagnosticSeverity: { unnecessaryPipe: "warning" } } }] }, source: basic, expected: [[377001, "error"], [377013, "warning"]] },
  { name: "override-later-wins", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" }, overrides: [{ include: ["../src/**/*.ts"], options: { diagnosticSeverity: { floatingEffect: "off" } } }] }, child: { overrides: [{ include: ["../src/**/*.ts"], options: { diagnosticSeverity: { floatingEffect: "error" } } }] }, source: basic, expected: [[377001, "error"]] },
  { name: "unused-next", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" } }, child: {}, source: "// @effect-diagnostics-next-line floatingEffect:off\nexport const value = 1\n", expected: [[377000, "warning"]] },
  { name: "used-next", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" } }, child: {}, source: 'import { Effect } from "effect"\n// @effect-diagnostics-next-line floatingEffect:off\nEffect.succeed(1)\n', expected: [] },
  { name: "suggestion", base: { diagnosticSeverity: { ...allOff, unnecessaryPipe: "message" } }, child: {}, source: basic, expected: [[377013, "message"]] },
  { name: "unused-wildcard", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" } }, child: {}, source: "// @effect-diagnostics-next-line *:off\nexport const value = 1\n", expected: [] },
  { name: "unused-skip-file", base: { diagnosticSeverity: { ...allOff, floatingEffect: "warning" } }, child: {}, source: "// @effect-diagnostics *:skip-file\n// @effect-diagnostics-next-line floatingEffect:off\nexport const value = 1\n", expected: [] },
  { name: "unknown-local", base: { diagnosticSeverity: { ...allOff } }, child: { diagnosticSeverity: { floatingEfect: "off", unknownRuleName: "error" } }, source: "export const value = 1\n", expected: [], unknown: "local" },
  { name: "unknown-inherited", base: { diagnosticSeverity: { ...allOff, floatingEfect: "off" } }, child: { diagnosticSeverity: { unknownRuleName: "error" } }, source: "export const value = 1\n", expected: [], unknown: "inherited" },
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function prepare(test) {
  const project = path.join(output, "cases", test.name);
  const marker = path.join(project, ".verify-config-fixture.json");
  if (fs.existsSync(project) && fs.readdirSync(project).length && !fs.existsSync(marker)) {
    throw new Error(`Refusing to overwrite an unowned fixture directory: ${project}`);
  }
  fs.mkdirSync(project, { recursive: true });
  writeJson(marker, { generator: "scripts/verify-config.mjs", case: test.name });
  for (const directory of ["base", "app", "src"]) fs.mkdirSync(path.join(project, directory), { recursive: true });
  const modules = path.join(project, "node_modules");
  if (fs.existsSync(modules)) {
    assert.equal(fs.realpathSync(modules), fs.realpathSync(path.join(root, "node_modules")), "Fixture uses unexpected dependencies");
  } else {
    fs.symlinkSync(path.join(root, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
  }
  writeJson(path.join(project, "package.json"), { name: "effect-tsrs-config-verification", private: true, type: "module" });
  writeJson(path.join(project, "base/tsconfig.json"), { compilerOptions: { plugins: [plugin(test.base)] } });
  writeJson(path.join(project, "app/tsconfig.json"), {
    extends: "../base/tsconfig.json",
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, skipLibCheck: true, plugins: [plugin(test.child)] },
    files: ["../src/index.ts"],
  });
  fs.writeFileSync(path.join(project, "src/index.ts"), test.source);
  return project;
}

function execute(command, argv, prefix, json, strict = false) {
  const start = performance.now();
  const result = spawnSync(command, argv, { cwd: root, env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const record = { command, args: argv, status: result.status, signal: result.signal, error: result.error?.message ?? null, elapsedMs: performance.now() - start };
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  fs.writeFileSync(`${prefix}.stdout.${json ? "json" : "txt"}`, result.stdout ?? "");
  fs.writeFileSync(`${prefix}.stderr.txt`, result.stderr ?? "");
  writeJson(`${prefix}.process.json`, record);
  assert(!result.error && !result.signal && [0, 1, 2].includes(result.status), `Process failed: ${prefix}`);
  assert(!/panicked at|fatal error:|runtime error:|thread .*panicked/.test(result.stderr ?? ""), `Compiler panic: ${prefix}`);
  if (!json) return { ...record, stdout: result.stdout };
  const data = JSON.parse(result.stdout);
  assert(Array.isArray(data.diagnostics), `Missing diagnostics array: ${prefix}`);
  const expectedStatus = data.summary.errors > 0 || (strict && data.summary.warnings > 0) || (data.typescriptDiagnostics ?? []).some((diagnostic) => diagnostic.severity === "error" || (strict && diagnostic.severity === "warning")) ? 1 : 0;
  assert.equal(result.status, expectedStatus, `Incorrect diagnostic exit status: ${prefix}`);
  assert(data.summary.filesChecked >= 1, `No files checked: ${prefix}`);
  return { ...record, data };
}

function relative(file, project) {
  return path.relative(project, path.isAbsolute(file) ? file : path.resolve(root, file)).split(path.sep).join("/");
}

const positionFields = ["start", "length", "line", "column", "endLine", "endColumn"];
function normalizeLocation(diagnostic, project) {
  assert.equal(typeof diagnostic.file, "string", "Missing diagnostic file");
  const location = { file: relative(diagnostic.file, project) };
  for (const name of positionFields) {
    assert(Number.isInteger(diagnostic[name]), `Missing or invalid ${name}`);
    location[name] = diagnostic[name];
  }
  const text = fs.readFileSync(path.resolve(project, location.file), "utf8");
  const at = (offset) => {
    const lines = text.slice(0, offset).split(/\r\n|\r|\n|\u2028|\u2029/);
    return [lines.length, lines.at(-1).length + 1];
  };
  assert(diagnostic.start >= 0 && diagnostic.length > 0 && diagnostic.start + diagnostic.length <= text.length, "Diagnostic range lies outside source");
  assert.deepEqual(at(diagnostic.start), [diagnostic.line, diagnostic.column], "Start position disagrees with source");
  assert.deepEqual(at(diagnostic.start + diagnostic.length), [diagnostic.endLine, diagnostic.endColumn], "End position disagrees with source");
  return location;
}

function normalizeEffect(data, project) {
  return data.diagnostics.map((diagnostic) => {
    assert(Number.isInteger(diagnostic.code) && typeof diagnostic.message === "string", "Invalid Effect diagnostic");
    assert(["error", "warning", "message"].includes(diagnostic.severity), "Unknown severity");
    const name = diagnostic.code === 377000 ? "unusedDirective" : diagnostic.name;
    if (diagnostic.code === 377000) assert(["unusedDirective", "effect(377000)"].includes(diagnostic.name), "Unexpected metadata diagnostic name");
    assert([...rules, "unusedDirective"].includes(name), `Unexpected rule: ${name}`);
    const relatedInformation = (diagnostic.relatedInformation ?? []).map((related) => ({ ...normalizeLocation(related, project), code: related.code, message: related.message }));
    return { ...normalizeLocation(diagnostic, project), severity: diagnostic.severity, code: diagnostic.code, name, message: diagnostic.message, relatedInformation };
  }).sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start || left.code - right.code);
}

function parseCompiler(result, project) {
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const located = /^(.*?)\((\d+),(\d+)\): (error|warning|message) TS(\d+): (.*)$/.exec(line);
    const plain = /^(error|warning|message) TS(\d+): (.*)$/.exec(line);
    assert(located || plain, `Unrecognized native compiler output: ${line}`);
    const message = (located ? located[6] : plain[3]).replace(/ effect\(unknownRuleName\)$/, "");
    return located
      ? { file: relative(located[1], project), line: Number(located[2]), column: Number(located[3]), severity: located[4], code: Number(located[5]), message }
      : { file: "", line: 0, column: 0, severity: plain[1], code: Number(plain[2]), message };
  // Native tsc also prints semantic Effect diagnostics, which are compared in
  // full through its JSON API above. Only unknownRuleName belongs to the
  // candidate's compiler-diagnostic collection.
  }).filter(({ code }) => code < 377000 || code > 377999 || code === 377134)
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.code - right.code);
}

function normalizeCompiler(data, project) {
  assert(Array.isArray(data.typescriptDiagnostics), "Missing compiler diagnostics array");
  return data.typescriptDiagnostics.map((diagnostic) => ({ file: diagnostic.location ? relative(diagnostic.location.file, project) : "", line: diagnostic.location?.line ?? 0, column: diagnostic.location?.column ?? 0, severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message }))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.code - right.code);
}

const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), passed: false,
  binary: { path: binary, sha256: sha256(binary) },
  native: { path: native, sha256: sha256(native), version: JSON.parse(fs.readFileSync(path.join(root, "node_modules/@effect/tsgo/package.json"), "utf8")).version },
  effectVersion: JSON.parse(fs.readFileSync(path.join(root, "node_modules/effect/package.json"), "utf8")).version,
  scriptSha256: sha256(fileURLToPath(import.meta.url)),
  normalizations: ["Absolute paths are relative to each generated project.", "Native unnamed code 377000 is named unusedDirective.", "The native compiler's trailing effect(unknownRuleName) message tag is omitted."],
  cases: [],
};
writeJson(path.join(output, "report.json"), report);
try {
  for (const test of cases) {
    const project = prepare(test);
    const config = path.join(project, "app/tsconfig.json");
    const prefix = path.join(project, "results");
    const reference = execute(native, ["--effect-cli-diagnostics", JSON.stringify({ cwd: path.join(project, "app"), project: "tsconfig.json", format: "json", strict: false, progress: false })], `${prefix}/native-effect`, true);
    const candidate = execute(binary, ["diagnostics", "--type-check", "-p", config, "--format", "json", "--rules", rules.join(",")], `${prefix}/candidate`, true);
    const compiler = execute(native, ["--noEmit", "--pretty", "false", "-p", config], `${prefix}/native-compiler`, false);
    const expected = normalizeEffect(reference.data, project);
    const actual = normalizeEffect(candidate.data, project);
    const expectedCompiler = parseCompiler(compiler, project);
    const actualCompiler = normalizeCompiler(candidate.data, project);
    const comparison = { name: test.name, passed: false, expected, actual, expectedCompiler, actualCompiler };
    report.cases.push(comparison);
    writeJson(`${prefix}/comparison.json`, comparison);
    // Check intended positive counts before parity: two broken implementations
    // returning no diagnostics must never pass the positive fixtures.
    assert.deepEqual(expected.map(({ code, severity }) => [code, severity]), test.expected, `Native fixture did not exercise ${test.name}`);
    assert.deepEqual(actual, expected, `Effect diagnostics differ for ${test.name}`);
    assert.deepEqual(actualCompiler, expectedCompiler, `Compiler diagnostics differ for ${test.name}`);
    assert.deepEqual(expectedCompiler.map(({ code, severity }) => [code, severity]), test.unknown ? [[377134, "error"]] : [], `Unexpected native compiler result for ${test.name}`);
    const strictReference = execute(native, ["--effect-cli-diagnostics", JSON.stringify({ cwd: path.join(project, "app"), project: "tsconfig.json", format: "json", strict: true, progress: false })], `${prefix}/native-effect-strict`, true, true);
    const strictCandidate = execute(binary, ["diagnostics", "--type-check", "-p", config, "--format", "json", "--rules", rules.join(","), "--strict"], `${prefix}/candidate-strict`, true, true);
    assert.deepEqual(normalizeEffect(strictReference.data, project), expected, `Native --strict changed diagnostics for ${test.name}`);
    assert.deepEqual(strictCandidate.data.diagnostics, candidate.data.diagnostics, `--strict changed diagnostics for ${test.name}`);
    assert.deepEqual(strictCandidate.data.typescriptDiagnostics, candidate.data.typescriptDiagnostics, `--strict changed compiler diagnostics for ${test.name}`);
    assert.deepEqual(strictCandidate.data.summary, candidate.data.summary, `--strict changed summary for ${test.name}`);
    const expectedStrictStatus = test.unknown || test.expected.some(([, severity]) => severity === "error" || severity === "warning") ? 1 : 0;
    assert.equal(strictCandidate.status, expectedStrictStatus, `Incorrect --strict exit status for ${test.name}`);
    if (test.name === "unused-next") {
      const textArgs = ["diagnostics", "--type-check", "-p", config, "--format", "text", "--rules", rules.join(",")];
      const plainText = execute(binary, textArgs, `${prefix}/candidate-text`, false);
      const strictText = execute(binary, [...textArgs, "--strict"], `${prefix}/candidate-text-strict`, false);
      assert.equal(plainText.status, 0, "Text warnings must pass by default");
      assert.equal(strictText.status, 1, "Text warnings must fail with --strict");
      assert.equal(strictText.stdout, plainText.stdout, "--strict changed text output");
    }
    if (test.unknown === "local") {
      const diagnostic = candidate.data.typescriptDiagnostics[0];
      const location = normalizeLocation(diagnostic.location, project);
      assert.equal(location.file, "app/tsconfig.json");
      const source = fs.readFileSync(config, "utf8");
      assert.equal(source.slice(location.start, location.start + location.length), '"floatingEfect"', "Wrong unknown-rule underline");
    } else if (test.unknown === "inherited") {
      assert.equal(candidate.data.typescriptDiagnostics[0].location, undefined, "Inherited typo must remain locationless");
    }
    comparison.passed = true;
    writeJson(`${prefix}/comparison.json`, comparison);
    writeJson(path.join(output, "report.json"), report);
    console.log(`${test.name}: exact parity (${actual.length} Effect, ${actualCompiler.length} compiler diagnostics)`);
  }
  assert.equal(report.cases.length, cases.length, "Incomplete configuration coverage");
  assert(report.cases.filter((test) => test.actual.length > 0).length >= 4, "Missing positive Effect checks");
  assert.equal(report.cases.filter((test) => test.actualCompiler.length > 0).length, 2, "Missing positive metadata checks");
  assert.equal(sha256(binary), report.binary.sha256, "Candidate executable changed during verification");
  report.passed = true;
  console.log(`Configuration verification passed. Evidence: ${path.relative(root, output)}/report.json`);
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeJson(path.join(output, "report.json"), report);
}
