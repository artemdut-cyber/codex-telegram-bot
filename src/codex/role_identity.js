import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PROJECT = "artemdut-cyber/MyFkenTS";
const SUPPORTED_PROJECTS = new Map([
  [DEFAULT_PROJECT, "MyFkenTS"],
  ["artemdut-cyber/agentdevteam-platform", "AgentDevTeam Platform"],
]);
const ROLE_IDS = new Set(["dev", "review", "qa"]);
const OVERRIDE_NAME = "AGENTS.override.md";
const EXCLUDE_ENTRY = "/AGENTS.override.md";

export async function loadRoleIdentityConfig(filePath) {
  if (!filePath) return null;
  let parsed;
  try {
    if (!path.isAbsolute(filePath)) throw new Error("path must be absolute");
    const fileStat = await fs.lstat(filePath);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (fileStat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        fileStat.uid !== process.getuid())
    ) {
      throw new Error("config file must be private to the service account");
    }
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error("MyFkenTS role identity config is missing or invalid.");
  }
  if (
    parsed?.version !== 1 ||
    !Array.isArray(parsed.mappings) ||
    parsed.mappings.length !== 3
  ) {
    throw new Error(
      "Role identity config must contain exactly three version 1 mappings.",
    );
  }
  const selectedProject =
    parsed.project === undefined ? DEFAULT_PROJECT : String(parsed.project);
  if (!SUPPORTED_PROJECTS.has(selectedProject))
    throw new Error("Role identity config selects an unsupported project.");
  const seenTopics = new Set();
  const seenRoles = new Set();
  const seenWorkspaces = new Set();
  const mappings = parsed.mappings.map((entry) => {
    const chatId = String(entry?.chatId || "");
    const topicId = String(entry?.topicId || "");
    const workspace = String(entry?.workspace || "");
    const entryProject = String(entry?.project || "");
    const roleId = String(entry?.roleId || "");
    const rolePolicyPath = String(entry?.rolePolicyPath || "");
    const key = `${chatId}:topic:${topicId}`;
    if (
      !/^-?\d+$/.test(chatId) ||
      !/^\d+$/.test(topicId) ||
      !path.isAbsolute(workspace) ||
      entryProject !== selectedProject ||
      !ROLE_IDS.has(roleId) ||
      !isRepoPath(rolePolicyPath) ||
      seenTopics.has(key) ||
      seenRoles.has(roleId) ||
      seenWorkspaces.has(path.resolve(workspace))
    ) {
      throw new Error(
        "Role identity config contains an invalid, mixed-project or duplicate mapping.",
      );
    }
    seenTopics.add(key);
    seenRoles.add(roleId);
    seenWorkspaces.add(path.resolve(workspace));
    return {
      chatId,
      topicId,
      workspace: path.resolve(workspace),
      project: entryProject,
      roleId,
      rolePolicyPath,
      key,
    };
  });
  if (seenRoles.size !== 3)
    throw new Error(
      "Role identity config must map Dev, Review and QA once each.",
    );
  return { mappings };
}

export function createRoleIdentitySynchronizer({
  config,
  chats,
  options,
  run = execFileAsync,
}) {
  if (!config?.mappings)
    throw new TypeError("validated role identity config is required.");
  const configuredProject =
    config.project || config.mappings[0]?.project || DEFAULT_PROJECT;

  async function beforeTurn(chatKey, { forceNewSession = false } = {}) {
    const chat = chats.get(chatKey);
    const identity = parseTopicKey(chatKey);
    const mapping = identity
      ? config.mappings.find(
          (item) => item.key === `${identity.chatId}:topic:${identity.topicId}`,
        )
      : null;
    const cwd = chat?.forumBinding?.cwd;
    if (!cwd) {
      if (mapping)
        throw new Error(
          `${projectLabel(configuredProject)} trusted role topic is missing its bound workspace.`,
        );
      return { synchronized: false, reason: "not-project-topic" };
    }
    const effectiveCwd = options.get(chatKey).workingDirectory;
    if (effectiveCwd !== cwd)
      throw new Error(
        `${projectLabel(configuredProject)} role identity workspace does not match the trusted topic binding.`,
      );
    if (!identity)
      throw new Error(
        `${projectLabel(configuredProject)} role identity requires a registered Telegram topic.`,
      );
    if (!mapping) {
      const repo = await originRepository(cwd, run);
      if (repo === configuredProject)
        throw new Error(
          `Unknown ${projectLabel(configuredProject)} topic; refusing to start Codex without a trusted role mapping.`,
        );
      const threadId =
        chat.threadId ||
        chat.accountThreads?.[
          chat.threadAccountId || chat.accountId || "default"
        ] ||
        "";
      if (threadId && !forceNewSession)
        return { synchronized: false, reason: "existing-session" };
      return { synchronized: false, reason: "not-managed-project" };
    }
    if (path.resolve(cwd) !== mapping.workspace)
      throw new Error(
        `${projectLabel(configuredProject)} role identity workspace does not match its trusted mapping.`,
      );
    const actualWorkspace = await fs.realpath(cwd).catch(() => "");
    const actualMappingWorkspace = await fs
      .realpath(mapping.workspace)
      .catch(() => "");
    if (!actualWorkspace || actualWorkspace !== actualMappingWorkspace) {
      throw new Error(
        `${projectLabel(configuredProject)} role identity workspace is missing or ambiguous.`,
      );
    }
    const repo = await originRepository(cwd, run);
    if (repo !== mapping.project)
      throw new Error(
        `${projectLabel(configuredProject)} topic project does not match its trusted mapping.`,
      );
    const threadId =
      chat.threadId ||
      chat.accountThreads?.[
        chat.threadAccountId || chat.accountId || "default"
      ] ||
      "";
    if (threadId && !forceNewSession)
      return { synchronized: false, reason: "existing-session" };

    await ensureExcluded(cwd, run);
    const statusBefore = await git(
      cwd,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      run,
    );
    await git(cwd, ["fetch", "--no-tags", "origin", "refs/heads/main"], run);
    const governanceSha = await git(
      cwd,
      ["rev-parse", "FETCH_HEAD^{commit}"],
      run,
    );
    const common = await git(cwd, ["show", `FETCH_HEAD:AGENTS.md`], run);
    const policy = await git(
      cwd,
      ["show", `FETCH_HEAD:${mapping.rolePolicyPath}`],
      run,
    );
    const content = composeInstructions({
      common,
      policy,
      governanceSha,
      roleId: mapping.roleId,
    });
    await atomicWrite(path.join(actualWorkspace, OVERRIDE_NAME), content);
    const ignored = await run(
      "git",
      ["check-ignore", "--quiet", "--", OVERRIDE_NAME],
      { cwd },
    ).then(
      () => true,
      () => false,
    );
    if (!ignored)
      throw new Error("MyFkenTS role override is not excluded from Git.");
    const statusAfter = await git(
      cwd,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      run,
    );
    if (statusBefore !== statusAfter)
      throw new Error(
        "MyFkenTS role instruction sync changed the worktree Git status.",
      );
    return {
      synchronized: true,
      roleId: mapping.roleId,
      governanceSha,
      overrideSha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
  }

  return { beforeTurn };
}

export function composeInstructions({ common, policy, governanceSha, roleId }) {
  if (
    !String(common || "").trim() ||
    !String(policy || "").trim() ||
    !/^[0-9a-f]{40,64}$/i.test(String(governanceSha || "")) ||
    !ROLE_IDS.has(roleId)
  ) {
    throw new Error("Accepted common and role instructions are required.");
  }
  return `<!-- Generated locally by codex-telegram-bot. Governance: ${governanceSha}; role_id: ${roleId}. -->\n${common.trimEnd()}\n\n---\n\n${policy.trim()}\n`;
}

function parseTopicKey(chatKey) {
  const match = String(chatKey).match(/^(-?\d+):topic:(\d+)$/);
  return match ? { chatId: match[1], topicId: match[2] } : null;
}

function isRepoPath(value) {
  return (
    value &&
    !path.isAbsolute(value) &&
    value.split(/[\\/]/).every((part) => part && part !== "." && part !== "..")
  );
}

function projectLabel(project) {
  return SUPPORTED_PROJECTS.get(project) || "Managed project";
}

async function originRepository(cwd, run) {
  const remote = await git(cwd, ["remote", "get-url", "origin"], run);
  const match = remote.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  return match?.[1] || "";
}

async function git(cwd, args, run) {
  try {
    const result = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return String(result.stdout || "").trimEnd();
  } catch {
    throw new Error(
      "MyFkenTS role identity sync could not verify the trusted repository state.",
    );
  }
}

async function ensureExcluded(cwd, run) {
  let excludePath;
  try {
    ({ stdout: excludePath } = await run(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd },
    ));
  } catch {
    throw new Error(
      "MyFkenTS role identity sync could not resolve the worktree-local Git exclude file.",
    );
  }
  excludePath = String(excludePath).trim();
  if (!path.isAbsolute(excludePath))
    excludePath = path.resolve(cwd, excludePath);
  const current = await fs
    .readFile(excludePath, "utf8")
    .catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  const entries = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  if (entries.has(EXCLUDE_ENTRY)) return;
  const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_ENTRY}\n`;
  await atomicWrite(excludePath, next, 0o600);
}

async function atomicWrite(filePath, content, mode = 0o600) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const existing = await fs
      .lstat(filePath)
      .catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error(
        "Refusing to replace a non-regular role instruction file.",
      );
    }
    await fs.writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
