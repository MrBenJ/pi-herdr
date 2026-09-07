import fs, { type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { Capture } from "../contracts.ts";

const MAX_BYTES = 51200;
const MAX_LINES = 2000;
const PREVIEW_BYTES = MAX_BYTES + 4;

export class CaptureLimitError extends Error {
  constructor() {
    super("Combined capture limit exceeded");
    this.name = "CaptureLimitError";
  }
}

export interface CaptureSink {
  write(chunk: Buffer): Promise<void>;
  finish(complete: boolean): Promise<Capture>;
}

export async function writeAll(file: FileHandle, chunk: Buffer, onWritten: (bytes: Buffer) => void): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
    if (bytesWritten === 0) throw new Error("Capture write made no progress");
    onWritten(chunk.subarray(offset, offset + bytesWritten));
    offset += bytesWritten;
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

// The bounded slice allocates at most four UTF8 bytes per retained code unit.
// StringDecoder.write intentionally leaves an incomplete trailing character out.
function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text.slice(0, maxBytes));
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function boundedHead(text: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  // Pretrim so pi's whole-line helper does not erase an oversized first line.
  return truncateHead(utf8Head(text, maxBytes), { maxBytes, maxLines }).content;
}

export function present(text: string, notice: string): string {
  if (!notice && Buffer.byteLength(text) <= MAX_BYTES && lineCount(text) <= MAX_LINES) return text;
  const suffix = boundedHead(notice || "[Output truncated]", MAX_BYTES, MAX_LINES);
  const body = boundedHead(text, MAX_BYTES - Buffer.byteLength(suffix) - 1, MAX_LINES - lineCount(suffix) - 1);
  return body ? `${body}\n${suffix}` : suffix;
}

export async function createCapture(
  directory: string,
  name: "stdout" | "stderr",
  budget: { remaining: number },
): Promise<CaptureSink> {
  const path = join(directory, name);
  const file = await fs.open(path, "wx", 0o600);
  let bytes = 0;
  let newlines = 0;
  let lastByte: number | undefined;
  let previewBytes = 0;
  let preview = "";
  const decoder = new StringDecoder("utf8");
  let ioFailed = false;
  let ioError: unknown;
  let limitExceeded = false;
  let tail: Promise<void> = Promise.resolve();
  let finished: Promise<Capture> | undefined;

  function onWritten(chunk: Buffer): void {
    bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) newlines++;
    if (chunk.length) lastByte = chunk[chunk.length - 1];
    const available = Math.min(chunk.length, PREVIEW_BYTES - previewBytes);
    if (available > 0) {
      preview += decoder.write(chunk.subarray(0, available));
      previewBytes += available;
    }
  }

  return {
    write(chunk) {
      if (finished) return Promise.reject(new Error("Capture is already finalized"));
      // Reserve before any await/queue boundary: two streams cannot overspend.
      const allowed = Math.min(chunk.length, budget.remaining);
      budget.remaining -= allowed;
      const overflow = allowed < chunk.length;
      if (overflow) limitExceeded = true;
      const operation = tail.then(async () => {
        if (ioFailed) throw ioError;
        try {
          await writeAll(file, chunk.subarray(0, allowed), onWritten);
        } catch (error) {
          ioFailed = true;
          ioError = error;
          throw error;
        }
        if (overflow) throw new CaptureLimitError();
      });
      // The caller still observes rejection; finalization must always settle.
      tail = operation.catch(() => {});
      return operation;
    },
    finish(complete) {
      if (!finished) {
        finished = (async () => {
          await tail;
          try { await file.close(); } catch { ioFailed = true; }
          const isComplete = complete && !ioFailed && !limitExceeded;
          if (isComplete && bytes === previewBytes) preview += decoder.end();
          // Invalid terminal bytes may expand to replacement characters during
          // decoding. Bound decoded storage too, independently of raw counters.
          const boundedPreview = utf8Head(preview, PREVIEW_BYTES);
          const lines = newlines + Number(bytes > 0 && lastByte !== 10);
          return {
            path, preview: boundedPreview, bytes, lines,
            truncated: bytes > MAX_BYTES || lines > MAX_LINES || Buffer.byteLength(preview) > MAX_BYTES,
            complete: isComplete, ioFailed,
          };
        })();
      }
      return finished;
    },
  };
}
