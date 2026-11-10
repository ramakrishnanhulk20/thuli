import { isIP } from 'node:net';

/** Paid requests one client may have in flight at once, from taking a place to the reply. */
export const CLIENT_MAX_RUNNING = 1;
/** Requests to the paid route one client may make in any 60 seconds, paid or not. */
export const CLIENT_MAX_PER_MINUTE = 20;
/** Paid requests one client may make in any hour that end without a settled payment. */
export const CLIENT_MAX_FAILED_PER_HOUR = 5;
/**
 * Clients remembered at once (C41). A new client past this makes room by forgetting the least recently seen client with
 * nothing running. Only when every tracked client has a request in flight is a new one refused as busy.
 */
export const MAX_CLIENTS_TRACKED = 100_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type Limit = 'running' | 'minute' | 'failed' | 'clients';

/** One admitted request. Set paymentFailed before it leaves when it was a paid attempt that did not settle. */
export interface Pass {
  readonly client: string;
  readonly paying: boolean;
  paymentFailed: boolean;
}

interface Client {
  running: number;
  requests: number[];
  failed: number[];
  lastSeen: number;
  passes: WeakSet<Pass>;
}

function dropBefore(times: number[], cutoff: number): void {
  while (times.length > 0 && (times[0] as number) <= cutoff) times.shift();
}

/**
 * Names the client behind an address, in one spelling, so the same caller cannot pass as two by writing its address
 * differently or by moving inside its own network block. An IPv4 address is itself. An IPv4 address carried inside IPv6
 * goes back to plain IPv4. Any other IPv6 address becomes its /64 network, the block one home line or one cloud machine
 * is normally given, read through the URL parser's canonical form. Returns null for anything that is not an IP address.
 *
 * It does not group IPv4 by network, and it does not stop a caller who controls more than one /64.
 */
export function canonicalClient(value: string | undefined): string | null {
  const text = value?.trim();
  if (text === undefined || text === '') return null;
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return null;
  let canonical: string;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] as string, 16);
    const low = Number.parseInt(mapped[2] as string, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  // The URL parser writes eight hex groups with at most one run of zero groups shortened to "::".
  const [head = '', tail] = canonical.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Per-client limits on the paid route (threat model C24, C42), checked before a request can take one of the global
 * places, so one client cannot fill them. The client is whatever the caller of enter() names: in the app, the socket
 * address or the platform's trusted header, never a header the client writes itself.
 *
 * Memory only, in this process. Each client keeps at most 20 request times and 5 failure times, and a client idle for an
 * hour with nothing running is forgotten, oldest first, as new requests arrive. When the table is full, the least
 * recently seen idle client is forgotten early, so a flood of addresses can never shut out a new caller. The price: a
 * caller cycling more than 100,000 addresses within the hour starts the oldest of them fresh, which fresh addresses would
 * give it anyway.
 */
export class ClientLimits {
  readonly #clients = new Map<string, Client>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /**
   * Counts one request to the paid route. paying means it carries a payment header, which also needs a running slot.
   * Returns the pass to hand back to leave(), or the limit the client is past. A refused request is not counted, so a
   * client that keeps knocking is let in again as soon as its oldest counted request ages out.
   */
  enter(client: string, paying: boolean): Pass | { refused: Limit } {
    const now = this.#now().getTime();
    this.#forgetIdle(now);
    let state = this.#clients.get(client);
    if (state === undefined) {
      if (this.#clients.size >= MAX_CLIENTS_TRACKED && !this.#forgetLeastRecentIdle()) return { refused: 'clients' };
      state = { running: 0, requests: [], failed: [], lastSeen: now, passes: new WeakSet() };
    }
    dropBefore(state.requests, now - MINUTE_MS);
    dropBefore(state.failed, now - HOUR_MS);
    this.#touch(client, state, now);
    if (state.failed.length >= CLIENT_MAX_FAILED_PER_HOUR) return { refused: 'failed' };
    if (state.requests.length >= CLIENT_MAX_PER_MINUTE) return { refused: 'minute' };
    if (paying && state.running >= CLIENT_MAX_RUNNING) return { refused: 'running' };
    state.requests.push(now);
    if (paying) state.running += 1;
    const pass: Pass = { client, paying, paymentFailed: false };
    state.passes.add(pass);
    return pass;
  }

  /** Ends an admitted request. A pass is honoured once; a second call, or a pass this instance did not issue, does nothing. */
  leave(pass: Pass): void {
    const state = this.#clients.get(pass.client);
    if (state === undefined || !state.passes.delete(pass)) return;
    const now = this.#now().getTime();
    if (pass.paying) state.running -= 1;
    if (pass.paying && pass.paymentFailed) state.failed.push(now);
    this.#touch(pass.client, state, now);
  }

  get size(): number {
    return this.#clients.size;
  }

  // Re-inserting keeps the map ordered by last activity, so the idle ones are always at the front.
  #touch(client: string, state: Client, now: number): void {
    state.lastSeen = now;
    this.#clients.delete(client);
    this.#clients.set(client, state);
  }

  #forgetIdle(now: number): void {
    for (const [client, state] of this.#clients) {
      if (now - state.lastSeen < HOUR_MS) return;
      if (state.running === 0) this.#clients.delete(client);
    }
  }

  // Skips only clients with a request in flight, each of which costs its caller an open connection.
  #forgetLeastRecentIdle(): boolean {
    for (const [client, state] of this.#clients) {
      if (state.running === 0) {
        this.#clients.delete(client);
        return true;
      }
    }
    return false;
  }
}
