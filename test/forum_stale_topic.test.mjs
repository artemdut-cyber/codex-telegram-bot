import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";
import { forumTopicKey } from "../src/forum/store.js";

test("/topics reconciles a saved topic when Telegram reports message thread not found", async (t) => {
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
              cwd: "/tmp/project",
              bindingId: "binding-stale",
              preset: { cwd: "/tmp/project" },
            },
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
  await assert.rejects(
    f.controller.forum.jobs.dispatch(staleContext, staleId, "must not queue"),
  );
  assert.equal(f.queue.size, 0);
});
