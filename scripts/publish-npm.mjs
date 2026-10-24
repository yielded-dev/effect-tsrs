import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageStatus, waitForNativePackages } from "./npm-registry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = { artifacts: "", dryRun: false, resume: false };
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === "--dry-run") {
    args.dryRun = true;
  } else if (process.argv[index] === "--resume") {
    args.resume = true;
  } else if (process.argv[index] === "--artifacts" && process.argv[index + 1]) {
    args.artifacts = process.argv[++index];
  } else {
    throw new Error("Usage: node scripts/publish-npm.mjs --artifacts DIR [--dry-run] [--resume]");
  }
}
assert(args.artifacts, "--artifacts DIR is required");
const artifacts = path.resolve(root, args.artifacts);
const manifest = readJson(process.env.RELEASE_MANIFEST || path.join(root, "package.json"));
const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const required = Object.entries(manifest.optionalDependencies ?? {}).map(([name, version]) => {
  assert(name.startsWith(`${manifest.name}-`), `Unexpected optional dependency ${name}`);
  const platform = name.slice(manifest.name.length + 1);
  assert(Object.hasOwn(targets, platform), `Unsupported native platform ${platform}`);
  assert.equal(version, manifest.version, `Optional dependency version mismatch: ${name}`);
  return platform;
});
assert.equal(required.length, 5, "Expected all five native optional dependencies");
assert.equal(new Set(required).size, required.length, "Duplicate native platforms");
assert(required.includes("darwin-arm64"), "Darwin ARM main package is required");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hash(data, algorithm, encoding = "hex") {
  return createHash(algorithm).update(data).digest(encoding);
}

function basename(file) {
  // Reports contain the producing runner's paths, including Windows paths.
  return file.split(/[\\/]/).at(-1);
}

function modeBits(permissions) {
  assert(/^[-d][rwxstST-]{9}$/.test(permissions), `Unexpected tar permissions: ${permissions}`);
  let mode = 0;
  for (let index = 0; index < 9; index++) {
    const permission = permissions[index + 1];
    if (permission !== "-" && permission !== "S" && permission !== "T") mode |= 1 << (8 - index);
  }
  if (/[sS]/.test(permissions[3])) mode |= 0o4000;
  if (/[sS]/.test(permissions[6])) mode |= 0o2000;
  if (/[tT]/.test(permissions[9])) mode |= 0o1000;
  return mode;
}

// System tar is available on both the Linux publishing job and macOS. Read
// content to stdout: validation never extracts archive paths into the workspace.
function unpack(file) {
  const options = { maxBuffer: 256 * 1024 * 1024 };
  const names = execFileSync("tar", ["-tzf", file], { ...options, encoding: "utf8" }).trimEnd().split("\n");
  const details = execFileSync("tar", ["-tvzf", file], { ...options, encoding: "utf8" }).trimEnd().split("\n");
  assert.equal(details.length, names.length, `Inconsistent tar listing: ${file}`);
  const entries = new Map();
  for (const [index, name] of names.entries()) {
    assert(name.startsWith("package/") && !name.split("/").includes(".."), `Unsafe package path: ${name}`);
    assert(!entries.has(name), `Duplicate tar entry ${name}`);
    const permissions = details[index].split(/\s+/)[0];
    const mode = modeBits(permissions);
    const type = permissions[0] === "d" ? "directory" : "file";
    const data = type === "directory" ? Buffer.alloc(0) : execFileSync("tar", ["-xOf", file, name], options);
    entries.set(name, { type, mode, size: data.length, sha512: hash(data, "sha512"), data });
  }
  assert(entries.get("package/package.json")?.type === "file", `Missing package.json: ${file}`);
  return entries;
}

function validateTarball(directory, packed, name) {
  assert.equal(packed.name, name, "Unexpected package name in packing report");
  assert.equal(packed.version, manifest.version, `Wrong reported version for ${name}`);
  assert.equal(packed.id, `${name}@${manifest.version}`, `Wrong reported package identity for ${name}`);
  assert(typeof packed.filename === "string" && basename(packed.filename) === packed.filename && packed.filename.endsWith(".tgz"), `Invalid tarball filename for ${name}`);
  const file = path.join(directory, packed.filename);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, packed.size, `Tarball size mismatch: ${file}`);
  assert.equal(`sha512-${hash(bytes, "sha512", "base64")}`, packed.integrity, `Tarball SHA512 mismatch: ${file}`);
  const entries = unpack(file);
  const metadata = JSON.parse(entries.get("package/package.json").data.toString("utf8"));
  assert.equal(metadata.name, name, `Wrong packed package name: ${file}`);
  assert.equal(metadata.version, manifest.version, `Wrong packed package version: ${file}`);
  return { file, name, integrity: packed.integrity, sha256: hash(bytes, "sha256"), entries, metadata };
}

function contents(archive, platform) {
  return [...archive.entries].map(([name, entry]) => {
    let mode = entry.mode;
    if (platform === "win32-x64" && name === "package/bin/effect-tsrs.js") {
      assert([0o644, 0o755].includes(mode), "Unexpected Windows launcher mode");
      mode = 0o755;
    }
    return { name, type: entry.type, mode, size: entry.size, sha512: entry.sha512 };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

// Complete every check before constructing any npm process. In particular, a
// late failure on the main package must not leave newly published native builds.
const releases = new Map();
let commit = process.env.RELEASE_SHA || process.env.GITHUB_SHA || undefined;
for (const platform of required) {
  const directory = path.join(artifacts, `npm-${platform}`);
  const packageDirectory = path.join(directory, "npm");
  const report = readJson(path.join(packageDirectory, `package-${platform}.json`));
  assert.equal(report.version, manifest.version, `Release version mismatch for ${platform}`);
  assert.equal(report.target, targets[platform], `Release target mismatch for ${platform}`);
  assert(typeof report.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(report.commit), `Invalid release commit for ${platform}`);
  commit ??= report.commit;
  assert.equal(report.commit, commit, `Release commit mismatch for ${platform}${process.env.RELEASE_SHA || process.env.GITHUB_SHA ? " against the release source SHA" : ""}`);
  assert(Array.isArray(report.packages) && report.packages.length === 2, `Expected native and main tarballs for ${platform}`);
  const nativeName = `${manifest.name}-${platform}`;
  const nativeRecords = report.packages.filter((packed) => packed.name === nativeName);
  const mainRecords = report.packages.filter((packed) => packed.name === manifest.name);
  assert.equal(nativeRecords.length, 1, `Missing or duplicate native package for ${platform}`);
  assert.equal(mainRecords.length, 1, `Missing or duplicate main package for ${platform}`);
  const native = validateTarball(packageDirectory, nativeRecords[0], nativeName);
  const main = validateTarball(packageDirectory, mainRecords[0], manifest.name);
  const [os, cpu] = platform.split("-");
  assert.deepEqual(native.metadata.os, [os], `Wrong native os for ${platform}`);
  assert.deepEqual(native.metadata.cpu, [cpu], `Wrong native cpu for ${platform}`);
  assert.deepEqual(main.metadata.optionalDependencies, manifest.optionalDependencies, `Wrong packed optional dependencies for ${platform}`);
  const executable = native.entries.get(`package/bin/effect-tsrs${os === "win32" ? ".exe" : ""}`);
  assert.equal(executable?.type, "file", `Missing native executable for ${platform}`);
  assert.equal(hash(executable.data, "sha256"), report.binarySha256, `Native executable does not match build report for ${platform}`);

  const packageCheck = readJson(path.join(directory, "verify-package/report.json"));
  assert.equal(packageCheck.passed, true, `Package verification failed for ${platform}`);
  assert.equal(packageCheck.target, platform, `Wrong package verification target for ${platform}`);
  assert.equal(packageCheck.version, manifest.version, `Wrong verified package version for ${platform}`);
  assert(Array.isArray(packageCheck.tarballs) && packageCheck.tarballs.length === 2, `Missing verified tarballs for ${platform}`);
  for (const archive of [native, main]) {
    const verified = packageCheck.tarballs.filter((item) => basename(item.file) === path.basename(archive.file));
    assert.equal(verified.length, 1, `Missing verified tarball ${archive.name}`);
    assert.equal(verified[0].sha256, archive.sha256, `Package verification used another tarball: ${archive.name}`);
  }
  for (const [label, status] of [["install", 0], ["version", 0], ["help", 0], ["effect-diagnostics", 0], ["compiler-error", 1], ["invalid-argument", 2]]) {
    const checks = packageCheck.checks?.filter((check) => check.label === label) ?? [];
    assert.equal(checks.length, 1, `Missing package check ${label} for ${platform}`);
    assert.equal(checks[0].status, status, `Failed package check ${label} for ${platform}`);
    assert(!checks[0].signal && !checks[0].error, `Interrupted package check ${label} for ${platform}`);
  }
  const configCheck = readJson(path.join(directory, "verify-config/report.json"));
  assert.equal(configCheck.passed, true, `Config verification failed for ${platform}`);
  assert(Array.isArray(configCheck.cases) && configCheck.cases.length >= 10 && configCheck.cases.every((test) => test.passed === true), `Incomplete config verification for ${platform}`);
  assert.equal(new Set(configCheck.cases.map((test) => test.name)).size, configCheck.cases.length, `Duplicate config checks for ${platform}`);
  assert.equal(configCheck.binary?.sha256, report.binarySha256, `Config verification used another executable for ${platform}`);
  const projectCheck = readJson(path.join(directory, "verify-project/report.json"));
  assert.equal(projectCheck.passed, true, `Project verification failed for ${platform}`);
  assert.equal(projectCheck.binarySha256, report.binarySha256, `Project verification used another executable for ${platform}`);
  assert(projectCheck.cases?.length >= 70 && projectCheck.cases.every(test => test.passed), `Incomplete project verification for ${platform}`);
  assert.equal(new Set(projectCheck.cases.map(test => test.name)).size, projectCheck.cases.length, `Duplicate project checks for ${platform}`);
  if (manifest.exports?.["./oxlint-schema.json"]) {
    const oxlintCheck = readJson(path.join(directory, "verify-oxlint/report.json"));
    assert.equal(oxlintCheck.passed, true, `Oxlint verification failed for ${platform}`);
    assert.equal(oxlintCheck.binarySha256, report.binarySha256, `Oxlint verification used another executable for ${platform}`);
    if (platform === "darwin-arm64") {
      const oxlintAll = readJson(path.join(directory, "verify-oxlint-all/report.json"));
      assert.equal(oxlintAll.passed, true, "Oxlint rule parity verification failed");
      assert.equal(oxlintAll.binarySha256, report.binarySha256, "Oxlint rule parity used another executable");
      assert.equal(oxlintAll.expectedPairs, 4263, "Incomplete Oxlint rule-fixture matrix");
      assert.equal(oxlintAll.results?.length, 614, "Incomplete Oxlint fixture matrix");
      assert.equal(Object.keys(oxlintAll.coverage ?? {}).length, 130, "Incomplete positive Oxlint rule coverage");
    }
  }
  releases.set(platform, { native, main });
}
const chosenMain = releases.get("darwin-arm64").main;
const expectedContents = contents(chosenMain, "darwin-arm64");
for (const [platform, release] of releases) {
  assert.deepEqual(contents(release.main, platform), expectedContents, `Main tarball contents differ for ${platform}`);
}
const publish = [...required.map((platform) => releases.get(platform).native), chosenMain];
console.log(`Validated ${required.length} platforms for ${manifest.name}@${manifest.version}, commit ${commit}.`);
for (const [index, archive] of publish.entries()) {
  if (args.resume && archive !== chosenMain) continue;
  console.log(`${index + 1}. npm publish ${JSON.stringify(archive.file)} --access public --provenance --ignore-scripts${args.dryRun ? " (dry run)" : ""}`);
}

if (!args.dryRun) {
  let npm = "npm";
  let prefix = [];
  if (process.env.npm_execpath) {
    npm = process.execPath;
    prefix = [process.env.npm_execpath];
  } else if (process.platform === "win32") {
    const cli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    assert(fs.existsSync(cli), "Run the publisher through npm so npm_execpath is available");
    npm = process.execPath;
    prefix = [cli];
  }
  const publishArchive = (archive) => {
    const result = spawnSync(npm, [...prefix, "publish", archive.file, "--access", "public", "--provenance", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    assert(!result.signal && result.status === 0, `npm publish failed for ${archive.name} (status ${result.status}, signal ${result.signal})`);
  };
  const natives = publish.slice(0, -1);
  if (!args.resume) {
    for (const archive of natives) publishArchive(archive);
  }
  const ready = await waitForNativePackages(natives);
  if (!ready) {
    // EX_TEMPFAIL is distinct from invalid artifacts or a failed npm upload.
    // The workflow schedules another check without repeating native uploads.
    process.exitCode = 75;
  } else {
    const main = await packageStatus(chosenMain);
    if (main.ready) {
      console.log(`${chosenMain.name}@${manifest.version} is already published with matching integrity.`);
    } else if (main.missing) {
      publishArchive(chosenMain);
    } else {
      console.log(`Cannot confirm launcher state yet: ${main.reason}`);
      process.exitCode = 75;
    }
  }
}
