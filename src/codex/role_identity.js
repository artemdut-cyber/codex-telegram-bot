import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_PROJECT = "artemdut-cyber/MyFkenTS";
const ALLOWED_V2_PROJECTS = new Set([
  "artemdut-cyber/MyFkenTS",
  "artemdut-cyber/EmailAi",
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
  if (parsed?.version === 2) return loadV2Config(parsed);
  if (
    parsed?.version !== 1 ||
    !Array.isArray(parsed.mappings) ||
    parsed.mappings.length !== 3
  ) {
    throw new Error(
      "MyFkenTS role identity config must contain exactly three version 1 mappings.",
    );
  }
  const seenTopics = new Set();
  const seenRoles = new Set();
  const seenWorkspaces = new Set();
  const mappings = parsed.mappings.map((entry) => {
    const chatId = String(entry?.chatId || "");
    const topicId = String(entry?.topicId || "");
    const workspace = String(entry?.workspace || "");
    const project = String(entry?.project || "");
    const roleId = String(entry?.roleId || "");
    const rolePolicyPath = String(entry?.rolePolicyPath || "");
    const key = `${chatId}:topic:${topicId}`;
    if (
      !/^-?\d+$/.test(chatId) ||
      !/^\d+$/.test(topicId) ||
      !path.isAbsolute(workspace) ||
      project !== EXPECTED_PROJECT ||
      !ROLE_IDS.has(roleId) ||
      !isRepoPath(rolePolicyPath) ||
      seenTopics.has(key) ||
      seenRoles.has(roleId) ||
      seenWorkspaces.has(path.resolve(workspace))
    ) {
      throw new Error(
        "MyFkenTS role identity config contains an invalid or duplicate mapping.",
      );
    }
    seenTopics.add(key);
    seenRoles.add(roleId);
    seenWorkspaces.add(path.resolve(workspace));
    return {
      chatId,
      topicId,
      workspace: path.resolve(workspace),
      project,
      roleId,
      rolePolicyPath,
      key,
    };
  });
  if (seenRoles.size !== 3)
    throw new Error(
      "MyFkenTS role identity config must map Dev, Review and QA once each.",
    );
  return { mappings };
}

async function loadV2Config(parsed) {
  if (!Array.isArray(parsed.projects) || parsed.projects.length < 2) {
    throw new Error("Role identity v2 config must contain multiple projects.");
  }
  const seenTopics = new Set();
  const seenWorkspaces = new Set();
  const seenRepositories = new Set();
  const projects = [];
  const mappings = [];
  for (const entry of parsed.projects) {
    const repository = String(entry?.repository || "");
    const acceptedGovernanceSha = String(entry?.acceptedGovernanceSha || "");
    if (
      !ALLOWED_V2_PROJECTS.has(repository) ||
      seenRepositories.has(repository) ||
      !/^[0-9a-f]{40}$/.test(acceptedGovernanceSha) ||
      !Array.isArray(entry?.mappings) ||
      entry.mappings.length !== ROLE_IDS.size
    ) {
      throw new Error(
        "Role identity v2 config contains an unknown or invalid project.",
      );
    }
    seenRepositories.add(repository);
    const projectMappings = [];
    const seenRoles = new Set();
    for (const mappingEntry of entry.mappings) {
      const chatId = String(mappingEntry?.chatId || "");
      const topicId = String(mappingEntry?.topicId || "");
      const workspace = String(mappingEntry?.workspace || "");
      const roleId = String(mappingEntry?.roleId || "");
      const rolePolicyPath = String(mappingEntry?.rolePolicyPath || "");
      const key = `${chatId}:topic:${topicId}`;
      if (
        !/^-?\d+$/.test(chatId) ||
        !/^\d+$/.test(topicId) ||
        !path.isAbsolute(workspace) ||
        !ROLE_IDS.has(roleId) ||
        !isV2RepoPath(rolePolicyPath) ||
        path.posix.basename(rolePolicyPath) !== `${roleId}.md` ||
        seenTopics.has(key) ||
        seenRoles.has(roleId)
      ) {
        throw new Error(
          "Role identity v2 config contains an invalid or duplicate mapping.",
        );
      }
      const resolvedWorkspace = path.resolve(workspace);
      let canonicalWorkspace;
      try {
        const stat = await fs.lstat(resolvedWorkspace);
        canonicalWorkspace = await fs.realpath(resolvedWorkspace);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          canonicalWorkspace !== resolvedWorkspace
        ) {
          throw new Error("workspace is not canonical");
        }
      } catch {
        throw new Error(
          "Role identity v2 workspace is missing, unsafe or not canonical.",
        );
      }
      if (seenWorkspaces.has(canonicalWorkspace)) {
        throw new Error(
          "Role identity v2 config contains duplicate physical workspaces.",
        );
      }
      seenTopics.add(key);
      seenRoles.add(roleId);
      seenWorkspaces.add(canonicalWorkspace);
      const mapping = {
        chatId,
        topicId,
        workspace: canonicalWorkspace,
        project: repository,
        roleId,
        rolePolicyPath,
        acceptedGovernanceSha,
        key,
      };
      projectMappings.push(mapping);
      mappings.push(mapping);
    }
    if (seenRoles.size !== ROLE_IDS.size) {
      throw new Error(
        "Role identity v2 project must map Dev, Review and QA once each.",
      );
    }
    projects.push({
      repository,
      acceptedGovernanceSha,
      mappings: projectMappings,
    });
  }
  return { version: 2, projects, mappings };
}

export function createRoleIdentitySynchronizer({
  config,
  chats,
  options,
  getTrustedForumTopic,
  run = execFileAsync,
}) {
  if (!config?.mappings)
    throw new TypeError("validated role identity config is required.");

  async function beforeTurn(chatKey, { forceNewSession = false } = {}) {
    const chat = chats.get(chatKey);
    const identity = parseTopicKey(chatKey);
    const mapping = identity
      ? config.mappings.find(
          (item) => item.key === `${identity.chatId}:topic:${identity.topicId}`,
        )
      : null;
    const cwd = chat?.forumBinding?.cwd;
    if (config.version === 2) {
      return beforeTurnV2({ chatKey, identity, chat, cwd, forceNewSession });
    }
    if (!cwd) {
      if (mapping)
        throw new Error(
          "MyFkenTS trusted role topic is missing its bound workspace.",
        );
      return { synchronized: false, reason: "not-project-topic" };
    }
    const threadId =
      chat.threadId ||
      chat.accountThreads?.[
        chat.threadAccountId || chat.accountId || "default"
      ] ||
      "";
    if (threadId && !forceNewSession)
      return { synchronized: false, reason: "existing-session" };

    const effectiveCwd = options.get(chatKey).workingDirectory;
    if (effectiveCwd !== cwd)
      throw new Error(
        "MyFkenTS role identity workspace does not match the trusted topic binding.",
      );
    if (!identity)
      throw new Error(
        "MyFkenTS role identity requires a registered Telegram topic.",
      );
    if (!mapping) {
      const repo = await originRepository(cwd, run);
      if (repo === EXPECTED_PROJECT)
        throw new Error(
          "Unknown MyFkenTS topic; refusing to start Codex without a trusted role mapping.",
        );
      return { synchronized: false, reason: "not-managed-project" };
    }
    if (path.resolve(cwd) !== mapping.workspace)
      throw new Error(
        "MyFkenTS role identity workspace does not match its trusted mapping.",
      );

    const actualWorkspace = await fs.realpath(cwd).catch(() => "");
    const actualMappingWorkspace = await fs
      .realpath(mapping.workspace)
      .catch(() => "");
    if (!actualWorkspace || actualWorkspace !== actualMappingWorkspace) {
      throw new Error(
        "MyFkenTS role identity workspace is missing or ambiguous.",
      );
    }
    const repo = await originRepository(cwd, run);
    if (repo !== mapping.project)
      throw new Error(
        "MyFkenTS topic project does not match its trusted mapping.",
      );

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

  async function beforeTurnV2({
    chatKey,
    identity,
    chat,
    cwd,
    forceNewSession,
  }) {
    const mapping = identity
      ? config.mappings.find(
          (item) => item.key === `${identity.chatId}:topic:${identity.topicId}`,
        )
      : null;
    if (!cwd) {
      if (mapping)
        throw new Error(
          "Role identity v2 trusted topic has no bound workspace.",
        );
      return { synchronized: false, reason: "not-project-topic" };
    }
    if (!identity)
      throw new Error("Role identity v2 requires a registered Telegram topic.");
    if (!mapping) {
      const repo = await originRepositoryV2(cwd, run);
      if (config.projects.some((project) => project.repository === repo)) {
        throw new Error(
          "Unknown managed project topic; refusing to start Codex.",
        );
      }
      return { synchronized: false, reason: "not-managed-project" };
    }
    if (typeof getTrustedForumTopic !== "function") {
      throw new Error(
        "Role identity v2 requires a trusted forum topic resolver.",
      );
    }
    const topic = getTrustedForumTopic(identity.chatId, identity.topicId);
    if (
      !topic ||
      String(topic.id) !== identity.topicId ||
      topic.role !== "project" ||
      topic.closed === true ||
      !topic.bindingId ||
      !topic.cwd
    ) {
      throw new Error(
        "Role identity v2 Telegram topic is missing, stale, closed or untrusted.",
      );
    }
    const forumBinding = chat?.forumBinding;
    if (
      !forumBinding ||
      forumBinding.id !== topic.bindingId ||
      forumBinding.cwd !== topic.cwd
    ) {
      throw new Error(
        "Role identity v2 Telegram topic binding is stale or changed.",
      );
    }
    const expectedBindingId = topic.bindingId;
    const expectedTopicWorkspace = topic.cwd;
    const assertCurrentTopicBinding = () => {
      const current = getTrustedForumTopic(identity.chatId, identity.topicId);
      if (
        !current ||
        String(current.id) !== identity.topicId ||
        current.role !== "project" ||
        current.closed === true ||
        current.bindingId !== expectedBindingId ||
        current.cwd !== expectedTopicWorkspace ||
        chat?.forumBinding?.id !== expectedBindingId ||
        chat?.forumBinding?.cwd !== expectedTopicWorkspace
      ) {
        throw new Error(
          "Role identity v2 Telegram topic binding became stale or changed.",
        );
      }
    };
    if (path.resolve(topic.cwd) !== mapping.workspace) {
      throw new Error(
        "Role identity v2 topic workspace does not match its trusted mapping.",
      );
    }
    const effectiveCwd = options.get(chatKey).workingDirectory;
    if (
      effectiveCwd !== cwd ||
      cwd !== topic.cwd ||
      path.resolve(cwd) !== mapping.workspace
    ) {
      throw new Error(
        "Role identity v2 workspace does not match its trusted topic binding.",
      );
    }
    const actualWorkspace = await fs.realpath(cwd).catch(() => "");
    if (!actualWorkspace || actualWorkspace !== mapping.workspace) {
      throw new Error("Role identity v2 workspace is missing or ambiguous.");
    }
    const repo = await originRepositoryV2(cwd, run);
    if (repo !== mapping.project) {
      throw new Error(
        "Role identity v2 repository does not match its trusted topic binding.",
      );
    }
    assertCurrentTopicBinding();
    const threadId =
      chat?.threadId ||
      chat?.accountThreads?.[
        chat?.threadAccountId || chat?.accountId || "default"
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
    const fetchedSha = await git(
      cwd,
      ["rev-parse", "FETCH_HEAD^{commit}"],
      run,
    );
    if (fetchedSha !== mapping.acceptedGovernanceSha) {
      throw new Error(
        "Role identity v2 accepted governance SHA does not match origin/main.",
      );
    }
    await assertRegularGitFile(
      cwd,
      mapping.acceptedGovernanceSha,
      "AGENTS.md",
      run,
    );
    await assertRegularGitFile(
      cwd,
      mapping.acceptedGovernanceSha,
      mapping.rolePolicyPath,
      run,
    );
    const common = await git(
      cwd,
      ["show", `${mapping.acceptedGovernanceSha}:AGENTS.md`],
      run,
    );
    const policy = await git(
      cwd,
      ["show", `${mapping.acceptedGovernanceSha}:${mapping.rolePolicyPath}`],
      run,
    );
    assertCurrentTopicBinding();
    const content = composeInstructions({
      common,
      policy,
      governanceSha: mapping.acceptedGovernanceSha,
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
      throw new Error("Role identity v2 override is not excluded from Git.");
    const statusAfter = await git(
      cwd,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      run,
    );
    if (statusBefore !== statusAfter)
      throw new Error("Role identity v2 sync changed the worktree Git status.");
    assertCurrentTopicBinding();
    return {
      synchronized: true,
      project: mapping.project,
      roleId: mapping.roleId,
      governanceSha: mapping.acceptedGovernanceSha,
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
    throw new Error(
      "Accepted MyFkenTS common and role instructions are required.",
    );
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

function isV2RepoPath(value) {
  return (
    value &&
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.-]+$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          part !== ".git",
      )
  );
}

async function originRepository(cwd, run) {
  const remote = await git(cwd, ["remote", "get-url", "origin"], run);
  const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1] || "";
}

async function originRepositoryV2(cwd, run) {
  const remote = await git(cwd, ["remote", "get-url", "origin"], run);
  let repositoryPath;
  if (/^(https|ssh):\/\//i.test(remote)) {
    try {
      const url = new URL(remote);
      const authority = remote.match(/^[A-Za-z]+:\/\/([^/]+)/)?.[1] || "";
      if (
        url.hostname.toLowerCase() !== "github.com" ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        (url.protocol === "https:" &&
          authority.toLowerCase() !== "github.com") ||
        (url.protocol === "ssh:" &&
          authority.toLowerCase() !== "git@github.com")
      )
        return "";
      if (url.protocol === "https:" && url.username) return "";
      if (url.protocol === "ssh:" && url.username !== "git") return "";
      repositoryPath = url.pathname.slice(1);
    } catch {
      return "";
    }
  } else {
    repositoryPath = remote.match(/^git@github\.com:([^\s?#]+)$/i)?.[1] || "";
  }
  repositoryPath = repositoryPath.replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryPath)
    ? repositoryPath
    : "";
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

async function assertRegularGitFile(cwd, revision, filePath, run) {
  const output = await git(
    cwd,
    ["ls-tree", "--full-tree", revision, "--", filePath],
    run,
  );
  const match = output.match(/^(100644|100755) blob [0-9a-f]{40,64}\t.+$/);
  if (!match) {
    throw new Error(
      "Role identity v2 governance instructions must be regular files.",
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
