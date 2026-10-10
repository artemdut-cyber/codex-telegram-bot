import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const SLACK_JOB_SOCKET_PATH = "/run/adtplat/codexhub-slack-job-v1.sock";
export const SLACK_JOB_CHAT_KEY = "manual:agentdevteam-platform:developer";
export const SLACK_JOB_ID_RE =
  /^slack-agentdevteam-platform-issue-([1-9][0-9]{0,8})$/;
const PEER_CREDENTIALS_REQUIRED_MESSAGE =
  "SO_PEERCRED credentials are required for the Slack job socket.";
const require = createRequire(import.meta.url);

export function readUnixPeerCredentials(socket) {
  if (process.platform !== "linux")
    throw new Error("The Slack job socket requires Linux SO_PEERCRED.");
  const peercred = require("peercred");
  const credentials = peercred.fromSock(socket);
  if (
    !credentials ||
    !Number.isSafeInteger(credentials.pid) ||
    credentials.pid <= 0 ||
    !Number.isSafeInteger(credentials.uid) ||
    credentials.uid < 0
  ) {
    throw new Error(PEER_CREDENTIALS_REQUIRED_MESSAGE);
  }
  return { pid: credentials.pid, uid: credentials.uid };
}

export function assertPeerCredentialBindingAvailable() {
  if (process.platform !== "linux")
    throw new Error("The Slack job socket requires Linux SO_PEERCRED.");
  const peercred = require("peercred");
  if (typeof peercred?.fromSock !== "function")
    throw new Error("Linux SO_PEERCRED binding is unavailable.");
}

export function authorizeUnixPeer(credentials, allowedUid) {
  if (
    !credentials ||
    !Number.isSafeInteger(credentials.pid) ||
    credentials.pid <= 0 ||
    !Number.isSafeInteger(credentials.uid) ||
    credentials.uid < 0
  ) {
    throw new Error(PEER_CREDENTIALS_REQUIRED_MESSAGE);
  }
  if (
    !Number.isSafeInteger(allowedUid) ||
    allowedUid <= 0 ||
    credentials.uid !== allowedUid
  ) {
    throw new Error(
      "Unix peer UID is not authorized for the Slack job socket.",
    );
  }
  return true;
}

export function validateSlackJob(job, { workspacePath }) {
  const expectedKeys = [
    "id",
    "progressTurnId",
    "chatKey",
    "chatId",
    "kind",
    "text",
    "inputText",
    "imagePaths",
    "threadId",
    "accountId",
    "effectiveOptions",
  ].sort();
  if (!isPlainObject(job) || !sameKeys(job, expectedKeys)) {
    throw new Error("Slack job has an unsupported request shape.");
  }

  const idMatch = SLACK_JOB_ID_RE.exec(job.id);
  if (!idMatch || job.progressTurnId !== job.id)
    throw new Error("Slack job ID is not a canonical platform Issue ID.");
  const issueNumber = Number(idMatch[1]);
  const issueUrl = `https://github.com/artemdut-cyber/agentdevteam-platform/issues/${issueNumber}`;
  const taskText = `Implement GitHub Issue ${issueUrl}. Follow its exact scope and acceptance criteria. Open one Draft PR linked to the Issue. Do not merge or deploy. Report the Draft PR URL and full head SHA.`;
  if (job.chatKey !== SLACK_JOB_CHAT_KEY || job.chatId !== SLACK_JOB_CHAT_KEY) {
    throw new Error("Slack job chat namespace is not authorized.");
  }
  if (
    job.kind !== "user" ||
    job.text !== taskText ||
    job.inputText !== taskText ||
    !Array.isArray(job.imagePaths) ||
    job.imagePaths.length !== 0 ||
    job.threadId !== "" ||
    job.accountId !== "default"
  ) {
    throw new Error("Slack job does not match the approved Issue task format.");
  }
  if (
    !isPlainObject(job.effectiveOptions) ||
    !sameKeys(job.effectiveOptions, ["sandboxMode", "workingDirectory"])
  ) {
    throw new Error(
      "Slack job options must contain only the approved workspace and sandbox.",
    );
  }
  if (
    job.effectiveOptions.workingDirectory !== workspacePath ||
    job.effectiveOptions.sandboxMode !== "workspace-write"
  ) {
    throw new Error("Slack job workspace or sandbox is not authorized.");
  }
  return { issueNumber, issueUrl };
}

export function validateSlackJobId(jobId) {
  if (typeof jobId !== "string" || !SLACK_JOB_ID_RE.test(jobId)) {
    throw new Error(
      "Only authorized manual Slack job IDs are available on this socket.",
    );
  }
  return jobId;
}

export async function prepareSlackJobSocket(
  config,
  { socketPath = config.codexSlackJobSocket } = {},
) {
  if (process.platform !== "linux")
    throw new Error(
      "The Slack job socket is disabled on unsupported operating systems.",
    );
  if (
    !socketPath ||
    (socketPath !== SLACK_JOB_SOCKET_PATH &&
      socketPath === config.codexSlackJobSocket)
  ) {
    throw new Error("The Slack job socket path is not the reviewed path.");
  }
  const uid = config.codexSlackJobUid;
  const gid = config.codexSlackJobGid;
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    uid === process.getuid() ||
    !Number.isSafeInteger(gid) ||
    gid <= 0
  ) {
    throw new Error("Slack job socket UID/GID configuration is invalid.");
  }
  const groups = new Set([process.getgid(), ...process.getgroups()]);
  if (!groups.has(gid))
    throw new Error(
      "Worker process must belong to the configured Slack socket group.",
    );

  const resolvedPath = path.resolve(socketPath);
  if (resolvedPath !== socketPath)
    throw new Error("Slack job socket path must be canonical.");
  const parent = path.dirname(resolvedPath);
  const parentStat = await fs.lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.uid !== 0 && parentStat.uid !== process.getuid()) ||
    (parentStat.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Slack job socket parent directory is not access-controlled.",
    );
  }

  const workspace = config.codexSlackJobWorkspace;
  if (
    typeof workspace !== "string" ||
    !path.isAbsolute(workspace) ||
    path.resolve(workspace) !== workspace
  ) {
    throw new Error(
      "Approved Slack Developer workspace must be a canonical absolute path.",
    );
  }
  const workspaceStat = await fs.lstat(workspace);
  const canonicalWorkspace = await fs.realpath(workspace);
  if (
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink() ||
    canonicalWorkspace !== workspace
  ) {
    throw new Error(
      "Approved Slack Developer workspace must be an existing non-symlink directory.",
    );
  }
  const forbiddenRoots = [config.codexHome, os.homedir()].filter(
    (value) => typeof value === "string" && value,
  );
  if (forbiddenRoots.some((root) => isWithin(workspace, path.resolve(root)))) {
    throw new Error(
      "Slack Developer workspace must not be inside the codex-agent home directory.",
    );
  }
  await removeOwnedStaleSocket(resolvedPath, uid, gid);
  return { socketPath: resolvedPath, workspacePath: canonicalWorkspace };
}

export async function secureSlackJobSocket(socketPath, gid) {
  await fs.chown(socketPath, process.getuid(), gid);
  await fs.chmod(socketPath, 0o660);
  const stat = await fs.lstat(socketPath);
  if (
    !stat.isSocket() ||
    stat.uid !== process.getuid() ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== 0o660
  ) {
    throw new Error(
      "Slack job socket ownership or mode could not be verified.",
    );
  }
}

async function removeOwnedStaleSocket(socketPath, uid, gid) {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isSocket() ||
    stat.uid !== process.getuid() ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== 0o660
  ) {
    throw new Error(
      "Refusing to replace an unexpected Slack job socket path entry.",
    );
  }
  const state = await probeSocket(socketPath);
  if (state !== "stale")
    throw new Error(
      "Slack job socket path is already active or could not be safely checked.",
    );
  const current = await fs.lstat(socketPath);
  if (
    current.ino !== stat.ino ||
    current.dev !== stat.dev ||
    current.uid !== process.getuid() ||
    current.gid !== gid ||
    (current.mode & 0o777) !== 0o660 ||
    !current.isSocket()
  ) {
    throw new Error("Slack job socket changed during stale-path verification.");
  }
  await fs.unlink(socketPath);
}

function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish("unknown"), 250);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error) =>
      finish(error.code === "ECONNREFUSED" ? "stale" : "unknown"),
    );
  });
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sameKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
