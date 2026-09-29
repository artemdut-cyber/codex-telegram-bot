import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const runUpdateProcess = promisify(execFile);
export const INSTALLER_URL = "https://chatgpt.com/codex/install.sh";
const LATEST_URL = "https://releases.openai.com/codex/channels/latest";
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function versionFromOutput(output) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[\w.]+)?)/m.exec(output);
  if (!match) throw new Error("Cannot read Codex CLI version.");
  return match[1];
}

export function newerVersion(latest, current) {
  if (!STABLE_VERSION.test(latest)) return false;
  const a = latest.split(".").map(Number), b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return current.includes("-");
}

export async function latestCodexVersion(run = runUpdateProcess) {
  const { stdout } = await run("curl", ["--proto", "=https", "-fsSL", "--connect-timeout", "10", "--max-time", "30", LATEST_URL], { timeout: 35_000, maxBuffer: 4 * 1024 * 1024 });
  const metadata = JSON.parse(stdout);
  const version = String(metadata.tag_name || "").replace(/^rust-v/, "");
  if (!STABLE_VERSION.test(version) || metadata.prerelease || metadata.draft) throw new Error("Latest stable Codex metadata is invalid.");
  return version;
}

export async function codexInstallation(config, run = runUpdateProcess) {
  const command = config.codexUpdateBin || config.codexPath;
  let bin = command;
  if (!path.isAbsolute(bin)) {
    if (bin.includes(path.sep)) throw new Error("CODEX_PATH must be absolute or a command on PATH.");
    bin = null;
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const candidate = path.resolve(dir, command);
      try { await fs.access(candidate, fs.constants.X_OK); bin = candidate; break; }
      catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
    }
    if (!bin) throw new Error("Codex executable was not found on PATH.");
  }
  const real = await fs.realpath(bin);
  const root = path.join(config.codexUpdateHome, "packages", "standalone");
  const { stdout } = await run(real, ["--version"], { timeout: 10_000 });
  const current = versionFromOutput(stdout);
  const runtimeEnv = { ...process.env, ...config.codexEnv };
  if (config.codexUpdateWrapperRealPath) runtimeEnv.CODEX_REAL_PATH = config.codexUpdateWrapperRealPath;
  const runtimeVersion = command === config.codexPath ? current
    : versionFromOutput((await run(config.codexPath, ["--version"], { timeout: 10_000, env: runtimeEnv })).stdout);
  const supported = process.platform === "linux"
    && real.startsWith(`${path.join(root, "releases")}${path.sep}`)
    && runtimeVersion === current
    && (await fs.lstat(bin)).isSymbolicLink();
  return { bin, real, root, current, supported };
}

export async function stageCodexRelease(config, state, run = runUpdateProcess) {
  if (!STABLE_VERSION.test(state.target)) throw new Error("Invalid update target.");
  const runDir = path.join(config.codexUpdateDir, "runs", state.id);
  const stageHome = path.join(runDir, "stage-home"), binDir = path.join(stageHome, "bin");
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  const installer = path.join(runDir, "install.sh");
  await run("curl", ["--proto", "=https", "-fsSL", "--connect-timeout", "10", "--max-time", "60", INSTALLER_URL, "-o", installer], { timeout: 65_000 });
  await run("sh", ["-n", installer], { timeout: 10_000 });
  // Install exclusively in staging. Inherited account CODEX_HOME, installer
  // overrides and credentials cannot select or mutate the live installation.
  await run("sh", [installer, "--release", state.target], {
    timeout: 900_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: stageHome, CODEX_HOME: stageHome,
      CODEX_INSTALL_DIR: binDir, CODEX_NON_INTERACTIVE: "1" }
  });
  const stageRoot = path.join(stageHome, "packages", "standalone");
  const release = await fs.realpath(path.join(stageRoot, "current"));
  if (!release.startsWith(`${path.join(stageRoot, "releases")}${path.sep}`)) throw new Error("Unexpected staged release path.");
  const stagedBin = path.join(release, "bin", "codex");
  if (versionFromOutput((await run(stagedBin, ["--version"], { timeout: 10_000 })).stdout) !== state.target) {
    throw new Error("Downloaded CLI version does not match the approved version.");
  }
  const destination = path.join(state.installation.root, "releases", path.basename(release));
  try {
    await fs.access(destination);
    if (versionFromOutput((await run(path.join(destination, "bin", "codex"), ["--version"], { timeout: 10_000 })).stdout) !== state.target) {
      throw new Error("Existing release directory has an unexpected version.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const staging = `${destination}.stage-${state.id}`;
    await fs.cp(release, staging, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await fs.rename(staging, destination);
  }
  return destination;
}

export async function atomicSymlink(file, target) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.symlink(target, temp);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
