import { describe, it, expect, vi } from "vitest";
import { NdjsonEventParser } from "../../src/runner/streamParser.js";

function collect() {
  const events = [];
  const onEvent = (e) => events.push(e);
  return { events, onEvent };
}

describe("NdjsonEventParser — one event per line", () => {
  it("parses a single complete line delivered in one chunk", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"system","subtype":"init"}\n'));
    expect(events).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("parses multiple lines delivered in one chunk, in order", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n'));
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  it("buffers a partial line across two chunks and emits once complete", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"assistant","messa'));
    expect(events).toEqual([]);
    parser.push(Buffer.from('ge":"hi"}\n'));
    expect(events).toEqual([{ type: "assistant", message: "hi" }]);
  });

  it("buffers a partial line across many small chunks", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    const line = '{"type":"result","result":"done"}\n';
    for (const char of line) {
      parser.push(Buffer.from(char));
    }
    expect(events).toEqual([{ type: "result", result: "done" }]);
  });

  it("skips blank lines without emitting spurious events", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"a"}\n\n{"type":"b"}\n'));
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("tolerates CRLF line endings", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"a"}\r\n{"type":"b"}\r\n'));
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("end() flushes a trailing line with no terminating newline", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"type":"result","result":"ok"}'));
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([{ type: "result", result: "ok" }]);
  });

  it("wraps a JSON value with no string type field as an unknown event", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from("[1,2,3]\n"));
    expect(events).toEqual([{ type: "unknown", raw: [1, 2, 3] }]);
  });
});

describe("NdjsonEventParser — split UTF-8 across chunk boundaries", () => {
  it("decodes a multi-byte UTF-8 sequence split across two chunk boundaries", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    const line = JSON.stringify({ type: "assistant", text: "café \u{1F600} done" }) + "\n";
    const buf = Buffer.from(line, "utf8");

    // café's "é" is 2 bytes (0xC3 0xA9); the emoji is 4 bytes. Split mid-sequence
    // by cutting one byte into the emoji's 4-byte run.
    const emojiIndex = buf.indexOf(Buffer.from("\u{1F600}", "utf8"));
    const cutPoint = emojiIndex + 2; // inside the 4-byte emoji sequence

    parser.push(buf.subarray(0, cutPoint));
    parser.push(buf.subarray(cutPoint));

    expect(events).toEqual([{ type: "assistant", text: "café \u{1F600} done" }]);
  });

  it("decodes many small single-byte-at-a-time chunks containing multi-byte text", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    const line = JSON.stringify({ type: "assistant", text: "日本語 emoji \u{1F680}" }) + "\n";
    const buf = Buffer.from(line, "utf8");

    for (let i = 0; i < buf.length; i += 1) {
      parser.push(buf.subarray(i, i + 1));
    }

    expect(events).toEqual([{ type: "assistant", text: "日本語 emoji \u{1F680}" }]);
  });
});

describe("NdjsonEventParser — malformed JSON", () => {
  it("reports a malformed line as an error event instead of throwing", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    expect(() => parser.push(Buffer.from("not json at all\n"))).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].raw).toBe("not json at all");
    expect(typeof events[0].error).toBe("string");
  });

  it("recovers and keeps parsing subsequent valid lines after a malformed one", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    parser.push(Buffer.from('{"broken"\n{"type":"ok"}\n'));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("error");
    expect(events[1]).toEqual({ type: "ok" });
  });

  it("does not crash on garbage binary data", () => {
    const { onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    expect(() => parser.push(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x0a]))).not.toThrow();
  });
});

describe("NdjsonEventParser — huge lines", () => {
  it("handles a very large single line split across many small chunks without losing data", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent });
    const bigText = "x".repeat(300_000);
    const line = JSON.stringify({ type: "assistant", text: bigText }) + "\n";
    const buf = Buffer.from(line, "utf8");

    const chunkSize = 4096;
    for (let i = 0; i < buf.length; i += chunkSize) {
      parser.push(buf.subarray(i, i + chunkSize));
    }

    expect(events).toHaveLength(1);
    expect(events[0].text).toHaveLength(300_000);
    expect(events[0]).toEqual({ type: "assistant", text: bigText });
  });

  it("guards against unbounded memory growth with a configurable maxLineLength, emitting an error instead of crashing", () => {
    const { events, onEvent } = collect();
    const parser = new NdjsonEventParser({ onEvent, maxLineLength: 100 });

    expect(() => parser.push(Buffer.from("x".repeat(500)))).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");

    // parser recovers for the next line
    parser.push(Buffer.from('{"type":"ok"}\n'));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "ok" });
  });

  it("has no cap by default", () => {
    const parser = new NdjsonEventParser({ onEvent: vi.fn() });
    expect(parser.maxLineLength).toBe(Infinity);
  });
});
