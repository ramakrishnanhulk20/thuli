import { randomUUID } from 'node:crypto';
import { parseAddress, type Address } from '@thuli/core';
import {
  bumpDay,
  claimPayment,
  countRecent,
  dayCount,
  dropLease,
  keepPaymentUnsure,
  namedPaymentTxs,
  leaveSettledPayment,
  liveLeases,
  markPaymentSettled,
  readCheck,
  recordEvent,
  recordIfUnder,
  redeemPayment,
  releasePayment,
  servePayment,
  sweep,
  takeLease,
  writeCheck,
  type CheckKey,
  type Db,
} from '@thuli/store';
import { CLOCK_ALLOWANCE_SECONDS, MAX_TIMEOUT_SECONDS, PaymentClaims, type ClaimResult, type Redeemed, type Settlement } from './claims.ts';
import { MAX_PER_DAY, MAX_RUNNING, ScreenGuard, type Ticket } from './guard.ts';
import {
  CLIENT_MAX_FAILED_PER_HOUR,
  CLIENT_MAX_PER_MINUTE,
  CLIENT_MAX_RUNNING,
  ClientLimits,
  HOUR_MS,
  MAX_CLIENTS_TRACKED,
  MINUTE_MS,
  type Limit,
  type Pass,
} from './limits.ts';

/** New free checks one caller may start in any hour. A cached answer starts nothing and counts toward none of these. */
export const CHECK_CLIENT_MAX_PER_HOUR = 5;
/** Free check screenings one caller may have running at once. */
export const CHECK_CLIENT_MAX_RUNNING = 1;
/** Free check screenings running at once on the whole service. */
export const CHECK_MAX_RUNNING = 2;
/** Free check screenings started on the whole service in one UTC day. */
export const CHECK_MAX_PER_DAY = 300;
/** Cached free checks this process remembers at once (C41). The shared cache is bounded by sweep instead. */
export const MAX_CHECKS_CACHED = 10_000;

/**
 * Which payment authorizations are being settled, went through or bought a result (C25), by PaymentClaims' rules. A
 * request that takes a settled claim owns it for LEASE_SECONDS, so one that dies frees it by itself. Any call may reject
 * when the store fails.
 */
export interface ClaimStore {
  /** Takes key for owner, one request's random id. The answers are PaymentClaims.claim's. */
  claim(key: string, validBefore: bigint, owner: string, nowSeconds: bigint): Promise<ClaimResult>;
  /** A payment of key that already went through, redeemed for wallet by owner. The answers are PaymentClaims.redeem's. */
  redeem(key: string, wallet: Address, owner: string, nowSeconds: bigint): Promise<Redeemed>;
  /** The settlement went through: settled at nowSeconds for settlement, owned by owner. Does nothing unless owner holds key. */
  markSettled(key: string, owner: string, settlement: Settlement, nowSeconds: bigint): Promise<void>;
  /**
   * The outcome is unknown: one retry of the same authorization at a time may take it. transactions are the hashes a
   * facilitator named for the payment in this request, kept with the claim. Does nothing unless owner holds key.
   */
  keepUnsure(key: string, owner: string, transactions: readonly string[]): Promise<void>;
  /** The transactions earlier requests kept with the claim, oldest first. Empty unless owner holds key. */
  named(key: string, owner: string): Promise<string[]>;
  /** The settlement failed outright, so an honest retry may try again. Does nothing unless owner holds key. */
  release(key: string, owner: string): Promise<void>;
  /** Stores the result the payment bought, for every later redeem. Does nothing unless owner owns the settled key. */
  serve(key: string, owner: string, body: unknown): Promise<void>;
  /**
   * The screening ended with no result: the next copy of the header may take it. handBackTry gives back the try this
   * owner's taking counted, for an owner that never started that screening. Does nothing unless owner owns it.
   */
  leave(key: string, owner: string, handBackTry: boolean): Promise<void>;
}

/** The ceilings on paid screenings across the whole service (C24, C42), by ScreenGuard's rules. Any call may reject when the store fails. */
export interface GuardStore {
  /** True when one more paid request could break a ceiling, so the route answers busy before asking for payment. */
  busy(): Promise<boolean>;
  /** Takes a place for a paid request, or answers null when busy. Pair every ticket with leave(). */
  enter(): Promise<Ticket | null>;
  /** The screening for ticket begins, counted once toward today. It never refuses, because the request has paid. */
  start(ticket: Ticket): Promise<void>;
  /** Gives the place back. A second call for one ticket does nothing on the shared store. */
  leave(ticket: Ticket): Promise<void>;
}

/** Per-client limits on the paid route (C24, C42), by ClientLimits' rules. Any call may reject when the store fails. */
export interface LimitStore {
  /** Counts one request for client. Returns the pass for leave(), or the limit client is past. A refusal counts nothing. */
  enter(client: string, paying: boolean): Promise<Pass | { refused: Limit }>;
  /** Ends an admitted request, once per pass. Set pass.paymentFailed first for a paid attempt that did not settle. */
  leave(pass: Pass): Promise<void>;
}

/** Finished free checks, by canonical address, chain and rulebook version (C24). Any call may reject when the store fails. */
export interface CheckStore {
  /** The body kept for key while it has not expired at now, or null. Every spelling of one address reads one entry. */
  read(key: CheckKey, now: Date): Promise<unknown | null>;
  /** Keeps body for key until now plus ttlSeconds, replacing any earlier one. body must be a JSON value other than null. */
  write(key: CheckKey, body: unknown, now: Date, ttlSeconds: number): Promise<void>;
}

/** A place the free check holds: one wallet's screening, or one admitted screening's caller and service places. */
export interface CheckPlace {
  readonly holds: 'wallet' | 'screening';
}

/** hour and running are the caller's own ceilings; service and day are the whole service's. */
export type CheckRefusal = 'hour' | 'running' | 'service' | 'day';

/** The free check's ceilings on model spend (C24, C42). Any call may reject when the store fails. */
export interface CheckLimitStore {
  /** Counts one request for client toward CLIENT_MAX_PER_MINUTE, in a bucket of its own. False, counting nothing, when past it. */
  countRequest(client: string): Promise<boolean>;
  /** Takes the one screening place for wallet, or null while another request is screening it. */
  holdWallet(wallet: Address): Promise<CheckPlace | null>;
  /**
   * Admits one new screening for client: its hour and running ceilings, then the service's running and day ceilings.
   * Only an admitted screening counts toward the hour and the day; a refusal counts nothing and holds nothing.
   */
  admit(client: string): Promise<CheckPlace | { refused: CheckRefusal }>;
  /** Gives a place back. A second call for one place does nothing. */
  release(place: CheckPlace): Promise<void>;
}

export interface Stores {
  claims: ClaimStore;
  guard: GuardStore;
  limits: LimitStore;
  checks: CheckStore;
  checkLimits: CheckLimitStore;
  /** Deletes what no claim, limit or cached check can need again (C41). */
  sweep(): Promise<void>;
}

export function claimStoreOver(claims: PaymentClaims): ClaimStore {
  return {
    claim: async (key, validBefore, owner, nowSeconds) => claims.claim(key, validBefore, owner, nowSeconds),
    redeem: async (key, wallet, owner, nowSeconds) => claims.redeem(key, wallet, owner, nowSeconds, nowSeconds + BigInt(LEASE_SECONDS)),
    markSettled: async (key, owner, settlement, nowSeconds) =>
      claims.markSettled(key, owner, settlement, nowSeconds, nowSeconds + BigInt(LEASE_SECONDS)),
    keepUnsure: async (key, owner, transactions) => claims.keepUnsure(key, owner, transactions),
    named: async (key, owner) => claims.named(key, owner),
    release: async (key, owner) => claims.release(key, owner),
    serve: async (key, owner, body) => claims.serve(key, owner, body),
    leave: async (key, owner, handBackTry) => claims.leave(key, owner, handBackTry),
  };
}

export function guardStoreOver(guard: ScreenGuard): GuardStore {
  return {
    busy: async () => guard.busy(),
    // Checked and taken with no await between, so two requests can never both take the last place.
    enter: async () => (guard.busy() ? null : guard.enter()),
    start: async (ticket) => guard.start(ticket),
    leave: async (ticket) => guard.leave(ticket),
  };
}

export function limitStoreOver(limits: ClientLimits): LimitStore {
  return {
    enter: async (client, paying) => limits.enter(client, paying),
    leave: async (pass) => limits.leave(pass),
  };
}

/**
 * The stores in this process's memory: the paid route's three classes with exactly their rules, and the free check's
 * cache and ceilings by the same rules as the shared version. Right for one long-running server and for tests. On a
 * host that runs many short-lived copies each copy would get its own allowance and its own memory of payments, so use
 * postgresStores there. sweep does nothing, because every part bounds itself.
 */
export function memoryStores(now: () => Date): Stores {
  return {
    claims: claimStoreOver(new PaymentClaims(BigInt(MAX_TIMEOUT_SECONDS))),
    guard: guardStoreOver(new ScreenGuard(now)),
    limits: limitStoreOver(new ClientLimits(now)),
    checks: memoryChecks(),
    checkLimits: checkLimitsOver(new MemoryCounters(), now),
    sweep: async () => undefined,
  };
}

/**
 * How long a place, or a settled payment a request is screening, is held for a copy that never gives it back, so a copy
 * that dies mid-request frees them by themselves. It must outlast the request that took it, or that request loses its
 * place while it still runs and a ceiling can be passed by one. A paid request ends by REQUEST_DEADLINE_MS, 240 s after
 * its first line, and takes every place after that line, so 330 s leaves at least 90 s of margin: for two copies whose
 * clocks disagree, and for a store call already sent when the deadline came. A free check, a 120 s screening and its
 * store calls, ends well inside it too.
 */
export const LEASE_SECONDS = 330;
/** The day's count at which the shared guard refuses new paid requests: MAX_RUNNING short of MAX_PER_DAY. */
export const SHARED_DAY_ROOM = MAX_PER_DAY - MAX_RUNNING;

const RUNNING_POOL = 'paid-running';
const SCREENINGS_DAY = 'paid-screenings';
const MINUTE_BUCKET = 'minute';
const FAILED_BUCKET = 'failed';
const MINUTE_SECONDS = MINUTE_MS / 1000;
const HOUR_SECONDS = HOUR_MS / 1000;

function postgresClaims(db: Db): ClaimStore {
  // The same bound PaymentClaims builds from the route's timeout.
  const latestSeconds = BigInt(MAX_TIMEOUT_SECONDS) + CLOCK_ALLOWANCE_SECONDS;
  const owned = (nowSeconds: bigint) => ({ nowSeconds, ownedUntil: nowSeconds + BigInt(LEASE_SECONDS) });
  return {
    claim: (key, validBefore, owner, nowSeconds) => claimPayment(db, key, validBefore, owner, { nowSeconds, latestSeconds }),
    redeem: (key, wallet, owner, nowSeconds) => redeemPayment(db, key, wallet, owner, owned(nowSeconds)),
    markSettled: (key, owner, settlement, nowSeconds) => markPaymentSettled(db, key, owner, settlement, owned(nowSeconds)),
    keepUnsure: (key, owner, transactions) => keepPaymentUnsure(db, key, owner, transactions),
    named: (key, owner) => namedPaymentTxs(db, key, owner),
    release: (key, owner) => releasePayment(db, key, owner),
    serve: (key, owner, body) => servePayment(db, key, owner, body),
    leave: (key, owner, handBackTry) => leaveSettledPayment(db, key, owner, handBackTry),
  };
}

function postgresGuard(db: Db, now: () => Date): GuardStore {
  const leases = new WeakMap<Ticket, string>();
  const dayFull = async (at: Date) => (await dayCount(db, SCREENINGS_DAY, at)) >= SHARED_DAY_ROOM;
  return {
    async busy() {
      const at = now();
      return (await liveLeases(db, RUNNING_POOL, at)) >= MAX_RUNNING || (await dayFull(at));
    },
    async enter() {
      const at = now();
      if (await dayFull(at)) return null;
      const lease = await takeLease(db, RUNNING_POOL, MAX_RUNNING, LEASE_SECONDS, at);
      if (lease === null) return null;
      const ticket: Ticket = { started: false };
      leases.set(ticket, lease);
      return ticket;
    },
    async start(ticket) {
      if (ticket.started) return;
      ticket.started = true;
      // bumpDay answers false only once the day is at MAX_PER_DAY, which the headroom keeps out of reach while every
      // lease outlives its request. The request has paid either way, so the screening runs.
      await bumpDay(db, SCREENINGS_DAY, MAX_PER_DAY, now());
    },
    async leave(ticket) {
      const lease = leases.get(ticket);
      if (lease === undefined) return;
      leases.delete(ticket);
      await dropLease(db, lease);
    },
  };
}

function postgresLimits(db: Db, now: () => Date): LimitStore {
  // A paying pass maps to its client lease, an unpaid one to null. Deleting the entry is what honours a pass once.
  const leases = new WeakMap<Pass, string | null>();
  return {
    async enter(client, paying) {
      const at = now();
      if ((await countRecent(db, FAILED_BUCKET, client, HOUR_SECONDS, at)) >= CLIENT_MAX_FAILED_PER_HOUR) return { refused: 'failed' };
      if ((await countRecent(db, MINUTE_BUCKET, client, MINUTE_SECONDS, at)) >= CLIENT_MAX_PER_MINUTE) return { refused: 'minute' };
      const lease = paying ? await takeLease(db, `client:${client}`, CLIENT_MAX_RUNNING, LEASE_SECONDS, at) : null;
      if (paying && lease === null) return { refused: 'running' };
      // The minute is read above so the refusals come in ClientLimits' order; this counted write is what holds the
      // ceiling when two copies see the same client at once. A request refused here gives its place straight back.
      let counted = false;
      try {
        counted = await recordIfUnder(db, MINUTE_BUCKET, client, CLIENT_MAX_PER_MINUTE, MINUTE_SECONDS, at);
      } finally {
        if (!counted && lease !== null) await dropLease(db, lease);
      }
      if (!counted) return { refused: 'minute' };
      const pass: Pass = { client, paying, paymentFailed: false };
      leases.set(pass, lease);
      return pass;
    },
    async leave(pass) {
      if (!leases.has(pass)) return;
      const lease = leases.get(pass) ?? null;
      leases.delete(pass);
      // The failure is written before the place goes back, so the client's next paid attempt already sees it. When that
      // write fails the place is kept until it expires, so an uncounted failure still costs the client its place.
      if (pass.paying && pass.paymentFailed) await recordEvent(db, FAILED_BUCKET, pass.client, now());
      if (lease !== null) await dropLease(db, lease);
    },
  };
}

const CHECK_MINUTE_BUCKET = 'check-minute';
const CHECK_HOUR_BUCKET = 'check-hour';
const CHECK_RUNNING_POOL = 'check-running';
const CHECK_SCREENINGS_DAY = 'check-screenings';

/** The store's lease, event and day calls the free check is built from, so both backends run one set of rules. */
interface Counters {
  takeLease(pool: string, max: number, ttlSeconds: number, now: Date): Promise<string | null>;
  dropLease(id: string): Promise<void>;
  recordIfUnder(bucket: string, client: string, max: number, windowSeconds: number, now: Date): Promise<boolean>;
  countRecent(bucket: string, client: string, windowSeconds: number, now: Date): Promise<number>;
  bumpDay(name: string, max: number, now: Date): Promise<boolean>;
}

function postgresCounters(db: Db): Counters {
  return {
    takeLease: (pool, max, ttlSeconds, now) => takeLease(db, pool, max, ttlSeconds, now),
    dropLease: (id) => dropLease(db, id),
    recordIfUnder: (bucket, client, max, windowSeconds, now) => recordIfUnder(db, bucket, client, max, windowSeconds, now),
    countRecent: (bucket, client, windowSeconds, now) => countRecent(db, bucket, client, windowSeconds, now),
    bumpDay: (name, max, now) => bumpDay(db, name, max, now),
  };
}

/**
 * The same calls in this process's memory, by the store's rules: a lease is live until the moment it expires, and an
 * event stops counting exactly windowSeconds after it happened. Each bucket remembers at most MAX_CLIENTS_TRACKED
 * clients. Past that, the client whose newest event is oldest goes first: one with nothing left in its window if there
 * is one, else the least recently counted, whose count then starts fresh, as a fresh address would give it anyway.
 */
class MemoryCounters implements Counters {
  readonly #leases = new Map<string, { pool: string; expiresAt: number }>();
  readonly #pools = new Map<string, Set<string>>();
  // Per bucket, clients in the order they last recorded, so the front is always the stalest.
  readonly #events = new Map<string, Map<string, number[]>>();
  readonly #days = new Map<string, { day: string; count: number }>();

  async takeLease(pool: string, max: number, ttlSeconds: number, now: Date): Promise<string | null> {
    const at = now.getTime();
    const ids = this.#pools.get(pool) ?? new Set<string>();
    for (const id of ids) {
      if ((this.#leases.get(id)?.expiresAt ?? 0) <= at) {
        ids.delete(id);
        this.#leases.delete(id);
      }
    }
    if (ids.size >= max) {
      if (ids.size === 0) this.#pools.delete(pool);
      return null;
    }
    const id = randomUUID();
    ids.add(id);
    this.#pools.set(pool, ids);
    this.#leases.set(id, { pool, expiresAt: at + ttlSeconds * 1000 });
    return id;
  }

  async dropLease(id: string): Promise<void> {
    const lease = this.#leases.get(id);
    if (lease === undefined) return;
    this.#leases.delete(id);
    const ids = this.#pools.get(lease.pool);
    ids?.delete(id);
    if (ids?.size === 0) this.#pools.delete(lease.pool);
  }

  async recordIfUnder(bucket: string, client: string, max: number, windowSeconds: number, now: Date): Promise<boolean> {
    const at = now.getTime();
    const times = this.#recent(bucket, client, windowSeconds, at);
    if (times.length >= max) return false;
    const clients = this.#bucket(bucket);
    clients.delete(client);
    if (clients.size >= MAX_CLIENTS_TRACKED) this.#forgetStalest(clients, at - windowSeconds * 1000);
    clients.set(client, [...times, at]);
    return true;
  }

  async countRecent(bucket: string, client: string, windowSeconds: number, now: Date): Promise<number> {
    return this.#recent(bucket, client, windowSeconds, now.getTime()).length;
  }

  async bumpDay(name: string, max: number, now: Date): Promise<boolean> {
    const day = now.toISOString().slice(0, 10);
    const current = this.#days.get(name);
    const count = current?.day === day ? current.count : 0;
    if (count >= max) return false;
    this.#days.set(name, { day, count: count + 1 });
    return true;
  }

  #bucket(bucket: string): Map<string, number[]> {
    let clients = this.#events.get(bucket);
    if (clients === undefined) {
      clients = new Map();
      this.#events.set(bucket, clients);
    }
    return clients;
  }

  #recent(bucket: string, client: string, windowSeconds: number, at: number): number[] {
    const cutoff = at - windowSeconds * 1000;
    return (this.#events.get(bucket)?.get(client) ?? []).filter((time) => time > cutoff);
  }

  #forgetStalest(clients: Map<string, number[]>, cutoff: number): void {
    for (const [client, times] of clients) {
      if (clients.size < MAX_CLIENTS_TRACKED) return;
      if (times.every((time) => time <= cutoff)) clients.delete(client);
      else break;
    }
    if (clients.size >= MAX_CLIENTS_TRACKED) {
      const [stalest] = clients.keys();
      if (stalest !== undefined) clients.delete(stalest);
    }
  }
}

/**
 * The free check's ceilings over either backend's counters. The caller's own place is taken before the hour is
 * written, so no second check of theirs can count between reading the hour and writing it. The day is bumped before
 * the hour is written, so a full day costs the caller nothing.
 */
function checkLimitsOver(counters: Counters, now: () => Date): CheckLimitStore {
  const leases = new WeakMap<CheckPlace, string[]>();
  const place = (holds: CheckPlace['holds'], ids: string[]): CheckPlace => {
    const held: CheckPlace = { holds };
    leases.set(held, ids);
    return held;
  };
  return {
    countRequest: (client) => counters.recordIfUnder(CHECK_MINUTE_BUCKET, client, CLIENT_MAX_PER_MINUTE, MINUTE_SECONDS, now()),
    async holdWallet(wallet) {
      const lease = await counters.takeLease(`check-wallet:${wallet}`, 1, LEASE_SECONDS, now());
      return lease === null ? null : place('wallet', [lease]);
    },
    async admit(client) {
      const at = now();
      if ((await counters.countRecent(CHECK_HOUR_BUCKET, client, HOUR_SECONDS, at)) >= CHECK_CLIENT_MAX_PER_HOUR) return { refused: 'hour' };
      const taken: string[] = [];
      let admitted = false;
      try {
        const own = await counters.takeLease(`check-client:${client}`, CHECK_CLIENT_MAX_RUNNING, LEASE_SECONDS, at);
        if (own === null) return { refused: 'running' };
        taken.push(own);
        const service = await counters.takeLease(CHECK_RUNNING_POOL, CHECK_MAX_RUNNING, LEASE_SECONDS, at);
        if (service === null) return { refused: 'service' };
        taken.push(service);
        if (!(await counters.bumpDay(CHECK_SCREENINGS_DAY, CHECK_MAX_PER_DAY, at))) return { refused: 'day' };
        if (!(await counters.recordIfUnder(CHECK_HOUR_BUCKET, client, CHECK_CLIENT_MAX_PER_HOUR, HOUR_SECONDS, at))) {
          return { refused: 'hour' };
        }
        admitted = true;
        return place('screening', taken);
      } finally {
        if (!admitted) for (const id of taken) await counters.dropLease(id);
      }
    },
    async release(held) {
      const ids = leases.get(held);
      if (ids === undefined) return;
      leases.delete(held);
      for (const id of ids) await counters.dropLease(id);
    },
  };
}

// The rules writeCheck applies to a key and a body, so the memory cache refuses what the shared one refuses.
function cacheKeyOf(key: CheckKey): string {
  for (const part of [key.chain, key.rulebook]) {
    if (!Number.isSafeInteger(part) || part < 1) throw new RangeError('chain and rulebook must be whole numbers from 1');
  }
  return `${parseAddress(key.address)}|${key.chain}|${key.rulebook}`;
}

/**
 * Finished checks in this process's memory, at most MAX_CHECKS_CACHED (C41). A write into a full cache first forgets
 * every expired entry, oldest first, and only if none had expired forgets the oldest entry still live. Bodies are
 * kept as JSON, as the shared cache keeps them.
 */
function memoryChecks(): CheckStore {
  const entries = new Map<string, { json: string; expiresAt: number }>();
  return {
    async read(key, now) {
      const id = cacheKeyOf(key);
      const entry = entries.get(id);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now.getTime()) {
        entries.delete(id);
        return null;
      }
      return JSON.parse(entry.json) as unknown;
    },
    async write(key, body, now, ttlSeconds) {
      const id = cacheKeyOf(key);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new RangeError('ttlSeconds must be a whole number from 1');
      const json = body === null ? undefined : JSON.stringify(body);
      if (json === undefined) throw new TypeError('the check body must be a JSON value other than null');
      const at = now.getTime();
      entries.delete(id);
      if (entries.size >= MAX_CHECKS_CACHED) {
        for (const [other, entry] of entries) if (entry.expiresAt <= at) entries.delete(other);
      }
      if (entries.size >= MAX_CHECKS_CACHED) {
        const [oldest] = entries.keys();
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(id, { json, expiresAt: at + ttlSeconds * 1000 });
    },
  };
}

function postgresChecks(db: Db): CheckStore {
  return {
    read: (key, now) => readCheck(db, key, now),
    write: (key, body, now, ttlSeconds) => writeCheck(db, key, body, now, ttlSeconds),
  };
}

/**
 * The same three stores on Postgres through @thuli/store, shared by every copy of the server, with the classes' rules
 * and constants. Each ceiling is decided inside one store transaction or statement, so copies that see the same
 * request at once still get one answer between them. Where it differs, on purpose:
 * - The day ceiling keeps MAX_RUNNING of headroom instead of counting requests in flight: a paid request is refused as
 *   busy once the day's count reaches MAX_PER_DAY minus MAX_RUNNING. So a request that entered can always start, the
 *   day's count can never pass MAX_PER_DAY, and a paid request is never refused for the day after it paid. The shared
 *   version stops up to MAX_RUNNING screenings short of the in-memory one.
 * - A place is a lease that lives LEASE_SECONDS, so a copy that dies mid-request frees it by itself.
 * - Nothing caps the clients tracked or forgets an idle one, so a new caller is never refused for 'clients'. The tables
 *   are bounded by sweep instead, which deletes the rows no rule can need again, expired cached checks included.
 * The free check's cache and ceilings run the same rules on both backends, over the store's own calls here.
 * Every call rejects with the store's error when the database fails; the route decides what that means.
 */
export function postgresStores(db: Db, now: () => Date): Stores {
  return {
    claims: postgresClaims(db),
    guard: postgresGuard(db, now),
    limits: postgresLimits(db, now),
    checks: postgresChecks(db),
    checkLimits: checkLimitsOver(postgresCounters(db), now),
    sweep: async () => {
      await sweep(db, now());
    },
  };
}

// An error code as a driver or Postgres writes one, such as ECONNREFUSED or 57P01: nothing that can hold a value.
const ERROR_CODE = /^[0-9A-Z_]{2,40}$/;

/**
 * A failure as it may be logged: the error's class and, when it carries one, its code. Never its message, which can
 * quote a query value or the database host (C40).
 */
export function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const own = (error as { code?: unknown }).code;
  // The store keeps a Postgres code at the end of its message in brackets, and drops the rest of what the driver had.
  const code = typeof own === 'string' ? own : /\(([^()]*)\)$/.exec(error.message)?.[1];
  return code !== undefined && ERROR_CODE.test(code) ? `${error.name} (${code})` : error.name;
}
