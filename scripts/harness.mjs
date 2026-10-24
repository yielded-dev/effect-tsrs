import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import getExePath from "@effect/tsgo/lib/getExePath";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const selectedRules = ["floatingEffect", "asyncFunction", "unnecessaryPipe"];
export const settings = JSON.parse(fs.readFileSync(path.join(root, "fixtures/rule-settings.json"), "utf8"));
export const manifest = JSON.parse(fs.readFileSync(path.join(root, "fixtures/manifest.json"), "utf8"));
export const environment = { ...process.env, GOMAXPROCS: "1", RAYON_NUM_THREADS: "1" };

export function argumentsFor(defaults) {
  const args = { ...defaults };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, "");
    if (!(key in args) || !process.argv[i].startsWith("--") || process.argv[i + 1] === undefined) {
      throw new Error(`Expected ${Object.keys(defaults).map((k) => `--${k} VALUE`).join(", ")}`);
    }
    args[key] = process.argv[i + 1];
  }
  return args;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function commands(project, binary, { rules = selectedRules, lspconfig, candidateLspconfig = true } = {}) {
  const options = lspconfig ?? { diagnosticSeverity: settings.diagnosticSeverity };
  const configArgs = lspconfig && candidateLspconfig ? ["--lspconfig", JSON.stringify(lspconfig)] : [];
  return {
    reference: {
      command: getExePath(),
      args: ["--effect-cli-diagnostics", JSON.stringify({ cwd: project, project: "tsconfig.json", format: "json", strict: false, progress: false, lspconfig: JSON.stringify(options) })],
    },
    candidate: { command: path.resolve(root, binary), args: ["diagnostics", "--type-check", "-p", path.join(project, "tsconfig.json"), "--format", "json", "--rules", rules.join(","), ...configArgs] },
    compilerOnly: { command: path.resolve(root, binary), args: ["diagnostics", "--type-check", "-p", path.join(project, "tsconfig.json"), "--format", "json", "--rules", "none", ...configArgs] },
    typescript: { command: getExePath(), args: ["--noEmit", "--pretty", "false", "-p", path.join(project, "tsconfig.json")] },
  };
}

export function run(spec, prefix, { timed = false, json = true, allowedStatuses = [0, 1] } = {}) {
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const useTime = timed && process.platform === "darwin" && fs.existsSync("/usr/bin/time");
  const command = useTime ? "/usr/bin/time" : spec.command;
  const args = useTime ? ["-l", spec.command, ...spec.args] : spec.args;
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  fs.writeFileSync(`${prefix}.stdout.${json ? "json" : "txt"}`, stdout);
  fs.writeFileSync(`${prefix}.stderr.txt`, stderr);
  const memory = /([\d,]+)\s+maximum resident set size/.exec(stderr);
  const record = { command: spec.command, args: spec.args, timedWith: useTime ? "/usr/bin/time -l" : null, status: result.status, signal: result.signal, elapsedMs, maxRssBytes: memory ? Number(memory[1].replaceAll(",", "")) : null, error: result.error?.message ?? null };
  writeJson(`${prefix}.process.json`, record);
  if (useTime && !memory) throw new Error(`macOS memory counters unavailable: ${prefix}; see stderr (the sandbox may block sysctl)`);
  if (result.error || result.signal || !allowedStatuses.includes(result.status)) {
    throw new Error(`Invocation failed: ${prefix} (status ${record.status}, signal ${record.signal}, error ${record.error}); see saved process metadata and stderr`);
  }
  if (/panicked at|fatal error:|runtime error:|thread .*panicked/.test(stderr)) throw new Error(`Compiler panic: ${prefix}`);
  let data;
  if (json) {
    try { data = JSON.parse(stdout); } catch { throw new Error(`Invalid diagnostic JSON: ${prefix}`); }
    if (!Array.isArray(data.diagnostics)) throw new Error(`Missing diagnostics array: ${prefix}`);
    const expectedStatus = data.summary.errors > 0 || (data.typescriptDiagnostics ?? []).some((d) => d.severity === "error") ? 1 : 0;
    if (result.status !== expectedStatus) throw new Error(`Exit status ${result.status} does not match diagnostics (expected ${expectedStatus}): ${prefix}`);
  }
  return { ...record, data, stdout, stderr };
}

const fields = ["file", "start", "length", "line", "column", "endLine", "endColumn", "severity", "code", "name", "message"];
export function normalizedDiagnostics(data, project, rules = selectedRules) {
  return data.diagnostics.map((diagnostic) => {
    const out = Object.fromEntries(fields.map((key) => {
      if (diagnostic[key] === undefined) throw new Error(`Diagnostic missing ${key}: ${JSON.stringify(diagnostic)}`);
      return [key, key === "file" ? relativeFile(diagnostic[key], project) : diagnostic[key]];
    }));
    if (!rules.includes(out.name)) throw new Error(`Unexpected rule ${out.name}`);
    out.relatedInformation = (diagnostic.relatedInformation ?? []).map((related) => {
      const normalized = Object.fromEntries(["file", "start", "length", "line", "column", "endLine", "endColumn", "code", "message"].map((key) => {
        if (related[key] === undefined) throw new Error(`Related diagnostic missing ${key}`);
        return [key, key === "file" ? relativeFile(related[key], project) : related[key]];
      }));
      return normalized;
    });
    return out;
  }).sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.code - b.code || a.message.localeCompare(b.message));
}

export function relativeFile(file, project) {
  return path.relative(project, path.isAbsolute(file) ? file : path.resolve(project, file)).split(path.sep).join("/");
}

export function assertEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${description}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
}

export function checkParity(reference, candidate, project, prefix, { rules = selectedRules } = {}) {
  const expected = normalizedDiagnostics(reference.data, project, rules);
  const actual = normalizedDiagnostics(candidate.data, project, rules);
  writeJson(`${prefix}.comparison.json`, { match: JSON.stringify(actual) === JSON.stringify(expected), expected, actual });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const first = Array.from({ length: Math.max(actual.length, expected.length) }, (_, index) => index).find((index) => JSON.stringify(actual[index]) !== JSON.stringify(expected[index]));
    throw new Error(`Effect diagnostic parity failed for ${project}: expected ${expected.length}, actual ${actual.length}; first difference ${first}: expected ${JSON.stringify(expected[first])}, actual ${JSON.stringify(actual[first])}. Full comparison: ${prefix}.comparison.json`);
  }
  // Verify spans against JavaScript's UTF-16 indexing, including non-BMP fixture text.
  for (const diagnostic of actual) {
    const source = fs.readFileSync(path.resolve(project, diagnostic.file), "utf8");
    const location = (offset) => {
      const preceding = source.slice(0, offset);
      const lines = preceding.split(/\r\n|\r|\n/);
      return [lines.length, lines.at(-1).length + 1];
    };
    assertEqual([diagnostic.line, diagnostic.column], location(diagnostic.start), "Start is not a consistent UTF-16 location");
    assertEqual([diagnostic.endLine, diagnostic.endColumn], location(diagnostic.start + diagnostic.length), "End is not a consistent UTF-16 location");
  }
  return actual;
}

export function parseTypeScript(result, project) {
  const diagnostics = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(.*?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/.exec(line);
    if (match) diagnostics.push({ file: relativeFile(path.resolve(root, match[1]), project), line: Number(match[2]), column: Number(match[3]), severity: match[4], code: Number(match[5]), message: match[6] });
    else if (line && diagnostics.length) diagnostics.at(-1).message += `\n${line}`;
    else if (line) throw new Error(`Unrecognized TypeScript output: ${line}`);
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code - b.code);
}

export function candidateTypeScript(data, project) {
  if (!Array.isArray(data.typescriptDiagnostics)) throw new Error("Missing typescriptDiagnostics array");
  return data.typescriptDiagnostics.map((d) => ({ file: d.location ? relativeFile(d.location.file, project) : "", line: d.location?.line ?? 0, column: d.location?.column ?? 0, severity: d.severity, code: d.code, message: d.message })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code - b.code);
}

export function metadata(projects, binary) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? null;
  const packageVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
  const hashes = {};
  for (const project of projects) {
    for (const file of fs.readdirSync(project).sort()) {
      if (!/\.(?:ts|json)$/.test(file)) continue;
      hashes[path.relative(root, path.join(project, file))] = createHash("sha256").update(fs.readFileSync(path.join(project, file))).digest("hex");
    }
  }
  const binaryPath = path.resolve(root, binary);
  return { createdAt: new Date().toISOString(), revision: git(["rev-parse", "HEAD"]), dirty: git(["status", "--short"]), upstreamFixtureRevision: settings.sourceRevision, versions: { node: process.version, effect: packageVersion("effect"), effectTsgo: packageVersion("@effect/tsgo"), typescript: packageVersion("typescript") }, machine: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, settings: { GOMAXPROCS: "1", RAYON_NUM_THREADS: "1", rules: settings.diagnosticSeverity, processTimeoutMs: 60_000 }, binary: { path: binaryPath, sha256: fs.existsSync(binaryPath) ? createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex") : null }, fixtureHashes: hashes };
}

export function statistics(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, min: sorted[0], max: sorted.at(-1), samples: sorted.length };
}

export function snapshotExecutable(source, destination, expectedSha256) {
  const original = path.resolve(root, source);
  const copied = path.resolve(root, destination);
  if (original === copied) throw new Error("Executable snapshot cannot overwrite its source");
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  const temporary = `${copied}.${process.pid}.tmp`;
  fs.copyFileSync(original, temporary, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(temporary, 0o555);
  const sha256 = createHash("sha256").update(fs.readFileSync(temporary)).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    fs.unlinkSync(temporary);
    throw new Error(`Unexpected executable hash for ${original}: ${sha256}`);
  }
  fs.renameSync(temporary, copied);
  return { original, path: copied, sha256, bytes: fs.statSync(copied).size };
}
