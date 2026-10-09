import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeInstructions,
  createRoleIdentitySynchronizer,
  loadRoleIdentityConfig,
} from "../src/codex/role_identity.js";

const execFile = promisify(execFileCallback);
const PROJECT = "artemdut-cyber/MyFkenTS";
const PLATFORM_PROJECT = "artemdut-cyber/agentdevteam-platform";

test("role mapping is explicit, complete, unique and restart-persistent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  const roleMappings = mappings(root);
  await createWorkspaceDirectories(roleMappings);
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: roleMappings }),
  );
  const first = await loadRoleIdentityConfig(file);
  const afterRestart = await loadRoleIdentityConfig(file);
  assert.deepEqual(first, afterRestart);
  assert.deepEqual(Object.keys(first), ["mappings"]);
  assert.deepEqual(first.mappings.map(({ roleId }) => roleId).sort(), [
    "dev",
    "qa",
    "review",
  ]);
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: mappings(root).slice(1) }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /exactly three/);
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: mappings(root) }),
  );
  await fs.chmod(file, 0o666);
  await assert.rejects(loadRoleIdentityConfig(file), /invalid/);
});

test("AgentDevTeam Platform mapping v1 requires an explicit, unmixed project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-map-platform-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  const platformMappings = mappings(root, PLATFORM_PROJECT);
  await createWorkspaceDirectories(platformMappings);
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      project: PLATFORM_PROJECT,
      mappings: platformMappings,
    }),
  );
  const config = await loadRoleIdentityConfig(file);
  assert.ok(
    config.mappings.every(({ project }) => project === PLATFORM_PROJECT),
  );
  assert.deepEqual(config.mappings.map(({ roleId }) => roleId).sort(), [
    "dev",
    "qa",
    "review",
  ]);
  assert.equal(new Set(config.mappings.map(({ topicId }) => topicId)).size, 3);
  assert.equal(
    new Set(config.mappings.map(({ workspace }) => workspace)).size,
    3,
  );

  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: platformMappings }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /invalid, mixed-project/);

  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      project: PLATFORM_PROJECT,
      mappings: platformMappings.map((entry, index) =>
        index === 2 ? { ...entry, project: PROJECT } : entry,
      ),
    }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /mixed-project/);
});

test("equivalent role policy paths cannot be assigned to different roles", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "role-policy-duplicate-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  const roleMappings = mappings(root);
  await createWorkspaceDirectories(roleMappings);
  roleMappings[1].rolePolicyPath = "policies\\dev.md";
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: roleMappings }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /duplicate mapping/);
});

test("workspace aliases and unresolved physical paths fail closed", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "role-workspace-alias-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  const sharedWorkspace = path.join(root, "shared");
  const aliasWorkspace = path.join(root, "review-alias");
  await fs.mkdir(sharedWorkspace);
  await fs.mkdir(path.join(root, "qa"));
  await fs.symlink(sharedWorkspace, aliasWorkspace, "dir");
  const roleMappings = mappings(root, PLATFORM_PROJECT);
  roleMappings[0].workspace = sharedWorkspace;
  roleMappings[1].workspace = aliasWorkspace;
  roleMappings[2].workspace = path.join(root, "qa");
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      project: PLATFORM_PROJECT,
      mappings: roleMappings,
    }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /duplicate mapping/);

  roleMappings[1].workspace = path.join(root, "missing-workspace");
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      project: PLATFORM_PROJECT,
      mappings: roleMappings,
    }),
  );
  await assert.rejects(
    loadRoleIdentityConfig(file),
    /ambiguous workspace path/,
  );
});

test("Telegram role mapping v1 rejects Dev→QA Controller mapping v2", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-map-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 2,
      project: PLATFORM_PROJECT,
      mappings: mappings(root, PLATFORM_PROJECT),
    }),
  );
  await assert.rejects(loadRoleIdentityConfig(file), /version 1 mappings/);
});

test("composes the complete common constitution with one canonical role policy", () => {
  const output = composeInstructions({
    common: "COMMON RULES\n",
    policy: "REVIEW ROLE",
    governanceSha: "a".repeat(40),
    roleId: "review",
  });
  assert.match(output, /COMMON RULES/);
  assert.match(output, /REVIEW ROLE/);
  assert.match(output, /Governance: a{40}; role_id: review/);
  assert.throws(() =>
    composeInstructions({
      common: "common",
      policy: "",
      governanceSha: "a".repeat(40),
      roleId: "review",
    }),
  );
});

test("accepted main wins over conflicting mutable task branch; exclude is idempotent", async (t) => {
  const fixture = await makeRepository(t);
  const config = await loadRoleIdentityConfig(fixture.mappingFile);
  const sync = createRoleIdentitySynchronizer({
    config,
    chats: fixture.chats,
    options: fixture.options,
    run: fixture.run,
  });
  const before = await status(fixture.workspace);
  const first = await sync.beforeTurn(fixture.chatKey);
  assert.equal(first.synchronized, true);
  assert.equal(first.roleId, "dev");
  const generated = await fs.readFile(
    path.join(fixture.workspace, "AGENTS.override.md"),
    "utf8",
  );
  assert.match(generated, /ACCEPTED MAIN COMMON/);
  assert.match(generated, /ACCEPTED MAIN DEV POLICY/);
  assert.doesNotMatch(generated, /MUTABLE TASK BRANCH/);
  assert.equal(await status(fixture.workspace), before);
  const excludePath = path.join(fixture.workspace, ".git", "info", "exclude");
  assert.equal(
    (await fs.readFile(excludePath, "utf8")).split("/AGENTS.override.md")
      .length - 1,
    1,
  );
  await sync.beforeTurn(fixture.chatKey);
  assert.equal(
    (await fs.readFile(excludePath, "utf8")).split("/AGENTS.override.md")
      .length - 1,
    1,
  );
});

test("/new synchronization repairs stale and missing overrides before session creation", async (t) => {
  const fixture = await makeRepository(t);
  const config = await loadRoleIdentityConfig(fixture.mappingFile);
  const sync = createRoleIdentitySynchronizer({
    config,
    chats: fixture.chats,
    options: fixture.options,
    run: fixture.run,
  });
  const target = path.join(fixture.workspace, "AGENTS.override.md");
  await fs.writeFile(target, "STALE");
  const stale = await sync.beforeTurn(fixture.chatKey);
  assert.equal(stale.synchronized, true);
  assert.match(await fs.readFile(target, "utf8"), /ACCEPTED MAIN DEV POLICY/);
  await fs.rm(target);
  await sync.beforeTurn(fixture.chatKey);
  assert.match(await fs.readFile(target, "utf8"), /ACCEPTED MAIN COMMON/);
  fixture.chat.threadId = "existing-thread";
  assert.deepEqual(await sync.beforeTurn(fixture.chatKey), {
    synchronized: false,
    reason: "existing-session",
  });
  assert.equal(
    (await sync.beforeTurn(fixture.chatKey, { forceNewSession: true }))
      .synchronized,
    true,
  );
});

test("unknown MyFkenTS topic and mismatched workspace fail closed", async (t) => {
  const fixture = await makeRepository(t);
  const config = await loadRoleIdentityConfig(fixture.mappingFile);
  const sync = createRoleIdentitySynchronizer({
    config,
    chats: fixture.chats,
    options: fixture.options,
    run: fixture.run,
  });
  await assert.rejects(
    sync.beforeTurn("-100123:topic:999"),
    /Unknown MyFkenTS topic/,
  );
  fixture.chat.forumBinding.cwd = path.join(fixture.root, "other-workspace");
  await assert.rejects(
    sync.beforeTurn(fixture.chatKey),
    /workspace does not match/,
  );
});

test("AgentDevTeam Platform topic requires its explicit mapping and trusted workspace/repository", async (t) => {
  const fixture = await makeRepository(t, PLATFORM_PROJECT);
  const config = await loadRoleIdentityConfig(fixture.mappingFile);
  const sync = createRoleIdentitySynchronizer({
    config,
    chats: fixture.chats,
    options: fixture.options,
    run: fixture.run,
  });
  fixture.chat.threadId = "existing-thread";
  await assert.rejects(
    sync.beforeTurn("-100123:topic:999"),
    /Unknown AgentDevTeam Platform topic/,
  );
  fixture.chat.threadId = "";
  fixture.chat.forumBinding.cwd = path.join(fixture.root, "other-workspace");
  fixture.options.setWorkingDirectory(
    path.join(fixture.root, "other-workspace"),
  );
  await assert.rejects(
    sync.beforeTurn(fixture.chatKey),
    /workspace does not match/,
  );
  fixture.chat.forumBinding.cwd = fixture.workspace;
  fixture.options.setWorkingDirectory(fixture.workspace);
  fixture.chat.threadId = "existing-thread";
  fixture.setRemoteProject(PROJECT);
  await assert.rejects(
    sync.beforeTurn(fixture.chatKey),
    /does not match its trusted mapping/,
  );
  fixture.setRemoteProject(PLATFORM_PROJECT);
  fixture.chat.forumBinding.cwd = path.join(fixture.root, "other-workspace");
  fixture.options.setWorkingDirectory(
    path.join(fixture.root, "other-workspace"),
  );
  await assert.rejects(
    sync.beforeTurn(fixture.chatKey),
    /workspace does not match its trusted mapping/,
  );
});

test("a trusted role topic without its persisted workspace binding fails closed", async (t) => {
  const fixture = await makeRepository(t);
  const config = await loadRoleIdentityConfig(fixture.mappingFile);
  const sync = createRoleIdentitySynchronizer({
    config,
    chats: { get: () => ({}) },
    options: fixture.options,
    run: fixture.run,
  });
  await assert.rejects(
    sync.beforeTurn(fixture.chatKey),
    /missing its bound workspace/,
  );
});

test("unbound private topics remain untouched", async () => {
  const sync = createRoleIdentitySynchronizer({
    config: { mappings: [] },
    chats: { get: () => ({}) },
    options: { get: () => ({}) },
  });
  assert.deepEqual(await sync.beforeTurn("12345"), {
    synchronized: false,
    reason: "not-project-topic",
  });
});

function mappings(workspace, project = PROJECT) {
  return ["dev", "review", "qa"].map((roleId, index) => ({
    chatId: "-100123",
    topicId: String(201 + index),
    workspace: path.join(workspace, roleId),
    project,
    roleId,
    rolePolicyPath: `policies/${roleId}.md`,
  }));
}

async function makeRepository(t, project = PROJECT) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repo");
  const remote = path.join(root, "origin.git");
  await fs.mkdir(workspace);
  await git(root, "init", "--bare", remote);
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.name", "Test");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await fs.mkdir(path.join(workspace, "policies"));
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    "ACCEPTED MAIN COMMON\n",
  );
  for (const role of ["dev", "review", "qa"])
    await fs.writeFile(
      path.join(workspace, "policies", `${role}.md`),
      `ACCEPTED MAIN ${role.toUpperCase()} POLICY\n`,
    );
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "accepted policy");
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "push", "-u", "origin", "main");
  await git(workspace, "checkout", "-b", "task/branch");
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    "MUTABLE TASK BRANCH COMMON\n",
  );
  await fs.writeFile(
    path.join(workspace, "policies", "dev.md"),
    "MUTABLE TASK BRANCH POLICY\n",
  );
  const roleMappings = mappings(root, project);
  roleMappings[0].workspace = workspace;
  await createWorkspaceDirectories(roleMappings.slice(1));
  const mappingFile = path.join(root, "roles.json");
  await fs.writeFile(
    mappingFile,
    JSON.stringify({ version: 1, project, mappings: roleMappings }),
  );
  const chatKey = "-100123:topic:201";
  const chat = {
    forumBinding: { cwd: workspace },
    options: { workingDirectory: workspace },
  };
  let remoteProject = project;
  let optionsWorkingDirectory = workspace;
  const realRun = async (...args) => {
    if (
      args[0] === "git" &&
      args[1][0] === "remote" &&
      args[1][1] === "get-url"
    ) {
      return {
        stdout: `https://github.com/${remoteProject}.git\n`,
        stderr: "",
      };
    }
    return execFile(...args);
  };
  return {
    root,
    workspace,
    mappingFile,
    chatKey,
    chat,
    chats: { get: () => chat },
    options: {
      get: () => ({ workingDirectory: optionsWorkingDirectory }),
      setWorkingDirectory(value) {
        optionsWorkingDirectory = value;
      },
    },
    run: realRun,
    setRemoteProject(value) {
      remoteProject = value;
    },
  };
}

async function createWorkspaceDirectories(roleMappings) {
  await Promise.all(
    roleMappings.map((mapping) =>
      fs.mkdir(mapping.workspace, { recursive: true }),
    ),
  );
}

async function git(cwd, ...args) {
  return execFile("git", args, { cwd });
}

async function status(cwd) {
  return (await git(cwd, "status", "--porcelain=v1", "--untracked-files=all"))
    .stdout;
}
