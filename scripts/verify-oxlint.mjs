import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverOxlint, patchOxlint } from "../bin/oxlint.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = { binary: "target/release/effect-tsrs", output: "artifacts/verify-oxlint" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  assert(Object.hasOwn(args, key) && process.argv[i + 1], "Expected --binary PATH or --output DIR");
  args[key] = process.argv[i + 1];
}
const binary = path.resolve(root, args.binary);
const output = path.resolve(root, args.output);
fs.mkdirSync(output, { recursive: true });
const found = discoverOxlint(binary, output);
const require = createRequire(path.join(output, "package.json"));
const upstream = path.dirname(require.resolve(`@effect/tsgo-${process.platform}-${process.arch}/package.json`));
const oracle = path.join(upstream, "artifacts/oxlint-tsgolint", found.backendVersion, `tsgolint${process.platform === "win32" ? ".exe" : ""}`);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const report = { passed: false, binarySha256: hash(binary), oxlint: found.version, backend: found.backendVersion, checks: [] };
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`); };
const sort = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const project = path.join(output, "project");
const config = { plugins: ["effecttsgo", "typescript"], categories: { correctness: "off" }, rules: { "effecttsgo/floating-effect": "error", "effecttsgo/async-function": "warn", "effecttsgo/missing-star-in-yield-effect-gen": "error", "effecttsgo/strict-boolean-expressions": "error", "typescript/no-floating-promises": "error" }, overrides: [{ files: ["Disabled.ts"], rules: { "effecttsgo/floating-effect": "off" } }] };
const compilerOptions = { module: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: true };
write(path.join(project, "package.json"), { type: "module" });
write(path.join(project, ".oxlintrc.json"), config);
write(path.join(project, "tsconfig.json"), { compilerOptions: { ...compilerOptions, plugins: [{ name: "@effect/language-service", diagnostics: false, diagnosticSeverity: { floatingEffect: "off" }, overrides: [{ include: ["**/*.ts"], options: { diagnosticSeverity: { floatingEffect: "off" } } }] }] }, include: ["*.ts"], exclude: ["Excluded.ts"] });
const main = `import { Effect } from "effect";
const unicode = "👋"; Effect.succeed(1);
// eslint-disable-next-line effecttsgo/floating-effect
Effect.succeed(2);
// @effect-diagnostics-next-line floatingEffect:off
Effect.succeed(3);
Promise.resolve(1);
export async function f() { return 1; }
export const related = Effect.gen(function* () { yield Effect.succeed(1); });
`;
write(path.join(project, "Main.ts"), main);
write(path.join(project, "Disabled.ts"), 'import { Effect } from "effect";\nEffect.succeed(1);\n');
write(path.join(project, "Duplicates.ts"), 'type Variant = { kind: "a"; value?: { id: string } } | { kind: "b"; value?: { id: string } } | { kind: "c"; value?: { id: string } };\ndeclare const input: Variant;\nexport const invalid = !input.value;\n');
write(path.join(project, "Excluded.ts"), 'import { Effect } from "effect";\nEffect.succeed(1);\n');
// Explicit paths also exercise fixtures under git-ignored artifact directories.
const paths = ["Main.ts", "Disabled.ts", "Duplicates.ts", "Excluded.ts"];
function execute(label, command, argv, cwd, env = {}, input) {
  const result = spawnSync(command, argv, { cwd, env: { ...process.env, ...env }, input, timeout: 120_000, maxBuffer: 16 << 20 });
  write(path.join(output, `${label}.stdout`), result.stdout ?? Buffer.alloc(0));
  write(path.join(output, `${label}.stderr`), result.stderr ?? Buffer.alloc(0));
  assert(!result.error && !result.signal, `${label}: ${result.error?.message ?? result.signal}`);
  return result;
}
function lint(label, rust, extra = [], cwd = project, files = paths, patched = false) {
  const argv = rust && !patched ? [path.join(root, "bin/effect-tsrs.js"), "oxlint"] : [patched ? path.join(cwd, "node_modules/oxlint/bin/oxlint") : found.cli, "--type-aware"];
  const env = rust ? { EFFECT_TSRS_BINARY: binary } : { NAPI_RS_NATIVE_LIBRARY_PATH: found.frontend, OXLINT_TSGOLINT_PATH: oracle };
  const result = execute(label, process.execPath, [...argv, "--format", "json", ...extra, ...files], cwd, env);
  const json = JSON.parse(result.stdout);
  return { status: result.status, diagnostics: sort(json.diagnostics), files: json.number_of_files };
}
function parity(name, extra = [], cwd = project, files = paths) {
  const rust = lint(`${name}-rust`, true, extra, cwd, files);
  const go = lint(`${name}-go`, false, extra, cwd, files);
  assert.deepEqual(rust, go, name);
  report.checks.push({ name, diagnostics: rust.diagnostics.length });
  return rust;
}
function frames(buffer) {
  const values = [];
  for (let i = 0; i < buffer.length;) {
    assert(i + 5 <= buffer.length, "Truncated frame");
    const length = buffer.readUInt32LE(i), kind = buffer[i + 4];
    assert(i + 5 + length <= buffer.length, "Truncated payload");
    const data = JSON.parse(buffer.subarray(i + 5, i + 5 + length));
    values.push({ kind, data });
    i += 5 + length;
  }
  return values;
}
function headless(name, rust, payload, env = {}) {
  const result = execute(name, rust ? binary : oracle, ["headless"], project, { EFFECT_TSRS_OXLINT_DELEGATE: found.backend, ...env }, JSON.stringify(payload));
  return { status: result.status, frames: frames(result.stdout) };
}
function normalizedFrames(result) {
  assert.equal(result.status, 0);
  return sort(result.frames.map(({ kind, data }) => ({ kind, file: data.file_path, rule: data.rule, range: data.range, message: data.message, labels: data.labeled_ranges ?? [] })));
}
try {
  const mixed = parity("mixed-severity-overrides-comments-unicode");
  assert.deepEqual(parity("single-thread-mixed", ["--threads=1"]), mixed);
  assert.deepEqual(parity("two-thread-mixed", ["--threads", "2"]), mixed);
  assert(mixed.diagnostics.some(d => d.code === "effecttsgo(async-function)" && d.severity === "warning"));
  assert.equal(mixed.diagnostics.filter(d => d.filename === "Main.ts" && d.code === "effecttsgo(floating-effect)").length, 1);
  assert(!mixed.diagnostics.some(d => d.filename === "Disabled.ts"));
  assert(mixed.diagnostics.some(d => d.filename === "Excluded.ts"));
  assert(mixed.diagnostics.some(d => d.labels?.length > 1 && d.code.startsWith("effecttsgo")), "Related ranges were not exercised");
  assert(mixed.diagnostics.filter(d => d.filename === "Duplicates.ts").length >= 2, "Overlapping distinct diagnostics were not exercised");
  write(path.join(project, "Types.ts"), 'export const n: number = "bad";\n');
  parity("type-check", ["--type-check"], project, [...paths, "Types.ts"]);

  const payload = { version: 2, configs: [{ file_paths: [path.join(project, "Main.ts")], rules: [{ name: "effecttsgo/floating-effect" }] }], source_overrides: { [path.join(project, "Main.ts")]: 'import { value } from "./Unsaved.js";\nconst emoji = "🎉"; value;\n', [path.join(project, "Unsaved.ts")]: 'import { Effect } from "effect";\nexport const value = Effect.succeed(1);\n' } };
  const saved = hash(path.join(project, "Main.ts"));
  const unsaved = normalizedFrames(headless("unsaved-rust", true, payload, { EFFECT_TSRS_OXLINT_DELEGATE: "/must-not-be-started" }));
  assert.deepEqual(unsaved, normalizedFrames(headless("unsaved-go", false, payload)));
  assert.equal(unsaved.length, 1);
  assert.equal(unsaved[0].range.pos, Buffer.byteLength(payload.source_overrides[path.join(project, "Main.ts")].split("value;")[0]));
  assert.equal(hash(path.join(project, "Main.ts")), saved);
  assert(!fs.existsSync(path.join(project, "Unsaved.ts")));
  report.checks.push({ name: "unsaved-import-and-utf8-pure-rust", diagnostics: unsaved.length });
  const invalid = headless("invalid-protocol", true, { version: 99, configs: [] });
  assert.equal(invalid.status, 1);
  assert.match(invalid.frames[0].data.error, /Unsupported Oxlint protocol/);
  report.checks.push({ name: "invalid-protocol" });

  const refs = path.join(output, "references");
  write(path.join(refs, "package.json"), { type: "module" });
  write(path.join(refs, ".oxlintrc.json"), config);
  write(path.join(refs, "tsconfig.json"), { files: [], references: [{ path: "./configs/app.json" }] });
  write(path.join(refs, "configs/app.json"), { compilerOptions, include: ["../src/*.ts"] });
  write(path.join(refs, "src/main.ts"), 'import { Effect } from "effect";\nEffect.succeed(1);\n');
  assert.equal(parity("project-reference", [], refs, ["src/main.ts"]).diagnostics.length, 1);

  const invalidProject = path.join(output, "invalid-project");
  write(path.join(invalidProject, ".oxlintrc.json"), { ...config, rules: { "effecttsgo/floating-effect": "error" } });
  write(path.join(invalidProject, "tsconfig.json"), { compilerOptions: { ...compilerOptions, nonexistentOption: true }, files: ["main.ts"] });
  write(path.join(invalidProject, "main.ts"), 'import { Effect } from "effect";\nEffect.succeed(1);\n');
  parity("invalid-project", [], invalidProject, ["main.ts"]);

  const fixes = path.join(output, "fixes");
  write(path.join(fixes, "package.json"), { type: "module" });
  write(path.join(fixes, "tsconfig.json"), { compilerOptions, files: ["main.ts"] });
  write(path.join(fixes, ".oxlintrc.json"), { ...config, rules: { "effecttsgo/floating-effect": "error", "typescript/no-unnecessary-type-assertion": "error" } });
  const fixSource = 'import { Effect } from "effect";\nconst x: number = 1; export const y = x as number; Effect.succeed(1);\n';
  write(path.join(fixes, "main.ts"), fixSource);
  const rustFixed = lint("fixes-rust", true, ["--fix"], fixes, ["main.ts"]);
  const fixedSource = fs.readFileSync(path.join(fixes, "main.ts"), "utf8");
  assert.notEqual(fixedSource, fixSource, "Standard TypeScript fix was not applied");
  write(path.join(fixes, "main.ts"), fixSource);
  assert.deepEqual(lint("fixes-go", false, ["--fix"], fixes, ["main.ts"]), rustFixed);
  assert.equal(fs.readFileSync(path.join(fixes, "main.ts"), "utf8"), fixedSource);
  report.checks.push({ name: "standard-typescript-fix-with-effect-diagnostic" });

  const registered = JSON.parse(fs.readFileSync(new URL("../bin/oxlint-metadata.json", import.meta.url))).rules;
  const kebab = name => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const allConfig = path.join(project, "all-rules.json");
  write(allConfig, { ...config, rules: Object.fromEntries(registered.map(name => [`effecttsgo/${kebab(name)}`, "error"])) });
  write(path.join(project, "Channels.ts"), 'import { Effect } from "effect";\nexport const bad: Effect.Effect<number> = Effect.fail("missing");\nexport const promised = Effect.succeed(Promise.resolve(1));\n');
  const all = parity("all-130-registered-rules", ["--config", allConfig], project, [...paths, "Channels.ts"]);
  assert(all.diagnostics.some(d => d.code === "effecttsgo(missing-effect-error)"), "On-demand assignment checking must remain active");

  // Install local copies so patch/unpatch never changes the developer's packages.
  const installation = path.join(output, "installation");
  fs.mkdirSync(installation, { recursive: true });
  for (const name of ["oxlint", "oxlint-tsgolint", `@oxlint/binding-${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`, `@oxlint-tsgolint/${process.platform}-${process.arch}`]) {
    const from = path.dirname(require.resolve(`${name}/package.json`));
    const to = path.join(installation, "node_modules", name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  for (const name of ["package.json", ".oxlintrc.json", "tsconfig.json", ...paths]) fs.copyFileSync(path.join(project, name), path.join(installation, name));
  const shim = path.join(installation, "node_modules/.bin", process.platform === "win32" ? "tsgolint.CMD" : "tsgolint");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.rmSync(shim, { force: true });
  if (process.platform === "win32") fs.writeFileSync(shim, '@node "%~dp0../oxlint-tsgolint/bin/tsgolint.js" %*\r\n');
  else fs.symlinkSync("../oxlint-tsgolint/bin/tsgolint.js", shim);
  const local = discoverOxlint(binary, installation);
  const targets = [local.binding, local.backend, local.declarations, local.cli];
  const originals = targets.map(hash);
  assert.equal(patchOxlint(binary, false, installation).length, 4);
  const patched = targets.map(hash);
  assert.notDeepEqual(patched, originals);
  patchOxlint(binary, false, installation);
  assert.deepEqual(targets.map(hash), patched, "Patch must be idempotent");
  assert.deepEqual(lint("patched-direct-oxlint", true, [], installation, paths, true), mixed);
  assert.deepEqual(lint("patched-single-thread", true, ["--threads=1"], installation, paths, true), mixed);
  // Inspect the environment in the real patched CLI after it processes its flags.
  // --version avoids a second lint pass and leaves the module available to inspect.
  const capture = 'process.argv = [process.execPath, process.env.TEST_OXLINT_CLI, "--version", "--threads=2"]; await import(process.env.TEST_OXLINT_CLI); console.log(JSON.stringify([process.env.EFFECT_TSRS_THREADS, process.env.RAYON_NUM_THREADS, process.env.GOMAXPROCS]));';
  const forwarded = execute("patched-thread-forwarding", process.execPath, ["--input-type=module", "-e", capture], installation, { TEST_OXLINT_CLI: pathToFileURL(local.cli).href });
  assert.equal(forwarded.status, 0);
  assert.deepEqual(JSON.parse(forwarded.stdout.toString().trim().split("\n").at(-1)), ["2", "2", "2"]);
  fs.appendFileSync(local.declarations, "\n// modified by another tool\n");
  assert.throws(() => patchOxlint(binary, true, installation), /changed/);
  assert.equal(hash(local.binding), patched[0], "A rejected restore must not partially change files");
  const changed = fs.readFileSync(local.declarations, "utf8").replace("\n// modified by another tool\n", "");
  fs.writeFileSync(local.declarations, changed);
  patchOxlint(binary, true, installation);
  assert.deepEqual(targets.map(hash), originals, "Unpatch must restore exact bytes");
  assert.equal(patchOxlint(binary, true, installation).length, 0);
  assert(targets.every(file => !fs.existsSync(`${file}.effect-tsrs-original`) && !fs.existsSync(`${file}.effect-tsrs-patch.json`)));
  report.checks.push({ name: "direct-oxlint-patch-idempotence-tamper-unpatch" });
  report.passed = true;
  console.log(`Oxlint integration passed ${report.checks.length} checks. Evidence: ${path.relative(root, output)}/report.json`);
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally { write(path.join(output, "report.json"), report); }
