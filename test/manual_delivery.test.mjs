import test from "node:test";
import assert from "node:assert/strict";
import { createManualDeliveryController } from "../src/recovery/manual_delivery.js";
import { digestText } from "../src/recovery/turn_journal.js";

function fixture({ digest = digestText("saved answer"), sendError = null } = {}) {
  const entry = {
    deliveryStatus: "delivery_failed",
    ambiguous: true,
    responseDigest: digest,
    updatedAt: "2026-07-21T00:00:00.000Z"
  };
  const state = { worker: { deliveries: { "chat:job-1": entry } } };
  const sent = [];
  const notices = [];
  const transitions = [];
  const controller = createManualDeliveryController({
    state,
    activeTurns: new Map(),
    getWorkerClient: () => ({
      getJobStatus: async () => ({ job: { id: "job-1", chatKey: "chat", status: "completed" } }),
      readJobEvents: async () => ({ events: [
        { seq: 1, type: "item.completed", item: { id: "answer", type: "agent_message", text: "saved answer" } },
        { seq: 2, type: "worker.job.completed", status: "completed" }
      ] })
    }),
    journal: {
      digestText,
      recordTelegramReplyReady: async () => transitions.push("ready"),
      recordTelegramReplyStarted: async () => transitions.push("started"),
      recordTelegramReplyCompleted: async () => { transitions.push("completed"); entry.deliveryStatus = "delivery_sent"; },
      recordTelegramReplyFailed: async () => transitions.push("failed")
    },
    telegram: {
      replyHtml: async (_ctx, message) => notices.push(message),
      replyCodexAnswer: async (_ctx, message) => {
        sent.push(message);
        if (sendError) throw sendError;
      }
    },
    formatTurn: (turn) => turn.finalResponse,
    text: (key) => key,
    logger: { warn() {} }
  });
  return { controller, entry, sent, notices, transitions };
}

test("manual resend uses the completed worker result only after explicit chat-bound request", async () => {
  const f = fixture();
  await f.controller.handle({}, "other-chat", "resend job-1");
  assert.deepEqual(f.sent, []);
  await f.controller.handle({}, "chat", "");
  assert.deepEqual(f.sent, []);
  assert.match(f.notices.at(-1), /job-1/);
  await f.controller.handle({}, "chat", "resend job-1");
  assert.deepEqual(f.sent, ["saved answer"]);
  assert.deepEqual(f.transitions, ["ready", "started", "completed"]);
  assert.equal(f.entry.deliveryStatus, "delivery_sent");
});

test("manual resend refuses an altered reconstructed answer", async () => {
  const f = fixture({ digest: digestText("different") });
  await f.controller.handle({}, "chat", "resend job-1");
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.transitions, []);
  assert.equal(f.notices.at(-1), "deliveryDigestMismatch");
});

test("manual resend records an ambiguous timeout instead of marking delivery sent", async () => {
  const f = fixture({ sendError: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
  await f.controller.handle({}, "chat", "resend job-1");
  assert.deepEqual(f.transitions, ["ready", "started", "failed"]);
  assert.equal(f.notices.at(-1), "deliveryRetryFailed");
});
