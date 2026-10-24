import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const metadata = JSON.parse(fs.readFileSync(new URL("./oxlint-metadata.json", import.meta.url)));
const backupSuffix = ".effect-tsrs-original";
const stateSuffix = ".effect-tsrs-patch.json";
const hash = data => createHash("sha256").update(data).digest("hex");
const kebab = name => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

// Self-contained because patching embeds this same function in Oxlint's CLI.
export function configureOxlintThreads(args, env) {
  let threads;
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const value = args[i] === "--threads" ? args[++i] : args[i].startsWith("--threads=") ? args[i].slice(10) : undefined;
    if (value === undefined || !/^\+?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) continue;
    threads = Number(value);
  }
  // Oxlint uses zero for automatic sizing and validates invalid values itself.
  if (threads > 0) {
    env.EFFECT_TSRS_THREADS = String(threads);
    env.RAYON_NUM_THREADS = String(threads);
    env.GOMAXPROCS = String(threads);
  }
  return env;
}

export function discoverOxlint(binary, cwd = process.cwd()) {
  const require = createRequire(path.join(cwd, "package.json"));
  const manifestPath = require.resolve("oxlint/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (!metadata.oxlintVersions.includes(manifest.version)) throw new Error(`Oxlint ${manifest.version} is unsupported; use ${metadata.oxlintVersions.join(", ")}.`);
  const requireOxlint = createRequire(manifestPath);
  const backendManifest = requireOxlint.resolve("oxlint-tsgolint/package.json");
  const backendVersion = JSON.parse(fs.readFileSync(backendManifest)).version;
  if (!metadata.backendVersions.includes(backendVersion)) throw new Error(`oxlint-tsgolint ${backendVersion} is unsupported; use ${metadata.backendVersions.join(", ")}.`);
  const target = `${process.platform}-${process.arch}`;
  if (process.platform === "linux" && !process.report?.getReport().header.glibcVersionRuntime) throw new Error("The bundled Oxlint integration requires glibc on Linux; the standalone Rust CLI also supports musl.");
  const bindingTarget = process.platform === "linux" ? `${target}-gnu` : process.platform === "win32" ? `${target}-msvc` : target;
  const binding = requireOxlint.resolve(`@oxlint/binding-${bindingTarget}`);
  const backend = createRequire(backendManifest).resolve(`@oxlint-tsgolint/${target}/tsgolint${process.platform === "win32" ? ".exe" : ""}`);
  const frontend = path.join(path.dirname(path.dirname(binary)), "oxlint", manifest.version, path.basename(binding));
  if (!fs.existsSync(frontend)) throw new Error(`Bundled Oxlint binding is missing: ${frontend}. Reinstall the native package, or run npm run prepare:oxlint in a source checkout.`);
  return { binary, frontend, binding, backend, declarations: path.join(path.dirname(manifestPath), "dist/index.d.ts"), cli: path.join(path.dirname(manifestPath), "dist/cli.js"), version: manifest.version, backendVersion };
}

export function oxlintCommand(binary, args, cwd = process.cwd()) {
  const found = discoverOxlint(binary, cwd);
  const backend = fs.existsSync(`${found.backend}${stateSuffix}`) ? `${found.backend}${backupSuffix}` : found.backend;
  return {
    command: process.execPath,
    args: [found.cli, "--type-aware", ...(args[0] === "--" ? args.slice(1) : args)],
    env: configureOxlintThreads(args[0] === "--" ? args.slice(1) : args, { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: found.frontend, OXLINT_TSGOLINT_PATH: binary, EFFECT_TSRS_OXLINT_DELEGATE: backend }),
  };
}

function atomicWrite(file, bytes, mode) {
  const temporary = `${file}.${process.pid}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(temporary, bytes, { mode, flag: "wx" });
    created = true;
    fs.renameSync(temporary, file);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function declarations(source) {
  const pattern = /^type LintPluginOptionsSchema = ([^;\n]+);$/m;
  const marker = "interface DummyRuleMap {\n";
  if (!pattern.test(source) || source.split(marker).length !== 2 || source.match(pattern)[0].includes('"effecttsgo"')) throw new Error("Unsupported or already patched Oxlint declarations; restore the original installation first.");
  return source.replace(pattern, 'type LintPluginOptionsSchema = "effecttsgo" | $1;').replace(marker, `${marker}${metadata.rules.map(rule => `  "effecttsgo/${kebab(rule)}"?: RuleNoConfig;`).sort().join("\n")}\n`);
}

function cli(source) {
  if (!source.includes("process.argv.slice(2)")) throw new Error("Unsupported Oxlint CLI; cannot forward the thread limit.");
  return `// Forward the CLI thread limit to effect-tsrs and its delegated backend.\n(${configureOxlintThreads.toString()})(process.argv.slice(2), process.env);\n${source}`;
}

// Plan all changes before writing. Atomic replacement avoids modifying shared
// hard-linked package-cache files. External symlink targets are never patched.
export function patchOxlint(binary, restore = false, cwd = process.cwd()) {
  const found = discoverOxlint(binary, cwd);
  const project = `${fs.realpathSync(cwd)}${path.sep}`;
  const files = [found.binding, found.backend, found.declarations, found.cli];
  const plan = files.map(file => {
    if (!fs.realpathSync(file).startsWith(project)) throw new Error(`Cannot patch a shared package outside this project: ${file}. Use "effect-tsrs oxlint" to run without changing installed packages.`);
    const current = fs.readFileSync(file);
    const statePath = `${file}${stateSuffix}`;
    const backupPath = `${file}${backupSuffix}`;
    const stateBytes = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
    const state = stateBytes ? JSON.parse(stateBytes) : null;
    if (!state && fs.existsSync(backupPath)) throw new Error(`Untracked backup at ${backupPath}; refusing to overwrite it.`);
    const original = state ? fs.readFileSync(backupPath) : current;
    if (state && (hash(original) !== state.original || ![state.patched, state.original].includes(hash(current)))) throw new Error(`Patched file or backup changed: ${file}. Restore your package installation before retrying.`);
    if (restore && !state) return null;
    const replacement = restore ? original : file === found.binding ? fs.readFileSync(found.frontend) : file === found.backend ? fs.readFileSync(binary) : Buffer.from((file === found.cli ? cli : declarations)(original.toString("utf8")));
    return { file, current, original, replacement, state, stateBytes, statePath, backupPath, mode: fs.statSync(file).mode & 0o777 };
  }).filter(Boolean);
  const changed = [];
  try {
    for (const item of plan) {
      changed.push(item);
      if (!restore && !item.state) atomicWrite(item.backupPath, item.original, item.mode);
      atomicWrite(item.file, item.replacement, item.mode);
      if (!restore) atomicWrite(item.statePath, Buffer.from(JSON.stringify({ original: hash(item.original), patched: hash(item.replacement) })), 0o644);
    }
    if (restore) {
      for (const item of plan) {
        fs.unlinkSync(item.statePath);
        fs.unlinkSync(item.backupPath);
      }
    }
  } catch (error) {
    const failures = [];
    for (const item of changed.reverse()) {
      try {
        atomicWrite(item.file, item.current, item.mode);
        if (item.state) {
          atomicWrite(item.backupPath, item.original, item.mode);
          atomicWrite(item.statePath, item.stateBytes, 0o644);
        } else {
          fs.rmSync(item.backupPath, { force: true });
          fs.rmSync(item.statePath, { force: true });
        }
      } catch (failure) { failures.push(failure.message); }
    }
    if (failures.length) throw new Error(`${error.message}; rollback failed: ${failures.join("; ")}`);
    throw error;
  }
  return plan.map(item => item.file);
}
