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

test("role mapping is explicit, complete, unique and restart-persistent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "roles.json");
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, mappings: mappings(root) }),
  );
  const first = await loadRoleIdentityConfig(file);
  const afterRestart = await loadRoleIdentityConfig(file);
  assert.deepEqual(first, afterRestart);
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

function mappings(workspace) {
  return ["dev", "review", "qa"].map((roleId, index) => ({
    chatId: "-100123",
    topicId: String(201 + index),
    workspace: path.join(workspace, roleId),
    project: PROJECT,
    roleId,
    rolePolicyPath: `policies/${roleId}.md`,
  }));
}

async function makeRepository(t) {
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
  const roleMappings = mappings(root);
  roleMappings[0].workspace = workspace;
  const mappingFile = path.join(root, "roles.json");
  await fs.writeFile(
    mappingFile,
    JSON.stringify({ version: 1, mappings: roleMappings }),
  );
  const chatKey = "-100123:topic:201";
  const chat = {
    forumBinding: { cwd: workspace },
    options: { workingDirectory: workspace },
  };
  const realRun = async (...args) => {
    if (
      args[0] === "git" &&
      args[1][0] === "remote" &&
      args[1][1] === "get-url"
    ) {
      return {
        stdout: "https://github.com/artemdut-cyber/MyFkenTS.git\n",
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
    options: { get: () => ({ workingDirectory: workspace }) },
    run: realRun,
  };
}

async function git(cwd, ...args) {
  return execFile("git", args, { cwd });
}

async function status(cwd) {
  return (await git(cwd, "status", "--porcelain=v1", "--untracked-files=all"))
    .stdout;
}
