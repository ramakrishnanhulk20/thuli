// Not covered here: the export itself, rebuilding the replay and building the files (webExport.test.ts and the export's
// run on the real replay cover those), and a real Windows lock. A folder sitting where the file should go stands in for
// one, since a rename onto a folder fails on every system, but nothing here holds a handle the way the dev server does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RENAME_PAUSE_MS, RENAME_RETRIES, sweepPartials, writePublic } from '../scripts/export-replay.ts';
import { ExportCheckError } from '../src/replay/webExport.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-export-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (relative: string, text = '{}\n') => {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const named = (files: string[]) => files.map((file) => path.relative(dir, file).replaceAll('\\', '/')).sort();
const filesLeft = () =>
  named(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name)),
  );

describe('sweepPartials', () => {
  it('deletes every .partial file at any depth and keeps every other file, including those in a folder named .partial', () => {
    for (const file of [
      'robo/summary.json',
      'robo/summary.json.partial',
      'robo/wallets/0a.json.partial',
      'robo/groups/7.json',
      'robo/groups/old/7.json.partial',
      'hop.json.partial',
      'versions.json',
      'notes.partial.txt',
      'kept.partial/inside.json',
    ]) {
      put(file);
    }

    expect(named(sweepPartials(dir))).toEqual([
      'hop.json.partial',
      'robo/groups/old/7.json.partial',
      'robo/summary.json.partial',
      'robo/wallets/0a.json.partial',
    ]);
    expect(filesLeft()).toEqual(['kept.partial/inside.json', 'notes.partial.txt', 'robo/groups/7.json', 'robo/summary.json', 'versions.json']);
    expect(sweepPartials(dir)).toEqual([]);
    expect(sweepPartials(path.join(dir, 'absent'))).toEqual([]);
  });
});

describe('writePublic', () => {
  it('replaces the file through a .partial name and leaves no .partial behind', async () => {
    const file = put('robo/summary.json', 'old\n');
    await writePublic(file, 'new\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(filesLeft()).toEqual(['robo/summary.json']);
  });

  it('tries a failed rename again and finishes once the way is clear', async () => {
    const file = path.join(dir, 'hop.json');
    put('hop.json/blocker');
    setTimeout(() => fs.rmSync(file, { recursive: true }), RENAME_PAUSE_MS * 1.5);
    await writePublic(file, 'fresh\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('fresh\n');
    expect(filesLeft()).toEqual(['hop.json']);
  });

  it(`fails naming the file after ${RENAME_RETRIES} retries ${RENAME_PAUSE_MS} ms apart, and the sweep then removes its .partial`, async () => {
    const file = path.join(dir, 'versions.json');
    put('versions.json/blocker');
    const started = performance.now();
    const failure = await writePublic(file, 'fresh\n').then(
      () => undefined,
      (error: unknown) => error,
    );
    const waited = performance.now() - started;

    expect(failure).toBeInstanceOf(ExportCheckError);
    expect(String(failure)).toMatch(/could not replace .*versions\.json after 5 retries/);
    expect(waited).toBeGreaterThanOrEqual(RENAME_RETRIES * RENAME_PAUSE_MS - 50);
    expect(waited).toBeLessThan((RENAME_RETRIES + 3) * RENAME_PAUSE_MS);
    expect(named(sweepPartials(dir))).toEqual(['versions.json.partial']);
    expect(filesLeft()).toEqual(['versions.json/blocker']);
  });
});
