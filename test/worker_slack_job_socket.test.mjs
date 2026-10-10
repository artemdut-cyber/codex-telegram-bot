import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import {
  authorizeUnixPeer,
  readUnixPeerCredentials,
  SLACK_JOB_SOCKET_PATH,
} from "../src/worker/slack_job_security.js";

function platformJob(issueNumber = 47) {
  const id = `slack-agentdevteam-platform-issue-${issueNumber}`;
  const issueUrl = `https://github.com/artemdut-cyber/agentdevteam-platform/issues/${issueNumber}`;
  const text = `Implement GitHub Issue ${issueUrl}. Follow its exact scope and acceptance criteria. Open one Draft PR linked to the Issue. Do not merge or deploy. Report the Draft PR URL and full head SHA.`;
  return {
    id,
    progressTurnId: id,
    chatKey: "manual:agentdevteam-platform:developer",
    chatId: "manual:agentdevteam-platform:developer",
    kind: "user",
    text,
    inputText: text,
    imagePaths: [],
    threadId: "",
    accountId: "default",
    effectiveOptions: {
      workingDirectory: "",
      sandboxMode: "workspace-write",
    },
  };
}

async function startFixture({
  peerCredentials,
  platform = "linux",
  enabled = true,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-slack-worker-"));
  const workspace = path.join(dir, "approved-workspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  const config = {
    codexWorkerStateDir: path.join(dir, "state"),
    codexWorkerSocket: path.join(dir, "telegram.sock"),
    codexWorkerConnectTimeoutMs: 500,
    codexWorkerLogRetentionDays: 0,
    codexTransport: "sdk",
    codexHome: path.join(dir, "codex-home"),
    codexSlackJobSocket: enabled ? SLACK_JOB_SOCKET_PATH : "",
    codexSlackJobUid: process.getuid() + 1,
    codexSlackJobGid: process.getgid(),
    codexSlackJobWorkspace: workspace,
  };
  const starts = [];
  const getPeerCredentials =
    peerCredentials ?? (() => ({ pid: 12_345, uid: config.codexSlackJobUid }));
  const worker = createWorkerServer({
    config,
    platform,
    slackSocketPathOverride: path.join(dir, "slack.sock"),
    getPeerCredentials,
    executeJob: async ({ job }) => {
      starts.push(job);
    },
    logger: { warn() {} },
  });
  if (enabled && platform === "linux") await worker.listen();
  else if (!enabled) await worker.listen();
  return {
    dir,
    workspace,
    config,
    worker,
    starts,
    client: createWorkerClient(config),
    slackSocket: path.join(dir, "slack.sock"),
    async close() {
      await worker.close().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function request(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket response timed out"));
    }, 1000);
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: "platform-contract-1", method, params })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "EPIPE" || error.code === "ECONNRESET") resolve(null);
      else reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!buffer) resolve(null);
    });
  });
}

test("Platform PR #40 wire contract starts and reads only the bounded Slack job", async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const stat = await fs.stat(f.slackSocket);
  assert.equal(stat.mode & 0o777, 0o660);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.gid, process.getgid());

  const job = platformJob();
  job.effectiveOptions.workingDirectory = f.workspace;
  const started = await request(f.slackSocket, "job/start", { job });
  assert.deepEqual(started.result, { jobId: job.id, status: "accepted" });
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].slackJobV1, true);

  const status = await request(f.slackSocket, "job/status", { jobId: job.id });
  assert.equal(status.result.job.id, job.id);
  assert.equal(status.result.job.status, "accepted");
  assert.equal("text" in status.result.job, false);
  const events = await request(f.slackSocket, "job/events", {
    jobId: job.id,
    afterSeq: 0,
    limit: 500,
  });
  assert.equal(events.result.events[0].type, "worker.job.accepted");
  assert.equal(
    (await request(f.slackSocket, "worker/status")).result.status,
    "ok",
  );
});

test("Slack listener denies general worker methods and Telegram job reads", async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const deniedMethod = await request(f.slackSocket, "job/cancel", {
    jobId: "telegram-job",
  });
  assert.equal(deniedMethod.ok, false);
  const deniedStatus = await request(f.slackSocket, "job/status", {
    jobId: "telegram-job",
  });
  assert.equal(deniedStatus.ok, false);
  const deniedEvents = await request(f.slackSocket, "job/events", {
    jobId: "telegram-job",
  });
  assert.equal(deniedEvents.ok, false);
});

test("Slack listener rejects wrong UID and missing peer credentials before parsing requests", async (t) => {
  const wrongUid = await startFixture({
    peerCredentials: () => ({ pid: 321, uid: 77 }),
  });
  t.after(() => wrongUid.close());
  assert.equal(await request(wrongUid.slackSocket, "worker/status"), null);

  const missing = await startFixture({ peerCredentials: () => undefined });
  t.after(() => missing.close());
  assert.equal(await request(missing.slackSocket, "worker/status"), null);
});

test(
  "Linux SO_PEERCRED binding reads the connected process identity",
  { skip: process.platform !== "linux" },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-peer-"));
    const socketPath = path.join(dir, "peer.sock");
    const server = net.createServer((socket) => {
      try {
        const credentials = readUnixPeerCredentials(socket);
        assert.equal(credentials.uid, process.getuid());
        assert.equal(Number.isSafeInteger(credentials.pid), true);
        assert.equal(authorizeUnixPeer(credentials, process.getuid()), true);
      } catch (error) {
        t.fail(error.message);
      } finally {
        socket.end();
        server.close();
      }
    });
    t.after(async () => {
      await new Promise((resolve) => server.close(() => resolve())).catch(
        () => {},
      );
      await fs.rm(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = net.createConnection(socketPath);
    await new Promise((resolve, reject) =>
      client.once("close", resolve).once("error", reject),
    );
  },
);

test("Slack job validation rejects project, namespace, workspace, sandbox, format and extra options", async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const badJobs = [
    (job) => {
      job.id = "slack-other-repo-issue-47";
    },
    (job) => {
      const otherProject = job.text.replace(
        "artemdut-cyber/agentdevteam-platform",
        "attacker/other-project",
      );
      job.text = otherProject;
      job.inputText = otherProject;
    },
    (job) => {
      job.chatKey = "telegram:42";
    },
    (job) => {
      job.effectiveOptions.workingDirectory = "/tmp/elsewhere";
    },
    (job) => {
      job.effectiveOptions.sandboxMode = "danger-full-access";
    },
    (job) => {
      job.inputText = "run arbitrary shell";
    },
    (job) => {
      job.effectiveOptions.accountId = "private";
    },
    (job) => {
      job.shell = "id";
    },
  ];
  for (const mutate of badJobs) {
    const job = platformJob();
    job.effectiveOptions.workingDirectory = f.workspace;
    mutate(job);
    const result = await request(f.slackSocket, "job/start", { job });
    assert.equal(result.ok, false);
  }
  assert.equal(f.starts.length, 0);
});

test("Slack start is idempotent and does not change the normal Telegram worker API", async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const job = platformJob(48);
  job.effectiveOptions.workingDirectory = f.workspace;
  assert.equal(
    (await request(f.slackSocket, "job/start", { job })).result.status,
    "accepted",
  );
  assert.equal(
    (await request(f.slackSocket, "job/start", { job })).result.status,
    "accepted",
  );
  assert.equal(f.starts.length, 1);

  await f.client.startJob({
    id: "telegram-preserved",
    chatKey: "telegram:42",
    inputText: "normal job",
  });
  assert.equal(f.starts.length, 2);
  await assert.rejects(
    f.client.startJob({
      id: "slack-agentdevteam-platform-issue-49",
      chatKey: "manual:agentdevteam-platform:developer",
      slackJobV1: true,
    }),
    /reserved worker-owned field/,
  );
  const telegramStatus = await f.client.status();
  assert.equal(telegramStatus.status, "ok");
  assert.equal(Array.isArray(telegramStatus.activeJobs), true);
  assert.equal(telegramStatus.capabilities.includes("accounts-v1"), true);
  assert.equal(
    (
      await request(f.slackSocket, "job/status", {
        jobId: "telegram-preserved",
      })
    ).ok,
    false,
  );
});

test("Slack listener remains absent by default", async (t) => {
  const f = await startFixture({ enabled: false });
  t.after(() => f.close());
  await assert.rejects(fs.stat(f.slackSocket), { code: "ENOENT" });
  assert.equal((await f.client.status()).status, "ok");
});

test("Slack listener refuses unsupported platforms", async (t) => {
  const f = await startFixture({ platform: "darwin" });
  t.after(() => f.close());
  const worker = createWorkerServer({
    config: f.config,
    platform: "darwin",
    slackSocketPathOverride: f.slackSocket,
    logger: { warn() {} },
  });
  await assert.rejects(worker.listen(), /supported only on Linux/);
  await worker.close().catch(() => {});
});
