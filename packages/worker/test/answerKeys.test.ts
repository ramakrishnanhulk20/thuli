// Not covered here: whether the real answer-key files still match counts.md (the replay prints its own totals), and
// CSV quoting, which these files never use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnswerKeyError, loadClaimEvents, loadFarmKey } from '../src/replay/answerKeys.ts';

const CLAIM_HEADER = 'block_number,block_time_utc,tx_hash,log_index,account,recipient,amount_wei,amount_robo';
const FARM_HEADER = 'claim_wallet,collector,family_n,funding_wallet,funded_by,claimed_robo_wei,transfer_to_collector_tx';
const TX = `0x${'9a'.repeat(32)}`;
const A = `0x${'0a'.repeat(20)}`;
const B = `0x${'0b'.repeat(20)}`;
const C = `0x${'0c'.repeat(20)}`;
// The checksummed spelling of a real ROBO collector; the loader must return it lowercase.
const COLLECTOR = '0x8439895979b4060e20839D6d8BCEDA2d786e2401';

let dir: string;

function csv(name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-keys-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadClaimEvents', () => {
  it('reads every claim in file order with lowercase addresses and amounts as bigint', () => {
    const file = csv('claims.csv', [
      CLAIM_HEADER,
      `24546233,2026-02-27 05:39:59,${TX},373,${A},${A},1000000000000000000,1`,
      `24547254,2026-02-27 09:05:23,${TX},258,${B},${COLLECTOR},6114337188000000423936,6114.337188000000423936`,
    ]);
    expect(loadClaimEvents(file)).toEqual([
      { recipient: A, account: A, amountWei: 10n ** 18n, block: 24546233 },
      { recipient: COLLECTOR.toLowerCase(), account: B, amountWei: 6114337188000000423936n, block: 24547254 },
    ]);
  });

  it('fails on a bad address, naming the file and the line', () => {
    const file = csv('claims.csv', [
      CLAIM_HEADER,
      `24546233,2026-02-27 05:39:59,${TX},373,${A},${A},1,0.000000000000000001`,
      `24546234,2026-02-27 05:40:11,${TX},12,${B},0x1234,1,0.000000000000000001`,
    ]);
    expect(() => loadClaimEvents(file)).toThrow(AnswerKeyError);
    expect(() => loadClaimEvents(file)).toThrow(`${file}, line 3: recipient not a 0x address of 40 hex characters`);
  });
});

describe('loadFarmKey', () => {
  it('keys each claim wallet to its family and turns a blank funding wallet into null', () => {
    const file = csv('farm.csv', [
      FARM_HEADER,
      `${A},${COLLECTOR},1,${COLLECTOR},Ourbit,18953599999999998543872,${TX}`,
      `${B},${C},184,,,4000000000000000000,${TX}`,
    ]);
    const key = loadFarmKey(file);
    expect([...key.keys()]).toEqual([A, B]);
    expect(key.get(A)).toEqual({ collector: COLLECTOR.toLowerCase(), family: 1, fundingWallet: COLLECTOR.toLowerCase() });
    expect(key.get(B)).toEqual({ collector: C, family: 184, fundingWallet: null });
  });

  it('fails on a bad collector or a wallet listed twice, naming the line', () => {
    const bad = csv('bad.csv', [FARM_HEADER, `${A},0xnothex,1,,,1,${TX}`]);
    expect(() => loadFarmKey(bad)).toThrow(`${bad}, line 2: collector not a 0x address of 40 hex characters`);
    const twice = csv('twice.csv', [FARM_HEADER, `${A},${C},1,,,1,${TX}`, `${A.toUpperCase().replace('0X', '0x')},${C},2,,,1,${TX}`]);
    expect(() => loadFarmKey(twice)).toThrow(`${twice}, line 3: claim_wallet listed twice`);
  });
});
