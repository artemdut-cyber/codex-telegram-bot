#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { readConfig } from "../src/config.js";
import { runCodexUpdate } from "../src/maintenance/update_runner.js";
import { runUpdateProcess } from "../src/maintenance/update_install.js";
import { writePrivateFileAtomic } from "../src/fs/private.js";
import { createMessageFormatter, textFor } from "../src/i18n.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { id: { type: "string" } }, strict: true });
if (!/^[a-f0-9-]{36}$/.test(values.id || "")) throw new Error("Update run ID required.");
const env = { ...process.env, ...dotenv.parse(await fs.readFile(path.join(appRoot, ".env"))) };
const config = readConfig(env, { appRoot });
const result = await runCodexUpdate(config, values.id);
const msg = createMessageFormatter((key) => textFor(result.language || "en", key));
const text = msg(`ui.codexUpdateResult.${result.phase}`, {
  previous: result.installation.current, version: result.target,
  error: result.error || "", rollbackError: result.rollbackError || ""
});
const runDir = path.join(config.codexUpdateDir, "runs", result.id);
const messageFile = path.join(runDir, "completion.txt");
await writePrivateFileAtomic(messageFile, text);
const args = [path.join(appRoot, "scripts/send-background-notification.mjs"),
  "--expected-bot-id", result.origin.botId, "--chat-id", result.origin.chatId,
  "--file", messageFile, "--receipt", path.join(runDir, "notification.json")];
if (result.origin.threadId) args.push("--thread-id", result.origin.threadId);
try {
  await runUpdateProcess(process.execPath, args, { timeout: 240_000, maxBuffer: 64 * 1024 });
} catch (error) {
  // Updating the CLI already has a durable outcome; a notification failure must
  // never rerun activation or send a duplicate after uncertain acceptance.
  console.error("Codex update notification requires review:", error.message);
}
console.log(JSON.stringify({ id: result.id, phase: result.phase }));
