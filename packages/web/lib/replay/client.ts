import { useEffect, useState } from 'react';
import type { Cluster } from '../../components/hero/heroLayout';
import { isReplayAddress } from '../explorer';
import type { GroupFile, Loaded, WalletDetail, WalletShard } from './replayTypes';
import type { WebPoints } from './types';

const REPLAY_ROOT = '/replay/robo';
const SHARD_COUNT = 256;
const RANDOM_TRIES = 4;

// Files are kept for the whole visit. A failed request is dropped from the cache so Try again asks the server again.
const cache = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadFile<T>(path: string, hasShape: (file: Record<string, unknown>) => boolean): Promise<T> {
  const kept = cache.get(path);
  if (kept !== undefined) return kept as Promise<T>;
  const request = fetch(`${REPLAY_ROOT}/${path}`).then(async (response) => {
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    const file: unknown = await response.json();
    if (!isRecord(file) || file.schema !== 1 || !hasShape(file)) throw new Error(`${path} is not a replay file`);
    return file as T;
  });
  cache.set(path, request);
  request.catch(() => {
    if (cache.get(path) === request) cache.delete(path);
  });
  return request;
}

export function loadPoints(): Promise<WebPoints> {
  return loadFile<WebPoints>('points.json', (file) => Array.isArray(file.outcome) && Array.isArray(file.group) && typeof file.count === 'number');
}

export function loadGroup(index: number): Promise<GroupFile> {
  return loadFile<GroupFile>(`groups/${index}.json`, (file) => Array.isArray(file.members));
}

/** The wallet file a lowercase address lives in is named by the two hex characters after 0x. */
export function shardName(address: string): string {
  return address.slice(2, 4);
}

export function loadShard(name: string): Promise<WalletShard> {
  return loadFile<WalletShard>(`wallets/${name}.json`, (file) => isRecord(file.wallets));
}

/** The wallet's entry, or null when its file holds no such wallet. */
export async function loadWallet(address: string): Promise<WalletDetail | null> {
  if (!isReplayAddress(address)) return null;
  const shard = await loadShard(shardName(address));
  return Object.hasOwn(shard.wallets, address) ? (shard.wallets[address] as WalletDetail) : null;
}

/** Picks a random file name from 00 to ff, loads it, and returns a random wallet from it. */
export async function loadRandomWalletAddress(random: () => number = Math.random): Promise<string> {
  for (let attempt = 0; attempt < RANDOM_TRIES; attempt += 1) {
    const name = Math.floor(random() * SHARD_COUNT).toString(16).padStart(2, '0');
    const addresses = Object.keys((await loadShard(name)).wallets);
    const pick = addresses[Math.floor(random() * addresses.length)];
    if (pick !== undefined) return pick;
  }
  throw new Error('no wallet found in the files tried');
}

/**
 * One cluster per linked family: cluster members are every wallet index whose group is that family, in file order.
 * Sorted largest first, ties by the first wallet, the order placeClusters expects. groupIndex keeps the way back to
 * summary.groups after the sort.
 */
export function familyClusters(points: WebPoints): Cluster[] {
  const byGroup = new Map<number, Cluster>();
  for (let i = 0; i < points.count; i += 1) {
    const group = points.group[i] ?? -1;
    if (group < 0) continue;
    let cluster = byGroup.get(group);
    if (cluster === undefined) {
      cluster = { groupIndex: group, members: [] };
      byGroup.set(group, cluster);
    }
    cluster.members.push(i);
  }
  return [...byGroup.values()].sort((a, b) => b.members.length - a.members.length || (a.members[0] as number) - (b.members[0] as number));
}

/**
 * Runs load when the key changes and reports idle (no key), loading, ready or error. retry asks again after an error.
 * A result that arrives after the key has moved on is dropped.
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>): { state: Loaded<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; attempt: number; result: { value: T } | null } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    load().then(
      (value) => {
        if (live) setSettled({ key, attempt, result: { value } });
      },
      () => {
        if (live) setSettled({ key, attempt, result: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  let state: Loaded<T>;
  if (key === null) state = { status: 'idle' };
  else if (settled === null || settled.key !== key || settled.attempt !== attempt) state = { status: 'loading' };
  else if (settled.result === null) state = { status: 'error' };
  else state = { status: 'ready', value: settled.result.value };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
