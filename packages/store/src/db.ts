import pg from 'pg';
import type { PGlite, Transaction } from '@electric-sql/pglite';

/** Every failure this package raises. Its message never holds the database URL or its password (threat model C40). */
export class StoreError extends Error {
  override name = 'StoreError';
}

export interface Queryable {
  query<Row extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction: commit when it resolves, roll back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A transaction that can also run a file of several statements. Only migrate needs it. */
export interface ScriptTransaction extends Queryable {
  script(text: string): Promise<void>;
}

/** One connection kept for a whole run, so a session-level lock taken on it holds until the run ends. */
export interface Session extends Queryable {
  transaction<T>(fn: (tx: ScriptTransaction) => Promise<T>): Promise<T>;
}

type OpenSession = <T>(fn: (session: Session) => Promise<T>) => Promise<T>;

const sessions = new WeakMap<Db, OpenSession>();

const STATEMENT_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_POOL_MAX = 3;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// The advisory lock namespaces written into each module's SQL as the first of the two keys, kept apart so two kinds of
// decision never wait on each other by chance: 1000 migrations, 1001 one payment claim key, 1002 the payment claim
// cap, 1003 one lease pool, 1004 one rate bucket and client, 1005 one campaign.

/**
 * The caller's moment as an ISO instant, the only way time reaches a query, so two callers that pass the same moment
 * get the same answer. Kept out of the public surface, like the two below.
 * @throws StoreError when now is not a valid Date.
 */
export function instant(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new StoreError('now must be a valid Date');
  return now.toISOString();
}

/** @throws StoreError when now is not a valid Date or the result is outside the dates a Date can hold. */
export function shifted(now: Date, seconds: number): string {
  instant(now);
  return instant(new Date(now.getTime() + seconds * 1000));
}

/** @throws StoreError when value is not a whole number from least to most. */
export function wholeNumber(value: number, label: string, least: number, most: number): number {
  if (!Number.isSafeInteger(value) || value < least || value > most) {
    throw new StoreError(`${label} must be a whole number from ${least} to ${most}`);
  }
  return value;
}

/**
 * Runs fn on one connection of db that nothing else borrows meanwhile, then ends that connection's session. Kept out
 * of the package's public surface because only migrate needs it.
 * @throws StoreError when db did not come from connectPostgres or openMemoryDb.
 */
export function withSession<T>(db: Db, fn: (session: Session) => Promise<T>): Promise<T> {
  const open = sessions.get(db);
  if (open === undefined) return Promise.reject(new StoreError('this needs a Db from connectPostgres or openMemoryDb'));
  return open(fn);
}

// Keeps the Postgres error code, which names the kind of refusal, and drops everything else the driver attached: the
// query, its parameters and the connection settings can all hold values that must not reach a log.
function failure(error: unknown, hidden: readonly string[] = []): StoreError {
  if (error instanceof StoreError) return error;
  let message = error instanceof Error && error.message !== '' ? error.message : 'the database call failed';
  for (const secret of hidden) {
    if (secret !== '') message = message.replaceAll(secret, '[hidden]');
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return new StoreError(typeof code === 'string' ? `${message} (${code})` : message);
}

interface Scope {
  ended: boolean;
}

function queryable(scope: Scope | null, run: (text: string, params: unknown[]) => Promise<unknown[]>): Queryable {
  return {
    async query<Row extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      if (scope?.ended === true) throw new StoreError('a transaction was used after it ended');
      const values = params === undefined ? [] : [...params];
      // Both drivers write a lone surrogate as U+FFFD, so two different values would be stored as one (C43).
      if (values.some((value) => typeof value === 'string' && !value.isWellFormed())) {
        throw new StoreError('a text value is not well-formed Unicode');
      }
      return (await run(text, values)) as Row[];
    },
  };
}

interface PostgresUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  local: boolean;
  hidden: string[];
}

// Read here, not by pg, so the driver is handed parts and never the URL itself. The URL parser's own error carries the
// whole input, password included, so it is dropped rather than passed on.
function readPostgresUrl(url: string): PostgresUrl {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//.test(url)) {
    throw new StoreError('the database URL must start with postgres:// or postgresql://');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StoreError('the database URL could not be read');
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') throw new StoreError('the database URL names no host');
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  try {
    return {
      host,
      port,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      local: LOCAL_HOSTS.has(host.toLowerCase()),
      hidden: [url, parsed.password, decodeURIComponent(parsed.password)],
    };
  } catch {
    throw new StoreError('the database URL has a malformed percent escape');
  }
}

type PgRunner = Pick<pg.PoolClient, 'query'>;

async function send(client: PgRunner, text: string, params: unknown[], hidden: readonly string[]): Promise<pg.QueryResult> {
  // The extended protocol takes exactly one statement, so no text can ever carry a second one along with it.
  const config: pg.QueryConfig & { queryMode: 'extended' } = { text, values: params, queryMode: 'extended' };
  try {
    return await client.query(config);
  } catch (error) {
    throw failure(error, hidden);
  }
}

// Returns whether the connection is still fit to reuse. A failed ROLLBACK or COMMIT leaves its state unknown.
async function pgTransaction<T>(
  client: PgRunner,
  hidden: readonly string[],
  fn: (tx: ScriptTransaction) => Promise<T>,
): Promise<{ value: T } | { error: unknown; broken: boolean }> {
  const scope: Scope = { ended: false };
  const tx: ScriptTransaction = {
    ...queryable(scope, async (text, params) => (await send(client, text, params, hidden)).rows),
    async script(text: string): Promise<void> {
      if (scope.ended) throw new StoreError('a transaction was used after it ended');
      try {
        await client.query(text);
      } catch (error) {
        throw failure(error, hidden);
      }
    },
  };
  try {
    await send(client, 'BEGIN', [], hidden);
  } catch (error) {
    return { error, broken: true };
  }
  let value: T;
  try {
    value = await fn(tx);
  } catch (error) {
    scope.ended = true;
    try {
      await send(client, 'ROLLBACK', [], hidden);
      return { error, broken: false };
    } catch {
      return { error, broken: true };
    }
  }
  scope.ended = true;
  let commit: pg.QueryResult;
  try {
    commit = await send(client, 'COMMIT', [], hidden);
  } catch (error) {
    return { error, broken: true };
  }
  // Postgres answers COMMIT on a transaction a failed statement already aborted with ROLLBACK, not with an error.
  if (commit.command === 'ROLLBACK') {
    return { error: new StoreError('the transaction was rolled back because a statement in it failed'), broken: false };
  }
  return { value };
}

/**
 * Opens a pool of connections to a real Postgres. Any host but localhost and 127.0.0.1 is reached only over TLS with
 * a verified certificate, whatever the URL's own sslmode says. Each statement may run 10 seconds and each connect may
 * take 10 seconds before it fails. Connections open lazily, so a wrong password shows on the first query.
 * @param url postgres:// or postgresql://, with the user, password, host, port and database in the URL.
 * @param options.max the most connections held at once, 3 unless given.
 * @throws StoreError when the URL is not a Postgres URL or the pool size is not a whole number of at least 1. No error
 *   this Db throws or logs holds the URL or its password.
 */
export function connectPostgres(url: string, options: { max?: number } = {}): Db {
  const settings = readPostgresUrl(url);
  const max = options.max ?? DEFAULT_POOL_MAX;
  if (!Number.isSafeInteger(max) || max < 1) throw new StoreError('the pool size must be a whole number of at least 1');
  const { hidden } = settings;
  const pool = new pg.Pool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    ssl: settings.local ? false : { rejectUnauthorized: true },
    max,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'thuli',
  });
  // Without a listener, a connection the server drops while idle in the pool crashes the process.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`store: an idle database connection closed (${error.code ?? error.name})`);
  });
  let closed = false;

  async function borrow(): Promise<pg.PoolClient> {
    if (closed) throw new StoreError('the database connection is closed');
    try {
      return await pool.connect();
    } catch (error) {
      throw failure(error, hidden);
    }
  }

  const db: Db = {
    ...queryable(null, async (text, params) => {
      if (closed) throw new StoreError('the database connection is closed');
      return (await send(pool, text, params, hidden)).rows;
    }),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await borrow();
      const outcome = await pgTransaction(client, hidden, (tx) => fn({ query: tx.query }));
      client.release('broken' in outcome && outcome.broken ? true : undefined);
      if ('value' in outcome) return outcome.value;
      throw outcome.error;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };

  sessions.set(db, async (fn) => {
    const client = await borrow();
    try {
      return await fn({
        ...queryable(null, async (text, params) => (await send(client, text, params, hidden)).rows),
        async transaction<U>(inner: (tx: ScriptTransaction) => Promise<U>): Promise<U> {
          const outcome = await pgTransaction(client, hidden, inner);
          if ('value' in outcome) return outcome.value;
          throw outcome.error;
        },
      });
    } finally {
      // Destroyed, not returned to the pool, so a session-level lock or setting can never outlive the run.
      client.release(true);
    }
  });
  return db;
}

async function liteTransaction<T>(lite: PGlite, fn: (tx: ScriptTransaction) => Promise<T>): Promise<T> {
  let thrown: { error: unknown } | undefined;
  try {
    return await lite.transaction(async (raw: Transaction) => {
      const scope: Scope = { ended: false };
      const tx: ScriptTransaction = {
        ...queryable(scope, async (text, params) => {
          try {
            return (await raw.query(text, params)).rows;
          } catch (error) {
            throw failure(error);
          }
        }),
        async script(text: string): Promise<void> {
          if (scope.ended) throw new StoreError('a transaction was used after it ended');
          try {
            await raw.exec(text);
          } catch (error) {
            throw failure(error);
          }
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        thrown = { error };
        throw error;
      } finally {
        scope.ended = true;
      }
    });
  } catch (error) {
    if (thrown !== undefined && error === thrown.error) throw error;
    throw failure(error);
  }
}

/**
 * Opens an empty Postgres that runs inside this process (PGlite), for tests and local runs. Nothing is written to disk.
 * It runs one statement at a time, so work started together is interleaved, never truly parallel. Inside a
 * transaction, use only its tx: a call to this Db itself waits for the transaction to end, so it never finishes.
 * PGlite is loaded only when this is called, so a server that never calls it never loads it.
 */
export async function openMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = await PGlite.create();
  let closed = false;
  let sessionTail: Promise<unknown> = Promise.resolve();

  function ensureOpen(): void {
    if (closed) throw new StoreError('the database connection is closed');
  }

  const direct = queryable(null, async (text, params) => {
    ensureOpen();
    try {
      return (await lite.query(text, params)).rows;
    } catch (error) {
      throw failure(error);
    }
  });

  const db: Db = {
    ...direct,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      ensureOpen();
      return liteTransaction(lite, (tx) => fn({ query: tx.query }));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await lite.close();
    },
  };

  // Every query here already shares one connection, so a session is that connection, taken one run at a time.
  sessions.set(db, (fn) => {
    const run = sessionTail.then(() => {
      ensureOpen();
      return fn({ ...direct, transaction: (inner) => liteTransaction(lite, inner) });
    });
    sessionTail = run.catch(() => undefined);
    return run;
  });
  return db;
}
