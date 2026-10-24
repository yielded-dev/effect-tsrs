import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import getExePath from "@effect/tsgo/lib/getExePath";
import { argumentsFor, root, writeJson } from "./harness.mjs";

// Exercise project selection and implicit defaults through the actual CLIs.
// Unlike rule-isolation tests, these cases do not force a rule allowlist.
const args = argumentsFor({ binary: "target/release/effect-tsrs", output: "artifacts/verify-project" });
const output = path.resolve(root, args.output);
const binary = path.resolve(root, args.binary);
const require = createRequire(import.meta.url);
const backendVersion = require("oxlint-tsgolint/package.json").version;
const backend = path.join(path.dirname(require.resolve(`@effect/tsgo-${process.platform}-${process.arch}/package.json`)), "artifacts/oxlint-tsgolint", backendVersion, `tsgolint${process.platform === "win32" ? ".exe" : ""}`);
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
  { name: "typescript-error", config: configured(["main.ts"]), files: { "main.ts": 'export const value: number = "wrong";\n' }, expected: [], typeCheck: [2322] },
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
for (const near of ["a", "z"]) {
  const other = near === "a" ? "z" : "a";
  for (const order of [["a", "z"], ["z", "a"]]) {
    for (const membership of ["root", "import", "redirect"]) {
      const wide = configured(membership === "root" ? [`../${near}/main.ts`] : ["main.ts"], { diagnosticSeverity: { floatingEffect: "off" } });
      if (membership === "redirect") wide.references = [{ path: `../${near}` }];
      cases.push({
        name: `overlap-${membership}-${near}-${order.join("")}`,
        config: { files: [], references: order.map(name => ({ path: `./${name}` })) },
        files: {
          [`${near}/tsconfig.json`]: configured(["main.ts"]), [`${near}/main.ts`]: floating,
          [`${other}/tsconfig.json`]: wide,
          ...(membership === "root" ? {} : { [`${other}/main.ts`]: `import "../${near}/main.js";\n` }),
        },
        expected: near === "a" || membership === "redirect" ? [["floatingEffect", "error"]] : [],
        counts: { totalFiles: membership === "root" ? 1 : 2, filesChecked: membership === "root" ? 1 : 2, filesWithoutPlugin: 0 },
      });
    }
  }
}
for (const absent of ["without-plugin", "null-severity"]) {
  cases.push({
    name: `overlap-import-${absent}`,
    config: { files: [], references: [{ path: "./z" }, { path: "./a" }] },
    files: {
      "a/tsconfig.json": absent === "without-plugin" ? { compilerOptions, files: ["main.ts"] } : configured(["main.ts"], { diagnosticSeverity: null }),
      "a/main.ts": 'import "../z/main.js";\n',
      "z/tsconfig.json": configured(["main.ts"]), "z/main.ts": floating,
    }, expected: [], counts: { totalFiles: 2, filesChecked: 0, filesWithoutPlugin: 2 },
  });
}
for (const order of [["a", "b", "z"], ["z", "b", "a"]]) {
  cases.push({
    name: `overlap-multiple-direct-${order.join("")}`,
    config: { files: [], references: order.map(name => ({ path: `./${name}` })) },
    files: {
      "a/tsconfig.json": { ...configured(["main.ts"], { diagnosticSeverity: { floatingEffect: "off" } }), references: [{ path: "../z" }] },
      "a/main.ts": 'import "../z/main.js";\n',
      "b/tsconfig.json": configured(["../z/main.ts"]),
      "z/tsconfig.json": configured(["main.ts"]), "z/main.ts": floating,
    },
    expected: [], counts: { totalFiles: 2, filesChecked: 2, filesWithoutPlugin: 0 },
  });
}
const unusedDirective = "// @effect-diagnostics-next-line floatingEffect:off\nexport const marker = 1;\n";
const referenceConfig = files => ({ compilerOptions: { ...compilerOptions, composite: true, noEmit: false, rootDir: "..", plugins: [plugin({})] }, files });
for (const [name, file] of [["unicode", "İ.ts"], ["ascii", "Main.ts"]]) {
  cases.push({
    name: `canonical-root-${name}`, config: configured([file]), files: { [file]: floating },
    expected: [["floatingEffect", "error"]], counts: { totalFiles: 1, filesChecked: 1, filesWithoutPlugin: 0 }, typeCheck: [],
    oxlintFiles: [file], oxlintExpected: 1,
  });
}
for (const order of [["İ", "z"], ["z", "İ"]]) {
  const unicodeConfig = referenceConfig(["../main.ts"]);
  unicodeConfig.compilerOptions.plugins = [plugin({ diagnosticSeverity: { floatingEffect: "warning" } })];
  cases.push({
    name: `canonical-project-order-${order[0] === "z" ? "z-first" : "unicode-first"}`,
    config: { files: [], references: order.map(name => ({ path: `./${name}` })) },
    files: {
      "İ/tsconfig.json": unicodeConfig, "z/tsconfig.json": referenceConfig(["../main.ts"]), "main.ts": floating,
    },
    expected: [["floatingEffect", "error"]], counts: { totalFiles: 1, filesChecked: 1, filesWithoutPlugin: 0 }, typeCheck: [],
  });
}
for (const order of [["a", "z"], ["z", "a"]]) {
  for (const redirected of [false, true]) {
    const importer = referenceConfig(["main.ts"]);
    importer.compilerOptions.composite = redirected;
    importer.compilerOptions.plugins = [plugin({ diagnosticSeverity: { floatingEffect: "warning" } })];
    if (redirected) importer.references = [{ path: "../z" }];
    cases.push({
      name: `canonical-${redirected ? "redirect" : "import"}-${order.join("")}`,
      config: { files: [], references: order.map(name => ({ path: `./${name}` })) },
      files: {
        "a/tsconfig.json": importer, "a/main.ts": 'import "../z/İ.js";\n',
        "z/tsconfig.json": referenceConfig(["İ.ts"]), "z/İ.ts": floating,
      },
      expected: [["floatingEffect", redirected ? "error" : "warning"]],
      counts: { totalFiles: 2, filesChecked: 2, filesWithoutPlugin: 0 }, typeCheck: [],
      oxlintFiles: ["z/İ.ts"], oxlintExpected: 1,
    });
  }
}
cases.push({
  name: "canonical-distinct-overlays", config: configured(["İ.ts", "i\u0307.ts"]),
  files: { "İ.ts": "export const value = 1;\n", "i\u0307.ts": "export const value = 1;\n" },
  expected: [], counts: { totalFiles: 2, filesChecked: 2, filesWithoutPlugin: 0 }, typeCheck: [],
  oxlintFiles: ["İ.ts", "i\u0307.ts"], oxlintExpected: 1,
  oxlintOverrides: { "İ.ts": floating, "i\u0307.ts": "export const value = 1;\n" },
});
for (const order of [["a", "b", "z"], ["z", "b", "a"]]) {
  cases.push({
    name: `skipped-reference-${order.join("")}`,
    config: { files: [], references: order.map(name => ({ path: `./${name}` })) },
    files: {
      "a/tsconfig.json": { ...referenceConfig(["main.ts"]), references: [{ path: "../z" }] },
      "a/main.ts": 'import "../z/main.js";\n' + floating,
      "b/tsconfig.json": referenceConfig(["../z/main.ts"]),
      "z/tsconfig.json": referenceConfig(["main.ts"]), "z/main.ts": floating + unusedDirective,
    },
    expected: [["floatingEffect", "error"]], counts: { totalFiles: 2, filesChecked: 2, filesWithoutPlugin: 0 }, typeCheck: [],
  });
}
const declarationDirective = "// @effect-diagnostics-next-line floatingEffect:off\nexport declare const marker: number;\n";
for (const test of [
  { name: "no-check", options: { noCheck: true }, oxlint: true },
  { name: "no-check-ts-check", options: { noCheck: true }, prefix: "// @ts-check\n" },
  { name: "ts-nocheck", prefix: "// @ts-nocheck\n", oxlint: true },
  { name: "tsx-nocheck", extension: "tsx", prefix: "// @ts-nocheck\n", options: { jsx: "react-jsx" } },
  { name: "js-check-false", extension: "js", options: { allowJs: true, checkJs: false }, oxlint: true },
  { name: "jsx-check-false", extension: "jsx", options: { allowJs: true, checkJs: false, jsx: "react-jsx" } },
  { name: "js-nocheck", extension: "js", prefix: "// @ts-nocheck\n", options: { allowJs: true, checkJs: true } },
  { name: "js-default", extension: "js", options: { allowJs: true }, oxlint: true },
  { name: "jsx-default", extension: "jsx", options: { allowJs: true, jsx: "react-jsx" } },
  { name: "js-check-true", extension: "js", options: { allowJs: true, checkJs: true }, active: true },
  { name: "jsx-check-true", extension: "jsx", options: { allowJs: true, checkJs: true, jsx: "react-jsx" }, active: true },
  { name: "js-ts-check", extension: "js", prefix: "// @ts-check\n", options: { allowJs: true, checkJs: false }, active: true },
  { name: "ts-ts-check", prefix: "// @ts-check\n", active: true },
  { name: "no-check-false", options: { noCheck: false }, active: true },
  { name: "json", extension: "json", options: { resolveJsonModule: true }, source: '{\n  "note": "// @effect-diagnostics-next-line floatingEffect:off",\n  "value": 1\n}\n' },
  { name: "declaration-skip", extension: "d.ts", source: declarationDirective },
  { name: "declaration-checked", extension: "d.ts", options: { skipLibCheck: false }, source: declarationDirective },
]) {
  const file = `main.${test.extension ?? "ts"}`;
  const config = configured([file]);
  Object.assign(config.compilerOptions, test.options);
  cases.push({
    name: `eligibility-${test.name}`, config,
    files: { [file]: (test.prefix ?? "") + (test.source ?? (test.active ? floating : floating + unusedDirective)) },
    expected: test.active ? [["floatingEffect", "error"]] : [],
    counts: { totalFiles: 1, filesChecked: 1, filesWithoutPlugin: 0 }, typeCheck: [],
    ...(test.oxlint ? { oxlintFiles: [file], oxlintExpected: 1 } : {}),
  });
}
for (const test of [
  { name: "without-plugin", config: { compilerOptions, files: ["main.ts", "removed.ts"] }, expected: [], counts: { totalFiles: 2, filesChecked: 0, filesWithoutPlugin: 1 } },
  { name: "null-severity", config: configured(["main.ts", "removed.ts"], { diagnosticSeverity: null }), expected: [], counts: { totalFiles: 2, filesChecked: 0, filesWithoutPlugin: 1 } },
  { name: "disabled-plugin", config: configured(["main.ts", "removed.ts"], { diagnostics: false }), expected: [], counts: { totalFiles: 2, filesChecked: 1, filesWithoutPlugin: 0 } },
  { name: "null-override", config: { compilerOptions, files: ["main.ts", "removed.ts"] }, lspconfig: { diagnosticSeverity: null }, expected: [], counts: { totalFiles: 2, filesChecked: 0, filesWithoutPlugin: 0 } },
  { name: "explicit-override", config: { compilerOptions, files: ["main.ts", "removed.ts"] }, lspconfig: {}, expected: [["floatingEffect", "error"]], counts: { totalFiles: 2, filesChecked: 1, filesWithoutPlugin: 0 } },
]) {
  cases.push({ ...test, name: `deleted-root-${test.name}`, files: { "main.ts": floating, "removed.ts": floating }, removed: ["removed.ts"], typeCheck: [6053] });
}
cases.push(
  { name: "deleted-only-root", config: { compilerOptions, files: ["removed.ts"] }, files: { "removed.ts": floating }, removed: ["removed.ts"], expected: [], counts: { totalFiles: 1, filesChecked: 0, filesWithoutPlugin: 0 }, typeCheck: [6053] },
  { name: "deleted-referenced-roots", config: { files: [], references: [{ path: "./app" }, { path: "./lib" }] }, files: {
    "app/tsconfig.json": { compilerOptions, files: ["main.ts", "removed.ts"] }, "app/main.ts": floating, "app/removed.ts": floating,
    "lib/tsconfig.json": configured(["main.ts", "removed.ts"], { diagnosticSeverity: null }), "lib/main.ts": floating, "lib/removed.ts": floating,
  }, removed: ["app/removed.ts", "lib/removed.ts"], expected: [], counts: { totalFiles: 4, filesChecked: 0, filesWithoutPlugin: 2 }, typeCheck: [6053] },
);
const aliasSource = 'import { value } from "provider";\nvalue;\n';
const providerSource = 'import { Effect } from "effect";\nexport const value = Effect.succeed(1);\n';
for (const isRoot of [false, true]) {
  const config = configured(isRoot ? ["main.ts", "shared.ts"] : ["main.ts"]);
  config.compilerOptions.paths = { provider: ["./provider.ts"] };
  cases.push({
    name: `oxlint-${isRoot ? "configured-root" : "imported-nonroot"}`,
    config, files: { "main.ts": 'import "./shared.js";\n', "shared.ts": aliasSource, "provider.ts": providerSource },
    expected: isRoot ? [["floatingEffect", "error"]] : [], oxlintFiles: ["shared.ts"], oxlintExpected: isRoot ? 1 : 0,
  });
}
const aliased = (files, provider) => {
  const config = configured(files);
  config.compilerOptions.paths = { provider: [provider] };
  return config;
};
cases.push({
  name: "oxlint-overlap-nearest-root",
  config: { files: [], references: [{ path: "./z" }, { path: "./a" }] },
  files: {
    "a/tsconfig.json": aliased(["../z/main.ts"], "../plain.ts"),
    "z/tsconfig.json": aliased(["main.ts"], "../provider.ts"), "z/main.ts": aliasSource,
    "plain.ts": "export const value = 1;\n", "provider.ts": providerSource,
  }, expected: [], oxlintFiles: ["z/main.ts"], oxlintExpected: 1,
});
const env = { ...process.env, GOMAXPROCS: "1" };
const sort = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const decodeJson = bytes => bytes.toString("utf8").trim() ? JSON.parse(bytes) : null;
const decodeFrames = bytes => {
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    assert(offset + 5 <= bytes.length, "Truncated frame header");
    const length = bytes.readUInt32LE(offset);
    assert(offset + 5 + length <= bytes.length, "Truncated frame body");
    assert.equal(bytes[offset + 4], 1, "Expected a diagnostic frame");
    frames.push(JSON.parse(bytes.subarray(offset + 5, offset + 5 + length)));
    offset += 5 + length;
  }
  return frames;
};
const report = { passed: false, binarySha256: hash(binary), referenceVersion: JSON.parse(fs.readFileSync(path.join(root, "node_modules/@effect/tsgo/package.json"))).version, referenceBackendVersion: backendVersion, cases: [] };
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
  for (const name of test.removed ?? []) fs.unlinkSync(path.join(project, name));
  if (!fs.existsSync(path.join(project, "node_modules"))) fs.symlinkSync(path.join(root, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const execute = (name, command, argv, { input, decode = decodeJson } = {}) => {
    const result = spawnSync(command, argv, { cwd: project, env, input, timeout: 60000 });
    fs.writeFileSync(path.join(project, name + ".stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(project, name + ".stderr"), result.stderr ?? "");
    assert(!result.error && !result.signal, `${name}: ${result.error ?? result.signal}`);
    return { status: result.status, data: decode(result.stdout), stderr: result.stderr.toString("utf8").trim().replace(/^effect-tsrs: /, "") };
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
    for (const [key, value] of Object.entries(test.counts ?? {})) assert.equal(reference.data.summary[key], value, `Oracle ${key}`);
    assert.deepEqual(row.actual, row.expected);
    {
      const expected = execute("reference-strict", getExePath(), ["--effect-cli-diagnostics", JSON.stringify({ ...request, strict: true })]);
      const actual = execute("candidate-strict", binary, ["diagnostics", "-p", "tsconfig.json", "--format", "json", "--strict", ...configArgs]);
      assert.deepEqual(normalize(actual), normalize(expected));
    }
    if (test.typeCheck) {
      const checked = execute("candidate-type-check", binary, ["diagnostics", "-p", "tsconfig.json", "--format", "json", "--type-check", ...configArgs]);
      assert.equal(checked.status, test.typeCheck.length ? 1 : reference.status);
      assert.deepEqual(checked.data.summary, reference.data.summary);
      assert.deepEqual(normalize(checked).diagnostics, row.expected.diagnostics);
      if (!test.typeCheck.length) assert.deepEqual((checked.data.typescriptDiagnostics ?? []).filter(d => d.severity === "error"), []);
      for (const code of test.typeCheck) assert(checked.data.typescriptDiagnostics.some(d => d.code === code), `Missing TypeScript diagnostic ${code}`);
    }
    if (test.oxlintFiles) {
      const input = JSON.stringify({
        version: 2, configs: [{ file_paths: test.oxlintFiles.map(file => path.join(project, file)), rules: [{ name: "effecttsgo/floating-effect" }] }],
        ...(test.oxlintOverrides ? { source_overrides: Object.fromEntries(Object.entries(test.oxlintOverrides).map(([file, source]) => [path.join(project, file), source])) } : {}),
      });
      const normalizeHeadless = result => ({ status: result.status, diagnostics: sort(result.data.map(d => {
        const { labeled_ranges = [], ...diagnostic } = d;
        return { ...diagnostic, file_path: path.relative(project, d.file_path).replaceAll("\\", "/"), labeled_ranges };
      })) });
      const expected = normalizeHeadless(execute("reference-oxlint", backend, ["headless"], { input, decode: decodeFrames }));
      const actual = normalizeHeadless(execute("candidate-oxlint", binary, ["headless"], { input, decode: decodeFrames }));
      row.oxlint = { expected, actual };
      assert.equal(expected.status, 0);
      assert.equal(expected.diagnostics.length, test.oxlintExpected, "Oxlint oracle did not exercise the intended behavior");
      assert.deepEqual(actual, expected);
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
