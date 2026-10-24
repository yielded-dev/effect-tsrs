import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import getExePath from "@effect/tsgo/lib/getExePath";
import { argumentsFor, root, writeJson } from "./harness.mjs";

// Exercise project selection and implicit defaults through the actual CLIs.
// Unlike rule-isolation tests, these cases do not force a rule allowlist.
const args = argumentsFor({ binary: "target/release/effect-tsrs", output: "artifacts/verify-project" });
const output = path.resolve(root, args.output);
const binary = path.resolve(root, args.binary);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const compilerOptions = { module: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: true };
const plugin = options => ({ name: "@effect/language-service", ...options });
const source = 'import { Effect, pipe } from "effect";\nEffect.succeed(1);\nexport const value = pipe(1);\n';
const floating = 'import { Effect } from "effect";\nEffect.succeed(1);\n';
const configured = (files, options = {}) => ({ compilerOptions: { ...compilerOptions, plugins: [plugin(options)] }, files });
const cases = [
  { name: "upstream-defaults", config: configured(["main.ts"]), files: { "main.ts": source }, expected: [["floatingEffect", "error"], ["unnecessaryPipe", "message"]] },
  { name: "partial-severity-map", config: configured(["main.ts"], { diagnosticSeverity: { floatingEffect: "off", unnecessaryPipe: "warning" } }), files: { "main.ts": source }, expected: [["unnecessaryPipe", "warning"]] },
  { name: "without-plugin", config: { compilerOptions, files: ["main.ts"] }, files: { "main.ts": source }, expected: [] },
  { name: "explicit-lspconfig", config: { compilerOptions, files: ["main.ts"] }, lspconfig: {}, files: { "main.ts": source }, expected: [["floatingEffect", "error"], ["unnecessaryPipe", "message"]] },
  { name: "disabled-plugin", config: configured(["main.ts"], { diagnostics: false }), files: { "main.ts": source }, expected: [] },
  { name: "null-severity", config: configured(["main.ts"], { diagnosticSeverity: null }), files: { "main.ts": source }, expected: [] },
  { name: "tsc-suggestion-option", config: configured(["main.ts"], { includeSuggestionsInTsc: false }), files: { "main.ts": source }, expected: [["floatingEffect", "error"], ["unnecessaryPipe", "message"]] },
  { name: "imported-nonroot", config: configured(["main.ts"]), files: { "main.ts": 'import "./shared.js";\n' + floating, "shared.ts": floating }, expected: [["floatingEffect", "error"]] },
  { name: "excluded-import", config: { ...configured(undefined), files: undefined, include: ["src/**/*.ts"], exclude: ["src/excluded.ts"] }, files: { "src/main.ts": 'import "./excluded.js";\n' + floating, "src/excluded.ts": floating }, expected: [["floatingEffect", "error"]] },
  { name: "declaration-root", config: configured(["main.ts", "types.d.ts"]), files: { "main.ts": floating, "types.d.ts": 'export declare const value: number;\n' }, expected: [["floatingEffect", "error"]] },
  { name: "typescript-error", config: configured(["main.ts"]), files: { "main.ts": 'export const value: number = "wrong";\n' }, expected: [], typeCheck: true },
  { name: "project-references", config: { files: [], references: [{ path: "./app" }, { path: "./lib" }] }, files: {
    "app/tsconfig.json": { ...configured(["main.ts"], { diagnosticSeverity: { floatingEffect: "warning" } }), references: [{ path: "../lib" }] },
    "app/main.ts": 'import "../lib/main.js";\n' + floating,
    "lib/tsconfig.json": configured(["main.ts"]), "lib/main.ts": floating,
  }, expected: [["floatingEffect", "error"], ["floatingEffect", "warning"]] },
  { name: "reference-without-plugin", config: { files: [], references: [{ path: "./app" }, { path: "./lib" }] }, files: {
    "app/tsconfig.json": configured(["main.ts"]), "app/main.ts": floating,
    "lib/tsconfig.json": { compilerOptions, files: ["main.ts"] }, "lib/main.ts": floating,
  }, expected: [["floatingEffect", "error"]] },
  { name: "overlapping-reference-roots", config: { files: [], references: [{ path: "./wide" }, { path: "./specific" }] }, files: {
    "wide/tsconfig.json": configured(["../specific/main.ts"], { diagnosticSeverity: { floatingEffect: "off" } }),
    "specific/tsconfig.json": configured(["main.ts"]), "specific/main.ts": floating,
  }, expected: [["floatingEffect", "error"]] },
  { name: "empty-project", config: { files: [] }, files: {}, error: "No files to check. Please provide an existing .ts file or a project tsconfig.json" },
  { name: "disabled-reference-loading", config: { compilerOptions: { disableReferencedProjectLoad: true }, files: [], references: [{ path: "./app" }] }, files: {
    "app/tsconfig.json": configured(["main.ts"]), "app/main.ts": floating,
  }, error: "No files to check. Please provide an existing .ts file or a project tsconfig.json" },
];
const env = { ...process.env, GOMAXPROCS: "1" };
const sort = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const report = { passed: false, binarySha256: hash(binary), referenceVersion: JSON.parse(fs.readFileSync(path.join(root, "node_modules/@effect/tsgo/package.json"))).version, cases: [] };
for (const test of cases) {
  const project = path.join(output, test.name);
  fs.mkdirSync(project, { recursive: true });
  writeJson(path.join(project, "package.json"), { private: true, type: "module" });
  writeJson(path.join(project, "tsconfig.json"), test.config);
  for (const [name, content] of Object.entries(test.files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    if (typeof content === "string") fs.writeFileSync(path.join(project, name), content);
    else writeJson(path.join(project, name), content);
  }
  if (!fs.existsSync(path.join(project, "node_modules"))) fs.symlinkSync(path.join(root, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const execute = (name, command, argv) => {
    const result = spawnSync(command, argv, { cwd: project, env, encoding: "utf8", timeout: 60000 });
    fs.writeFileSync(path.join(project, name + ".stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(project, name + ".stderr"), result.stderr ?? "");
    assert(!result.error && !result.signal, `${name}: ${result.error ?? result.signal}`);
    return { status: result.status, data: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr.trim().replace(/^effect-tsrs: /, "") };
  };
  const normalize = result => ({ status: result.status, summary: result.data.summary, diagnostics: sort(result.data.diagnostics.map(d => {
    const { relatedInformation = [], ...diagnostic } = d;
    return { ...diagnostic, file: path.relative(project, d.file).replaceAll("\\", "/"), relatedInformation };
  })) });
  const row = { name: test.name, passed: false };
  report.cases.push(row);
  try {
    const configArgs = test.lspconfig === undefined ? [] : ["--lspconfig", JSON.stringify(test.lspconfig)];
    const request = { cwd: project, project: "tsconfig.json", format: "json", ...(test.lspconfig === undefined ? {} : { lspconfig: JSON.stringify(test.lspconfig) }) };
    const reference = execute("reference", getExePath(), ["--effect-cli-diagnostics", JSON.stringify(request)]);
    const candidate = execute("candidate", binary, ["diagnostics", "-p", "tsconfig.json", "--format", "json", ...configArgs]);
    if (test.error) {
      assert.deepEqual(reference, { status: 1, data: null, stderr: test.error });
      assert.deepEqual(candidate, reference);
      row.passed = true;
      console.log(`${test.name}: passed`);
      writeJson(path.join(output, "report.json"), report);
      continue;
    }
    row.expected = normalize(reference); row.actual = normalize(candidate);
    assert.deepEqual(sort(reference.data.diagnostics.map(d => [d.name, d.severity])), sort(test.expected), "Oracle did not exercise the intended behavior");
    assert.deepEqual(row.actual, row.expected);
    {
      const expected = execute("reference-strict", getExePath(), ["--effect-cli-diagnostics", JSON.stringify({ ...request, strict: true })]);
      const actual = execute("candidate-strict", binary, ["diagnostics", "-p", "tsconfig.json", "--format", "json", "--strict", ...configArgs]);
      assert.deepEqual(normalize(actual), normalize(expected));
    }
    if (test.typeCheck) {
      const checked = execute("candidate-type-check", binary, ["diagnostics", "-p", "tsconfig.json", "--format", "json", "--type-check"]);
      assert.equal(checked.status, 1);
      assert(checked.data.typescriptDiagnostics.some(d => d.code === 2322));
    }
    row.passed = true;
  } catch (error) { row.error = error.stack; }
  console.log(`${test.name}: ${row.passed ? "passed" : "FAILED"}`);
  writeJson(path.join(output, "report.json"), report);
}
report.passed = report.cases.every(c => c.passed);
assert.equal(hash(binary), report.binarySha256, "Executable changed during verification");
writeJson(path.join(output, "report.json"), report);
if (!report.passed) process.exitCode = 1;
