// Not covered here: whether the real ROBO answer-key files still match counts.md (the replay prints its own totals),
// and CSV quoting, which these files never use. The real Hop files are git-ignored, so their test is skipped in a clone
// that does not have them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnswerKeyError, loadClaimEvents, loadFarmKey, loadHopLists } from '../src/replay/answerKeys.ts';

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

describe('loadHopLists', () => {
  const REAL_KEYS = fileURLToPath(new URL('../../../reference/answer-keys', import.meta.url));
  const D = `0x${'0d'.repeat(20)}`;
  const E = `0x${'0e'.repeat(20)}`;
  const F = `0x${'0f'.repeat(20)}`;
  const LOWER_COLLECTOR = COLLECTOR.toLowerCase();
  // A group can name a wallet as its group name, as a key, or inside its notes, and all of them count.
  const GROUPS = JSON.stringify([
    { groupName: B, notes: '', totalConnectedAddresses: 2, totalEliminatedAddresses: 1, eliminatedAddresses: [D] },
    { groupName: D, notes: `kept ${COLLECTOR} after review`, totalConnectedAddresses: 2, reviewed: { [E]: true }, eliminatedAddresses: [] },
  ]);

  function hopFiles(changes: { eligible?: string[]; eliminated?: string[]; clusters?: string[]; groups?: string } = {}): void {
    fs.writeFileSync(path.join(dir, 'hop-eligibleAddresses.txt'), `${(changes.eligible ?? [A, COLLECTOR, B, E]).join('\n')}\n`);
    csv('hop-eliminatedSybilAttackers.csv', ['address', ...(changes.eliminated ?? [C, D, F])]);
    csv('hop-eliminated-cluster-map.csv', [
      'address,cluster_id,cluster_size',
      ...(changes.clusters ?? [`${C},hopc0001,2`, `${D},hopc0001,2`, `${F},hopc0002,1`]),
    ]);
    fs.writeFileSync(path.join(dir, 'hop-groups.json'), changes.groups ?? GROUPS);
  }

  it('splits eligible wallets by whether any group names them, all lowercase and in file order', () => {
    hopFiles();
    const lists = loadHopLists(dir);
    expect(lists.eligible).toEqual([A, LOWER_COLLECTOR, B, E]);
    expect(lists.eliminated).toEqual([C, D, F]);
    expect([...lists.negatives]).toEqual([A]);
    expect([...lists.keptInGroups]).toEqual([LOWER_COLLECTOR, B, E]);
    expect([...lists.clusters]).toEqual([
      [C, 'hopc0001'],
      [D, 'hopc0001'],
      [F, 'hopc0002'],
    ]);
  });

  it('fails on one wallet on both lists, however it is spelled', () => {
    hopFiles({ eliminated: [C, LOWER_COLLECTOR] });
    const file = path.join(dir, 'hop-eliminatedSybilAttackers.csv');
    expect(() => loadHopLists(dir)).toThrow(AnswerKeyError);
    expect(() => loadHopLists(dir)).toThrow(`${file}, line 3: address is on both the eligible and the eliminated list`);
  });

  it('fails on a wallet listed twice on one list, naming the line', () => {
    hopFiles({ eligible: [A, B, A] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eligibleAddresses.txt')}, line 3: address listed twice`);
    hopFiles({ clusters: [`${C},hopc0001,2`, `${C},hopc0002,1`] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminated-cluster-map.csv')}, line 3: address listed twice`);
  });

  it('sends every list through the one address parser, naming the line of a bad one', () => {
    const wrongChecksum = COLLECTOR.replace('D', 'd');
    hopFiles({ eligible: [A, wrongChecksum] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eligibleAddresses.txt')}, line 2: address not a 0x address of 40 hex characters`);
    hopFiles({ eliminated: ['0x1234'] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminatedSybilAttackers.csv')}, line 2: address not a 0x address of 40 hex characters`);
    hopFiles({ clusters: ['0x1234,hopc0001,1'] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminated-cluster-map.csv')}, line 2: address not a 0x address of 40 hex characters`);
    hopFiles({ groups: JSON.stringify([{ eliminatedAddresses: [wrongChecksum] }]) });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-groups.json')}: holds a 0x value that is not an address`);
  });

  it('fails when a cluster names a wallet Hop did not eliminate, or has no id', () => {
    hopFiles({ clusters: [`${A},hopc0001,1`] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminated-cluster-map.csv')}, line 2: address is not on the eliminated list`);
    hopFiles({ clusters: [`${C},,1`] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminated-cluster-map.csv')}, line 2: cluster_id is blank`);
  });

  it('refuses files that would quietly empty a list', () => {
    hopFiles({ groups: 'not json' });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-groups.json')}: not valid JSON`);
    hopFiles({ groups: '[{"notes":""}]' });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-groups.json')}: names no addresses`);
    hopFiles({ eliminated: [], clusters: [] });
    expect(() => loadHopLists(dir)).toThrow(`${path.join(dir, 'hop-eliminatedSybilAttackers.csv')}: no addresses`);
  });

  it('refuses a file past the size cap before reading it', () => {
    hopFiles();
    const file = path.join(dir, 'hop-groups.json');
    fs.truncateSync(file, 65 * 1024 * 1024);
    expect(() => loadHopLists(dir)).toThrow(`${file}: larger than`);
  });

  it.skipIf(!fs.existsSync(REAL_KEYS))(
    'pins the four counts on the real files',
    () => {
      const lists = loadHopLists(REAL_KEYS);
      expect(lists.eligible.length).toBe(28_857);
      expect(lists.eliminated.length).toBe(14_195);
      expect(lists.negatives.size).toBe(21_174);
      expect(lists.keptInGroups.size).toBe(7_683);
      expect(lists.clusters.size).toBe(14_195);
    },
    30_000,
  );
});
