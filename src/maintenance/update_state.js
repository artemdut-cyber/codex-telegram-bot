import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../fs/private.js";

export const UPDATE_TERMINAL_PHASES = new Set(["succeeded", "failed", "rolled_back"]);
const PAUSED_PHASES = new Set(["waiting_idle", "switching", "verifying", "rolling_back", "rollback_failed"]);

export function updateStatePath(config) {
  return config.codexUpdateDir ? path.join(config.codexUpdateDir, "status.json") : null;
}

function deploymentPause(config) {
  if (!config.codexUpdateDir) return null;
  try {
    const value = JSON.parse(readFileSync(path.join(config.codexUpdateDir, "deployment-pause.json"), "utf8"));
    return value.expiresAt > Date.now() ? value : null;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function updateAdmissionPaused(config) {
  const file = updateStatePath(config);
  if (!file) return false;
  try {
    if (deploymentPause(config)) return true;
    return PAUSED_PHASES.has(JSON.parse(readFileSync(file, "utf8")).phase);
  }
  catch (error) {
    if (error.code === "ENOENT") return false;
    // Corrupt/unreadable update state must not permit jobs during a switch.
    return true;
  }
}

export async function readUpdateState(config) {
  const file = updateStatePath(config);
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeUpdateState(config, state) {
  const value = { ...state, updatedAt: new Date().toISOString() };
  await writePrivateFileAtomic(updateStatePath(config), `${JSON.stringify(value, null, 2)}\n`);
  await writePrivateFileAtomic(path.join(config.codexUpdateDir, "runs", state.id, "status.json"), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export function updateLockPath(config) {
  return path.join(config.codexUpdateHome, "packages", "standalone", ".telegram-update-lock");
}

export async function claimUpdate(config, state) {
  const lock = updateLockPath(config);
  await ensurePrivateDirectory(path.dirname(lock));
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try {
    await writePrivateFileAtomic(path.join(lock, "owner.json"), JSON.stringify({ id: state.id, stateFile: updateStatePath(config) }));
    await writeUpdateState(config, state);
    return true;
  } catch (error) {
    await fs.rm(lock, { recursive: true, force: true });
    throw error;
  }
}

export async function releaseUpdate(config, id) {
  const lock = updateLockPath(config);
  let owner;
  try { owner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") {
      try { await fs.lstat(lock); }
      catch (missing) { if (missing.code === "ENOENT") return; throw missing; }
    }
    throw error;
  }
  if (owner.id !== id || owner.stateFile !== updateStatePath(config)) throw new Error("Update lock owner mismatch.");
  await fs.rm(lock, { recursive: true });
}

export function startUpdateIdleReporter({ config, isIdle, resumeQueues, logger = console }) {
  let busy = false;
  let wasPaused = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const paused = updateAdmissionPaused(config);
      if (paused) {
        const state = await readUpdateState(config);
        await writePrivateFileAtomic(path.join(config.codexUpdateDir, "idle.json"), JSON.stringify({
          id: deploymentPause(config)?.id || state?.id, idle: isIdle(), at: Date.now(), pid: process.pid
        }));
      } else if (wasPaused) {
        await resumeQueues();
      }
      wasPaused = paused;
    } catch (error) {
      logger.warn?.("Codex update idle reporter:", error.message);
    } finally { busy = false; }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
