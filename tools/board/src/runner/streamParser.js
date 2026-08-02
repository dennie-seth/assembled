import { StringDecoder } from "node:string_decoder";

function toTypedEvent(parsed) {
  if (parsed !== null && typeof parsed === "object" && typeof parsed.type === "string") {
    return parsed;
  }
  return { type: "unknown", raw: parsed };
}

/**
 * Turns the raw NDJSON stdout of `claude -p --output-format stream-json`
 * into typed events, one per line. Buffers partial lines across chunk
 * boundaries using a StringDecoder so a multi-byte UTF-8 sequence split
 * mid-chunk still decodes correctly.
 */
export class NdjsonEventParser {
  constructor({ onEvent, maxLineLength = Infinity } = {}) {
    this.onEvent = onEvent;
    this.maxLineLength = maxLineLength;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    this._drainLines();
  }

  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this._emitLine(this.buffer);
    }
    this.buffer = "";
  }

  _drainLines() {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._emitLine(line);
    }

    if (this.buffer.length > this.maxLineLength) {
      this._emit({
        type: "error",
        error: `line exceeded maxLineLength (${this.maxLineLength} chars) before a newline arrived`,
        raw: this.buffer
      });
      this.buffer = "";
    }
  }

  _emitLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this._emit({ type: "error", error: `malformed JSON: ${err.message}`, raw: line });
      return;
    }

    this._emit(toTypedEvent(parsed));
  }

  _emit(event) {
    if (this.onEvent) {
      this.onEvent(event);
    }
  }
}
