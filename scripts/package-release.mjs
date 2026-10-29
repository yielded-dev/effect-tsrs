import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package one native build and the common launcher. The release workflow runs
// this on each supported platform, then tests these exact tarballs.
import { copyOxlintArtifacts } from "./oxlint-artifacts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = {
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
  "x86_64-unknown-linux-musl": { os: "linux", cpu: "x64" },
  "aarch64-unknown-linux-musl": { os: "linux", cpu: "arm64" },
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
};
const args = { target: "", binary: "", output: "artifacts/npm" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  if (!Object.hasOwn(args, key) || !process.argv[i].startsWith("--") || !process.argv[i + 1]) {
    throw new Error("Usage: node scripts/package-release.mjs --target TRIPLE --binary PATH [--output DIR]");
  }
  args[key] = process.argv[i + 1];
}
const target = targets[args.target];
if (!target || !args.binary) throw new Error(`Specify --binary and a supported --target: ${Object.keys(targets).join(", ")}`);
const binary = path.resolve(root, args.binary);
const output = path.resolve(root, args.output);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, "Cargo.toml"), "utf8"))?.[1];
if (manifest.version !== cargoVersion) throw new Error("npm and Cargo versions must match");
manifest.optionalDependencies = Object.fromEntries(Object.values(targets).map(({ os, cpu }) => [
  `${manifest.name}-${os}-${cpu}`, manifest.version,
]));

const name = `${manifest.name}-${target.os}-${target.cpu}`;
const staging = path.join(output, args.target);
const executable = `effect-tsrs${target.os === "win32" ? ".exe" : ""}`;
fs.mkdirSync(path.join(staging, "bin"), { recursive: true });
fs.copyFileSync(binary, path.join(staging, "bin", executable));
fs.chmodSync(path.join(staging, "bin", executable), 0o755);
copyOxlintArtifacts(path.join(staging, "oxlint"), `${target.os}-${target.cpu}`);
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES"]) {
  fs.copyFileSync(path.join(root, file), path.join(staging, file));
}
fs.writeFileSync(path.join(staging, "README.md"), `# ${name}\n\nNative binary for [@yielded/effect-tsrs](https://www.npmjs.com/package/@yielded/effect-tsrs). Install the main package to select the correct binary automatically.\n\nBuilt from the pinned compiler and patches in [yielded-dev/effect-tsrs](https://github.com/yielded-dev/effect-tsrs). TypeScript libraries are embedded.\n`);
fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify({
  name,
  version: manifest.version,
  description: `${manifest.description} (${target.os} ${target.cpu})`,
  license: manifest.license,
  repository: manifest.repository,
  homepage: manifest.homepage,
  bugs: manifest.bugs,
  os: [target.os],
  cpu: [target.cpu],
  files: ["bin/", "oxlint/", "LICENSE", "THIRD-PARTY-NOTICES"],
  publishConfig: { access: "public" },
}, null, 2)}\n`);

function npmCommand() {
  if (process.env.npm_execpath) return [process.execPath, process.env.npm_execpath];
  if (process.platform !== "win32") return ["npm"];
  const cli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!fs.existsSync(cli)) throw new Error("Run this script with npm run package:release so npm_execpath is set");
  return [process.execPath, cli];
}
const [npm, ...prefix] = npmCommand();
function pack(directory, dryRun = false) {
  const result = spawnSync(npm, [...prefix, "pack", "--json", "--ignore-scripts", "--pack-destination", output, ...(dryRun ? ["--dry-run"] : [])], {
    cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_cache: path.join(root, "artifacts/npm-cache") },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "npm pack failed");
  const [packed] = JSON.parse(result.stdout);
  if (!dryRun) console.log(`${packed.id}: ${packed.filename} (${packed.size} bytes)`);
  return packed;
}
const nativePackage = pack(staging);
// Native packages do not exist yet when a release is built. Add their pinned
// dependencies only to the published launcher, keeping source installs valid.
const launcherStaging = fs.mkdtempSync(path.join(output, "launcher-"));
let mainPackage;
try {
  for (const file of pack(root, true).files) {
    const destination = path.join(launcherStaging, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file.path), destination);
  }
  fs.writeFileSync(path.join(launcherStaging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mainPackage = pack(launcherStaging);
} finally {
  fs.rmSync(launcherStaging, { recursive: true, force: true });
}
const report = {
  version: manifest.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  target: args.target,
  binarySha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  packages: [nativePackage, mainPackage],
};
fs.writeFileSync(path.join(output, `package-${target.os}-${target.cpu}.json`), `${JSON.stringify(report, null, 2)}\n`);
