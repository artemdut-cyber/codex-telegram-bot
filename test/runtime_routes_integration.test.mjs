import test from "node:test";
import assert from "node:assert/strict";
import { runtimeRoutesFixture } from "./helpers/runtime_routes_fixture.mjs";

async function press(f, data) {
  assert.ok(f.buttons().some((b) => b.callback_data === data), `Missing visible action ${data}`);
  await f.click(data);
  assert.doesNotMatch(f.messages.at(-1)?.html || "", /Telegram bot error/);
}
function previous(f, expected) {
  const buttons = f.buttons().filter((b) => b.text.startsWith("⬅️ "));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].callback_data, expected);
}

test("composed Telegram routes navigate settings, mutate an option, return and close", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/menu");
  await press(f, "p:settings");
  previous(f, "p:main");
  await press(f, "p:settings_runtime");
  await press(f, "p:settings_runtime_output");
  previous(f, "p:settings_runtime");
  const setting = f.buttons().find((b) => b.callback_data.startsWith("set:runtime_reactions:"));
  assert.ok(setting);
  await press(f, setting.callback_data);
  assert.ok(Object.hasOwn(f.state.runtime, "telegramReactionsEnabled"));
  previous(f, "p:settings");
  await press(f, "p:settings");
  await press(f, "p:main");
  const panel = f.messages.at(-1), count = f.messages.length;
  await press(f, "ui:close:menu");
  assert.ok(f.apiCalls.some((call) => call.method === "deleteMessage" && call.payload.message_id === panel.message_id));
  assert.equal(f.messages.length, count);
  assert.doesNotMatch(panel.text || "", /메뉴를 닫았습니다/);
});

test("composed tools and workspace menus preserve their entry route", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/menu");
  await press(f, "p:tools");
  for (const action of ["health", "doctor", "logs", "logs_error", "whoami", "config"]) {
    await press(f, `tool:${action}`);
    previous(f, "p:tools");
    await press(f, "p:tools");
  }
  await press(f, "w:mcp:tools");
  await f.press("이전");
  assert.ok(f.buttons().some((b) => b.callback_data === "tool:health"));
});

test("account usage routing preserves account selection and the accounts parent", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const account = await f.store.create("Second");
  await f.store.update(account.id, { status: "ready" });
  await f.send("/menu");
  await press(f, "acct:list");
  await press(f, "acct:usage:default:accounts");
  await press(f, `acct:usage:${account.id}:accounts`);
  previous(f, "acct:list");
  assert.equal(f.r.getChatState("1").accountId, "default");
  assert.deepEqual(f.usageReads, ["default", account.id]);
  await press(f, "acct:list");
  await press(f, "p:main");
  await f.send("/usage");
  previous(f, "p:main");
});

test("full middleware rejects a foreign user, isolates topics, and consumes stale input safely", async (t) => {
  const f = await runtimeRoutesFixture(t);
  await f.send("/projects", { threadId: 7 });
  const old = globalThis.structuredClone(f.messages.at(-1));
  const button = f.buttons().find((b) => b.text.includes("현재"));
  assert.ok(button);
  await f.click(button.callback_data, old, { userId: 999 });
  assert.equal(f.messages.length, 1);
  await f.click(button.callback_data, old, { threadId: 8 });
  assert.match(f.apiCalls.findLast((call) => call.method === "answerCallbackQuery").payload.text, /만료/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages.at(-1).html, old.html);
  await f.click(button.callback_data, old);
  await f.send("/accounts", { threadId: 7 });
  await f.send("do work", { threadId: 7 });
  assert.deepEqual(f.forwarded, ["do work"]);
  await f.send("/projects", { threadId: 7 });
  const expired = globalThis.structuredClone(f.messages.at(-1));
  const callback = f.buttons()[0].callback_data;
  f.clock.now += 16 * 60_000;
  await f.click(callback, expired);
  assert.match(f.apiCalls.findLast((call) => call.method === "answerCallbackQuery").payload.text, /만료/);
  assert.equal(f.messages.at(-1).html, expired.html);
});

test("composed workspace input accepts same-user forum-topic path and name", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const topic = { chatId: -10042, threadId: 21, chatType: "supergroup", isForum: true };
  await f.send("/projects", topic);
  await f.press("경로 입력");
  const key = `${topic.chatId}:${topic.threadId}:1`;
  const pathFlow = f.state.workspace.flows[key];
  assert.equal(pathFlow.data.stage, "project-path");
  assert.equal(pathFlow.chatId, topic.chatId);
  assert.equal(pathFlow.messageThreadId, topic.threadId);
  assert.equal(pathFlow.userId, 1);
  await f.send(f.root, topic);
  assert.equal(f.state.workspace.flows[key]?.data.awaiting, undefined);
  await f.press("이전");
  await f.press("현재 프로젝트 저장");
  const nameFlow = f.state.workspace.flows[key];
  assert.equal(nameFlow.data.stage, "project-name");
  assert.equal(nameFlow.chatId, topic.chatId);
  assert.equal(nameFlow.messageThreadId, topic.threadId);
  assert.equal(nameFlow.userId, 1);
  await f.send("Project from topic", topic);
  assert.ok(Object.values(f.state.workspace.projects).flat().some((p) => p.name === "Project from topic"));
});

test("workspace input follows an exact replied-to prompt across a Desktop thread transition", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const topic = { chatId: -10042, threadId: 21, chatType: "supergroup", isForum: true };
  await f.send("/projects", topic);
  await f.press("경로 입력");
  const prompt = globalThis.structuredClone(f.messages.at(-1));
  const root = f.root;
  await f.send(root, { ...topic, threadId: undefined, replyTo: prompt });
  assert.equal(f.state.workspace.flows[`${topic.chatId}:21:1`]?.data.awaiting, undefined);
  assert.match(f.messages.at(-1).html, /폴더/);
  assert.doesNotMatch(f.messages.at(-1).html, /만료/);
});

test("workspace input accepts a reply to its prompt in the same project topic", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const topic = { chatId: -10042, threadId: 21, chatType: "supergroup", isForum: true };
  await f.send("/projects", topic);
  await f.press("경로 입력");
  const prompt = globalThis.structuredClone(f.messages.at(-1));
  await f.send(f.root, { ...topic, replyTo: prompt });
  assert.equal(f.state.workspace.flows[`${topic.chatId}:21:1`]?.data.awaiting, undefined);
  assert.match(f.messages.at(-1).text, /폴더 찾아보기/);
  assert.doesNotMatch(f.messages.at(-1).text, /메뉴의 만료|만료되었습니다/);
});

test("workspace prompt replies correlate only to their own project topic", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const first = { chatId: -10042, threadId: 21, chatType: "supergroup", isForum: true };
  const second = { ...first, threadId: 22 };
  await f.send("/projects", first);
  await f.press("경로 입력");
  const firstPrompt = globalThis.structuredClone(f.messages.at(-1));
  await f.send("/projects", second);
  await f.press("폴더 경로 입력");
  const secondPrompt = globalThis.structuredClone(f.messages.at(-1));
  await f.send(f.root, { ...first, threadId: undefined, replyTo: firstPrompt });
  assert.equal(f.state.workspace.flows[`${first.chatId}:21:1`]?.data.awaiting, undefined);
  assert.equal(f.state.workspace.flows[`${second.chatId}:22:1`]?.messageId, secondPrompt.message_id);
});

test("unmatched Desktop context input is rejected without forwarding into another project", async (t) => {
  const f = await runtimeRoutesFixture(t);
  const topic = { chatId: -10042, threadId: 21, chatType: "supergroup", isForum: true };
  await f.send("/projects", topic);
  await f.press("경로 입력");
  await f.send(f.root, { ...topic, threadId: undefined });
  assert.equal(f.state.workspace.flows[`${topic.chatId}:21:1`]?.data.awaiting, true);
  assert.deepEqual(f.forwarded, []);
  assert.match(f.messages.at(-1).text, /진행 중인 입력 요청과 연결되지 않았습니다/);
});

test("/topics project creation binds the chosen preset through Telegram's topic UI", async (t) => {
  const groupId = -10042;
  const state = {
    ui: { language: "ko", timeZone: "Asia/Seoul" }, chats: {},
    forum: { groups: { [groupId]: { chatId: groupId, chatType: "supergroup", botId: 123, ownerId: 1,
      topics: { 1: { id: 1, name: "General", role: "manager" } } } }, jobs: {} }
  };
  const f = await runtimeRoutesFixture(t, { state, api: async (method) => {
    if (method === "getChatMember") return { status: "administrator", can_manage_topics: true };
    if (method === "createForumTopic") return { message_thread_id: 77, name: "Review" };
    if (method === "sendChatAction") return true;
  } });
  const projectDir = `${f.root}/existing-project`;
  await (await import("node:fs/promises")).mkdir(projectDir, { recursive: true });
  state.workspace.projects["1:0:1"] = [{ id: "saved-project", name: "Existing project", cwd: projectDir,
    accountId: "default", options: { workingDirectory: projectDir, model: "model-one" } }];
  const group = { chatId: groupId, chatType: "supergroup", isForum: true, threadId: 1 };
  await f.send("/topics", group);
  await f.press("프로젝트 토픽 만들기");
  await f.press("Existing project");
  await f.send("Review", group);
  assert.equal(state.forum.groups[groupId].topics[77].cwd, projectDir);
  assert.ok(state.forum.groups[groupId].topics[77].bindingId);
  assert.equal(f.r.getChatState(`${groupId}:topic:77`).forumBinding.cwd, projectDir);
  assert.equal(f.apiCalls.filter((call) => call.method === "createForumTopic").length, 1);
});
