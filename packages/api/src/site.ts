import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectPostgres, migrate, openMemoryDb, type Db } from '@thuli/store';
import { EnvError, loadEnv } from '@thuli/worker/src/env.ts';
import { createApp } from './app.ts';
import { accountTypeReader, vaultReaders } from './campaigns.ts';
import { ConfigError, loadApiConfig } from './config.ts';
import { liveScreen } from './live.ts';
import { failureCode, postgresStores } from './stores.ts';

/** Files the API reads from the repository, carried by the caller because a bundled server cannot find them by path. */
export interface SiteFiles {
  /** The rulebook text. */
  readonly rulebook: string;
  /** Every migration of the store, by file name, such as 001_init.sql. */
  readonly migrations: Readonly<Record<string, string>>;
}

export interface SiteApi {
  /** Answers one request to /api/x402/*, /api/check* or /api/campaigns/*, handed to the API unchanged. Never rejects. */
  fetch(request: Request): Promise<Response>;
}

/** How long a server copy waits after its store failed to start before it tries again, so a down database is not hammered. */
const STORE_RETRY_MS = 30_000;
const MIGRATION_NAME = /^[0-9A-Za-z_.-]+\.sql$/;

/** A setting the site cannot run safely without. Its message names the variable and never holds a value. */
class MountRefused extends Error {
  override name = 'MountRefused';
}

const answer = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// These three kinds of message are written to name a variable and nothing else, so they may be logged whole (C40).
function causeOf(error: unknown): string {
  if (error instanceof ConfigError || error instanceof EnvError || error instanceof MountRefused) return error.message;
  return failureCode(error);
}

const present = (value: string | undefined) => value !== undefined && value.trim() !== '';

// Only Base campaigns need it, so it may be left out; a value that is set must still be an https URL.
function baseRpcUrl(env: Record<string, string | undefined>): string | null {
  const value = env.BASE_RPC_URL?.trim();
  if (value === undefined || value === '') return null;
  if (!URL.canParse(value) || new URL(value).protocol !== 'https:') throw new MountRefused('BASE_RPC_URL must be an https URL.');
  return value;
}

// migrate() reads a folder, so the carried copies are written to a fresh one that is deleted once the schema is current.
async function migrateFrom(db: Db, migrations: Readonly<Record<string, string>>): Promise<void> {
  const names = Object.keys(migrations);
  if (names.length === 0) throw new MountRefused('No store migrations were carried into the server, so the schema cannot be made current.');
  if (!names.every((name) => MIGRATION_NAME.test(name))) throw new MountRefused('A carried migration has a name that is not a plain .sql file name.');
  // An empty file would be recorded as applied and leave the schema without its tables.
  if (names.some((name) => (migrations[name] ?? '').trim() === '')) throw new MountRefused('A carried migration is empty, so it was not carried whole.');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'thuli-migrations-'));
  try {
    for (const name of names) await writeFile(path.join(folder, name), migrations[name] as string, 'utf8');
    await migrate(db, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The paid and free API as the website serves them, for one server copy. Settings come from env, checked once, here:
 * - DATABASE_URL set: the claims, limits and cached checks live in that Postgres, shared by every copy.
 * - DATABASE_URL unset outside production: they live in an in-process Postgres, with one warning that they are lost on
 *   restart.
 * - Production needs both DATABASE_URL and TRUSTED_CLIENT_HEADER (on Vercel, x-vercel-forwarded-for). Outside
 *   production the caller is read from x-forwarded-for, which Next's own server fills from the socket.
 * Production is env.NODE_ENV as the server runs, not as the site was built.
 * - The campaign routes share that database. They read wallet types on ETH_RPC_URL, and vaults on Base Sepolia's
 *   public RPC, or for a Base campaign on BASE_RPC_URL when it is set.
 *
 * A setting that is missing, malformed or forbidden, a private key in env included (C39), means no API at all: every
 * request answers 503 {busy: true} and the cause is logged once, by variable name, never with a value (C40). The site
 * never serves a result from a half-configured API. The store is opened and its schema brought up to date before the
 * first request is handled; if that fails, requests answer 503 {busy: true} and it is tried again after 30 seconds.
 */
export function siteApi(env: Record<string, string | undefined>, files: SiteFiles): SiteApi {
  const now = () => new Date();
  let config: ReturnType<typeof loadApiConfig>;
  let screen: ReturnType<typeof liveScreen>;
  let isContract: ReturnType<typeof accountTypeReader>;
  let vault: ReturnType<typeof vaultReaders>;
  try {
    const production = env.NODE_ENV === 'production';
    // The private key refusal inside loadApiConfig runs before anything else is read.
    config = loadApiConfig(production || present(env.TRUSTED_CLIENT_HEADER) ? env : { ...env, TRUSTED_CLIENT_HEADER: 'x-forwarded-for' });
    if (production && config.trustedClientHeader === null) {
      throw new MountRefused('TRUSTED_CLIENT_HEADER is not set: in production the caller can only be read from the header the host writes.');
    }
    if (production && config.databaseUrl === null) {
      throw new MountRefused('DATABASE_URL is not set: a production server keeps no payments or limits in its own memory.');
    }
    screen = liveScreen(env, files.rulebook);
    isContract = accountTypeReader(loadEnv(env).ETH_RPC_URL);
    vault = vaultReaders(baseRpcUrl(env));
  } catch (error) {
    console.error(`api not mounted: ${causeOf(error)}`);
    return { fetch: async () => answer(503, { busy: true }) };
  }
  const databaseUrl = config.databaseUrl;

  async function open(): Promise<(request: Request) => Response | Promise<Response>> {
    let db: Db;
    if (databaseUrl !== null) {
      db = connectPostgres(databaseUrl);
    } else {
      db = await openMemoryDb();
      console.warn('api: DATABASE_URL is not set, so payments, limits and checks live in this process only and are lost on restart');
    }
    try {
      await migrateFrom(db, files.migrations);
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }
    const app = createApp(config, { screen, stores: postgresStores(db, now), now, campaigns: { db, isContract, vault, now } });
    return (request) => app.fetch(request);
  }

  let ready: ReturnType<typeof open> | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;
  return {
    async fetch(request) {
      if (ready === null) {
        if (Date.now() - failedAt < STORE_RETRY_MS) return answer(503, { busy: true });
        const opening = open();
        ready = opening;
        opening.catch((error: unknown) => {
          console.error(`api store did not start: ${causeOf(error)}`);
          failedAt = Date.now();
          ready = null;
        });
      }
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await ready;
      } catch {
        return answer(503, { busy: true });
      }
      try {
        return await handle(request);
      } catch (error) {
        console.error(`api error: ${failureCode(error)}`);
        return answer(500, { error: 'internal error' });
      }
    },
  };
}
