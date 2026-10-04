import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createFrameReader, encodeFrame, errorResponse, okResponse } from "../src/worker/protocol.js";

test("worker protocol encodes one JSON frame per line", () => {
  assert.equal(encodeFrame({ id: "1", method: "ping" }), "{\"id\":\"1\",\"method\":\"ping\"}\n");
  assert.deepEqual(okResponse("1", { status: "ok" }), { id: "1", ok: true, result: { status: "ok" } });
  assert.deepEqual(errorResponse("1", new Error("bad")), { id: "1", ok: false, error: { message: "bad" } });
});

test("worker protocol reader parses complete and split frames", () => {
  const stream = new PassThrough();
  const frames = [];
  const errors = [];
  createFrameReader(stream, (frame) => frames.push(frame), { onError: (error) => errors.push(error) });
  stream.write("{\"id\":\"1\"");
  stream.write(",\"method\":\"a\"}\n");
  stream.write("not-json\n");
  stream.write("{\"id\":\"2\",\"method\":\"b\"}\n");
  assert.deepEqual(frames, [
    { id: "1", method: "a" },
    { id: "2", method: "b" }
  ]);
  assert.equal(errors.length, 1);
});

test("UTF-8 frames survive every byte split and byte-at-a-time delivery", () => {
  const expected = [{ text: "안녕하세요🙂", path: "/한글/🚀", id: 1 }, { text: "끝😃", id: 2 }];
  const bytes = Buffer.from(expected.map(encodeFrame).join(""));
  for (let split = 0; split <= bytes.length; split += 1) {
    const stream = new PassThrough();
    const frames = [];
    const errors = [];
    const dispose = createFrameReader(stream, (frame) => frames.push(frame), { onError: (error) => errors.push(error) });
    stream.write(bytes.subarray(0, split));
    stream.write(bytes.subarray(split));
    assert.deepEqual(frames, expected, `split ${split}`);
    assert.deepEqual(errors, []);
    dispose();
  }
  const stream = new PassThrough();
  const frames = [];
  createFrameReader(stream, (frame) => frames.push(frame));
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(frames, expected);
});

test("malformed JSON does not poison subsequent UTF-8 frames", () => {
  const stream = new PassThrough();
  const frames = [], errors = [];
  createFrameReader(stream, (frame) => frames.push(frame), { onError: (error) => errors.push(error) });
  stream.write(Buffer.from('bad JSON\n{"text":"한🙂"}\n\n'));
  assert.deepEqual(frames, [{ text: "한🙂" }]);
  assert.equal(errors.length, 1);
});

test("end/close reject unfinished JSON and UTF-8 exactly once and detach listeners", () => {
  for (const tail of [Buffer.from('{"text":"unfinished'), Buffer.from('{"text":"🙂').subarray(0, -2), Buffer.from('{"complete":true}')]) {
    const stream = new PassThrough();
    const frames = [], errors = [];
    createFrameReader(stream, (frame) => frames.push(frame), { onError: (error) => errors.push(error) });
    stream.write(tail);
    stream.emit("end");
    stream.emit("close");
    assert.deepEqual(frames, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Incomplete worker frame/);
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.listenerCount("end"), 0);
    assert.equal(stream.listenerCount("close"), 0);
  }
  const stream = new PassThrough();
  const errors = [];
  const dispose = createFrameReader(stream, () => {}, { onError: (error) => errors.push(error) });
  stream.write("partial");
  dispose();
  stream.emit("close");
  assert.deepEqual(errors, []);
});
