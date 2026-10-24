import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// All installation inputs are local. npm's offline mode and disabled lifecycle
// scripts make this a test of the published files, without registry access.
// Usage: node scripts/verify-package.mjs --package MAIN.tgz --platform HOST.tgz
//        [--output artifacts/verify-package]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { package: "", platform: "", output: "artifacts/verify-package" };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index].replace(/^--/, "");
  if (!Object.hasOwn(args, name) || !process.argv[index].startsWith("--") || !process.argv[index + 1]) {
    throw new Error("Expected --package MAIN.tgz --platform HOST.tgz [--output DIR]");
  }
  args[name] = process.argv[index + 1];
}
assert(args.package && args.platform, "Both --package and --platform tarballs are required");
const tarballs = [args.package, args.platform].map((file) => path.resolve(root, file));
for (const file of tarballs) assert(fs.statSync(file).isFile(), `Tarball is not a file: ${file}`);
const output = path.resolve(root, args.output);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "effect-tsrs-package-"));
const installation = path.join(temporary, "installation");
const unrelated = path.join(temporary, "unrelated-working-directory");
for (const directory of [installation, unrelated, output]) fs.mkdirSync(directory, { recursive: true });
const target = `${process.platform}-${process.arch}`;
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  passed: false,
  target,
  node: process.version,
  tarballs: tarballs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
  temporary,
  checks: [],
};

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function execute(label, command, argv, cwd, options = {}) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_offline: "true", npm_config_ignore_scripts: "true", npm_config_cache: path.join(temporary, "npm-cache") },
    ...options,
  });
  fs.writeFileSync(path.join(output, `${label}.stdout.txt`), result.stdout ?? "");
  fs.writeFileSync(path.join(output, `${label}.stderr.txt`), result.stderr ?? "");
  const record = { label, command, args: argv, cwd, status: result.status, signal: result.signal, error: result.error?.message ?? null };
  report.checks.push(record);
  writeJson(path.join(output, "report.json"), report);
  assert(!result.error && !result.signal, `${label} failed to run: ${result.error?.message ?? result.signal}`);
  return result;
}

function npmCommand() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return [process.execPath, process.env.npm_execpath];
  }
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (!fs.existsSync(candidate)) continue;
    if (process.platform !== "win32") return [candidate];
    const cli = path.join(directory, "node_modules/npm/bin/npm-cli.js");
    if (fs.existsSync(cli)) return [process.execPath, cli];
  }
  throw new Error("npm is required. Run this verifier through npm or install npm on PATH.");
}

function project(name, source, effectDirectory) {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "package.json"), { name: `effect-tsrs-${name}`, private: true, type: "module" });
  writeJson(path.join(directory, "tsconfig.json"), {
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true },
    files: ["main.ts"],
  });
  fs.writeFileSync(path.join(directory, "main.ts"), source);
  if (effectDirectory) {
    fs.mkdirSync(path.join(directory, "node_modules"));
    fs.symlinkSync(effectDirectory, path.join(directory, "node_modules/effect"), process.platform === "win32" ? "junction" : "dir");
  }
  return directory;
}

writeJson(path.join(output, "report.json"), report);
try {
  writeJson(path.join(installation, "package.json"), { name: "effect-tsrs-package-verification", private: true });
  const [npm, ...npmPrefix] = npmCommand();
  const installed = execute("install", npm, [...npmPrefix, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false", "--omit=dev", ...tarballs], installation);
  assert.equal(installed.status, 0, "Local tarball installation failed; see install.stderr.txt");

  const packageDirectory = path.join(installation, "node_modules/@yielded/effect-tsrs");
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  assert.equal(metadata.name, "@yielded/effect-tsrs");
  const nativeName = `@yielded/effect-tsrs-${target}`;
  const nativeMetadata = JSON.parse(fs.readFileSync(path.join(installation, "node_modules", nativeName, "package.json"), "utf8"));
  assert.equal(nativeMetadata.name, nativeName, "Wrong host-platform package installed");
  assert.equal(nativeMetadata.version, metadata.version, "Main and native package versions differ");
  const binName = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.["effect-tsrs"];
  assert.equal(typeof binName, "string", "Package does not expose the effect-tsrs CLI");
  const launcher = path.join(packageDirectory, binName);
  const installedBin = path.join(installation, "node_modules/.bin", process.platform === "win32" ? "effect-tsrs.cmd" : "effect-tsrs");
  assert(fs.existsSync(installedBin), "npm did not install the effect-tsrs executable link");
  // POSIX exercises npm's installed executable directly. Windows uses the same
  // installed JS entry point through Node, avoiding a shell in the verifier.
  const command = process.platform === "win32" ? process.execPath : installedBin;
  const prefix = process.platform === "win32" ? [launcher] : [];
  const cli = (label, argv) => execute(label, command, [...prefix, ...argv], unrelated);

  const version = cli("version", ["--version"]);
  assert.equal(version.status, 0);
  assert(version.stdout.startsWith(`effect-tsrs ${metadata.version} (`), `Unexpected installed version: ${version.stdout}`);
  assert.equal(version.stderr, "");
  const help = cli("help", ["--help"]);
  assert.equal(help.status, 0);
  assert(help.stdout.includes("effect-tsrs diagnostics") && help.stdout.includes("--rules"), "Installed CLI help is missing");

  const effectDirectory = path.dirname(createRequire(import.meta.url).resolve("effect/package.json"));
  const source = 'import { Effect } from "effect"\nEffect.succeed(42)\n';
  const effectProject = project("effect-diagnostics", source, effectDirectory);
  const diagnostics = cli("effect-diagnostics", ["diagnostics", "--type-check", "--project", path.relative(unrelated, path.join(effectProject, "tsconfig.json")), "--format", "json", "--rules", "floatingEffect", "--lspconfig", JSON.stringify({ diagnosticSeverity: { floatingEffect: "warning" } })]);
  assert.equal(diagnostics.status, 0, "Warning-only diagnostics should succeed");
  const data = JSON.parse(diagnostics.stdout);
  assert.deepEqual(data.typescriptDiagnostics, [], "Real Effect project has compiler errors");
  assert.equal(data.summary.filesChecked, 1, "Unrelated working directory resolved the wrong project");
  assert.equal(data.diagnostics.length, 1, "Installed CLI did not diagnose the Effect value");
  const diagnostic = data.diagnostics[0];
  assert.equal(diagnostic.name, "floatingEffect");
  assert.equal(diagnostic.code, 377001);
  assert.equal(diagnostic.severity, "warning");
  assert.equal(fs.realpathSync(diagnostic.file), fs.realpathSync(path.join(effectProject, "main.ts")));
  assert.equal(source.slice(diagnostic.start, diagnostic.start + diagnostic.length), "Effect.succeed(42)");

  const compilerProject = project("compiler-error", 'export const value: number = "wrong"\n');
  const compiler = cli("compiler-error", ["diagnostics", "--type-check", "-p", path.relative(unrelated, path.join(compilerProject, "tsconfig.json")), "--format", "json", "--rules", "none"]);
  assert.equal(compiler.status, 1, "Compiler errors must produce a nonzero native exit status");
  const compilerData = JSON.parse(compiler.stdout);
  assert(compilerData.typescriptDiagnostics.some((diagnostic) => diagnostic.code === 2322 && diagnostic.severity === "error"), "Expected TS2322 from the installed compiler");
  assert.deepEqual(compilerData.diagnostics, []);

  const invalid = cli("invalid-argument", ["--not-a-real-option"]);
  assert.equal(invalid.status, 2, "Invalid arguments must preserve the native failure exit status");
  assert(invalid.stderr.includes("unknown argument: --not-a-real-option"));
  assert.equal(invalid.stdout, "");

  // Copy only the consumer's stock Oxlint dependencies. The installed package
  // must supply its own patched frontend; no @effect/tsgo is installed here.
  const require = createRequire(import.meta.url);
  const bindingTarget = `${target}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`;
  for (const name of ["oxlint", "oxlint-tsgolint", `@oxlint/binding-${bindingTarget}`, `@oxlint-tsgolint/${target}`]) {
    fs.cpSync(path.dirname(require.resolve(`${name}/package.json`)), path.join(installation, "node_modules", name), { recursive: true });
  }
  const lintConfig = path.join(effectProject, ".oxlintrc.json");
  writeJson(lintConfig, { plugins: ["effecttsgo", "typescript"], categories: { correctness: "off" }, rules: { "effecttsgo/floating-effect": "error", "typescript/no-floating-promises": "error" } });
  fs.appendFileSync(path.join(effectProject, "main.ts"), "Promise.resolve(42)\n");
  const lint = execute("oxlint", command, [...prefix, "oxlint", "--config", lintConfig, "--format", "json", path.join(effectProject, "main.ts")], installation);
  assert.equal(lint.status, 1);
  assert.deepEqual(JSON.parse(lint.stdout).diagnostics.map(d => d.code).sort(), ["effecttsgo(floating-effect)", "typescript(no-floating-promises)"]);
  assert(fs.existsSync(path.join(packageDirectory, "oxlint-presets/recommended.json")));
  assert(fs.existsSync(path.join(packageDirectory, "oxlint-schema.json")));
  report.version = metadata.version;
  report.passed = true;
  console.log(`Package verification passed for ${metadata.name}@${metadata.version} (${target}).`);
  console.log(`Evidence: ${path.relative(root, output)}/report.json`);
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(error.message);
  console.error(`Temporary installation retained at ${temporary}`);
  process.exitCode = 1;
} finally {
  if (report.passed) {
    fs.rmSync(temporary, { recursive: true, force: true });
    report.temporaryRemoved = true;
  }
  writeJson(path.join(output, "report.json"), report);
}
