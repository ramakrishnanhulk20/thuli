import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Calls onLine for each line of the file, reading 1 MB at a time so a cache of many hundreds of megabytes never has to
 * fit in one string. Returns false when the file ends without a newline, which is what a crash mid-write leaves.
 */
function readLines(filePath: string, onLine: (text: string) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const data = Buffer.concat([carry, chunk.subarray(0, read)]);
      let start = 0;
      for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
        onLine(data.toString('utf8', start, end));
        start = end + 1;
      }
      carry = data.subarray(start);
    }
    if (carry.length === 0) return true;
    onLine(carry.toString('utf8'));
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A key-value store kept as one JSON line per entry, so a long run can stop at any moment and resume with everything
 * already fetched. Each put is one append, and a later line for the same key wins on reload.
 *
 * Every line read back is checked against the schema, because the file is our own earlier output and a crash can
 * leave a half-written last line. A line that is not JSON or does not match is skipped. If the file ends mid-line, a
 * newline is added at load so the next put starts on a line of its own instead of joining the broken one.
 *
 * Not safe for two processes writing the same file at once: appends from both can interleave. Use one writer per file.
 */
export class JsonlCache<T> {
  readonly #filePath: string;
  readonly #schema: z.ZodType<T>;
  readonly #entries = new Map<string, T>();

  constructor(filePath: string, schema: z.ZodType<T>) {
    this.#filePath = filePath;
    this.#schema = schema;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const Line = z.object({ key: z.string(), value: schema });
    const endsCleanly = readLines(filePath, (text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = Line.safeParse(json);
      if (parsed.success) this.#entries.set(parsed.data.key, parsed.data.value);
    });
    if (!endsCleanly) fs.appendFileSync(filePath, '\n');
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Appends one line and updates the in-memory copy. The value is checked against the schema first, so nothing is
   * written that the next load would throw away.
   *
   * @throws ZodError when the value does not match the schema; nothing is written.
   */
  put(key: string, value: T): void {
    const checked = this.#schema.parse(value);
    fs.appendFileSync(this.#filePath, `${JSON.stringify({ key, value: checked })}\n`);
    this.#entries.set(key, checked);
  }

  get size(): number {
    return this.#entries.size;
  }
}
