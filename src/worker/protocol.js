import { localizedErrorDetails } from "../i18n.js";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export function createRequestId(prefix = "req") {
  return `${prefix}_${randomUUID()}`;
}

export function encodeFrame(payload) {
  return `${JSON.stringify(payload)}\n`;
}

export function okResponse(id, result = {}) {
  return { id, ok: true, result };
}

export function errorResponse(id, error) {
  return {
    id,
    ok: false,
    error: {
      ...localizedErrorDetails(error),
      message: error instanceof Error ? error.message : String(error || "Worker request failed.")
    }
  };
}

export function createFrameReader(stream, onFrame, { onError = () => {} } = {}) {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let ended = false;
  const onData = (chunk) => {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onFrame(JSON.parse(line));
      } catch (error) {
        onError(error, line);
      }
    }
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    buffer += decoder.end();
    if (buffer.length) onError(new Error("Incomplete worker frame at end of stream."), buffer);
    cleanup();
  };
  const cleanup = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  return cleanup;
}
