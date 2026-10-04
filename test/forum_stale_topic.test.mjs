import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";
import { forumTopicKey } from "../src/forum/store.js";

test("dispatch marks a dead Telegram topic stale and /topics hides it", async (t) => {
  const groupId = 1;
  const staleId = 563574;
  const state = {
    ui: { language: "en" },
    chats: {},
    forum: {
      groups: {
        [groupId]: {
          chatId: groupId,
          chatType: "private",
          botId: 123,
          ownerId: 1,
          topics: {
            0: { id: 0, name: "Private conversation", role: "workspace" },
            [staleId]: {
              id: staleId,
              name: "MyFken-Review",
              role: "project",
              cwd: "/tmp/stale-project",
              bindingId: "binding-stale",
              preset: { cwd: "/tmp/stale-project" },
            },
            [staleId + 1]: { id: staleId + 1, name: "Replacement", role: "project" },
          },
        },
      },
      jobs: {},
    },
  };
  const f = await workspaceFixture(t, {
    state,
    api: async (method, payload) => {
      if (
        method === "sendChatAction" &&
        payload.message_thread_id === staleId
      ) {
        const error = new Error("400 Bad Request: message thread not found");
        error.response = {
          error_code: 400,
          description: "Bad Request: message thread not found",
        };
        throw error;
      }
    },
  });
  state.forum.groups[groupId].topics[staleId].cwd = f.root;
  state.forum.groups[groupId].topics[staleId].preset = { cwd: f.root };
  const staleContext = {
    chat: { id: groupId, type: "private" },
    from: { id: 1 },
    message: { message_id: 500 },
  };
  await assert.rejects(
    f.controller.forum.jobs.dispatch(staleContext, staleId, "must not queue"),
  );
  assert.equal(
    f.apiCalls.filter(
      (call) =>
        call.method === "sendChatAction" &&
        call.payload.message_thread_id === staleId,
    ).length,
    1,
  );
  await f.send("/topics", {
    chatId: groupId,
    chatType: "private",
  });
  const key = forumTopicKey(state.forum.groups[groupId], staleId);
  assert.equal(state.forum.groups[groupId].topics[staleId].stale, true);
  assert.equal(
    state.forum.groups[groupId].topics[staleId].bindingId,
    undefined,
  );
  assert.equal(state.chats[key]?.forumBinding, undefined);
  assert.doesNotMatch(f.messages.at(-1).text, /MyFken-Review/);
  await f.controller.forum.service.bind(staleContext, staleId + 1, {
    id: "replacement", name: "Replacement", cwd: f.root, accountId: "default",
    options: { workingDirectory: f.root, model: "model-one" }
  });
  assert.equal(state.forum.groups[groupId].topics[staleId + 1].cwd, f.root);
  await assert.rejects(
    f.controller.forum.jobs.dispatch(staleContext, staleId, "must not queue"),
  );
  assert.equal(f.queue.size, 0);
});

test("opening /topics does not probe every registered Telegram topic", async (t) => {
  const groupId = -10042;
  const state = {
    ui: { language: "en" }, chats: {},
    forum: { groups: { [groupId]: { chatId: groupId, chatType: "supergroup", botId: 123, ownerId: 1,
      topics: {
        1: { id: 1, name: "General", role: "manager" },
        21: { id: 21, name: "Live project", role: "project", cwd: process.cwd(), bindingId: "live" },
        22: { id: 22, name: "Another project", role: "project", cwd: process.cwd(), bindingId: "other" }
      } } }, jobs: {} }
  };
  const f = await workspaceFixture(t, { state });
  f.r.config.allowedChatIds?.add?.(String(groupId));
  f.r.config.allowedThreadIds = new Set(["1", "21", "22"]);
  await f.send("/topics", { chatId: groupId, chatType: "supergroup", isForum: true, threadId: 1 });
  assert.ok(f.buttons().some((button) => button.text.includes("Live project")));
  assert.equal(f.apiCalls.filter((call) => call.method === "sendChatAction").length, 0);
});
