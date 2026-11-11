import { serve } from '@hono/node-server';
import { connectPostgres, migrate } from '@thuli/store';
import { EnvError } from '@thuli/worker/src/env.ts';
import { createApp, HEALTH_PATH, SCREEN_PATH } from './app.ts';
import { ConfigError, loadApiConfig } from './config.ts';
import { liveScreen } from './live.ts';
import { failureCode, memoryStores, postgresStores, type Stores } from './stores.ts';

/** How often a long-running server deletes the rows no claim or limit can need again (C41). */
const SWEEP_EVERY_MS = 600_000;

// The schema is brought up to date before the first request, so no request ever meets a missing table.
async function openStores(databaseUrl: string | null, now: () => Date): Promise<Stores> {
  if (databaseUrl === null) return memoryStores(now);
  const db = connectPostgres(databaseUrl);
  try {
    await migrate(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return postgresStores(db, now);
}

async function sweepQuietly(stores: Stores): Promise<void> {
  try {
    await stores.sweep();
  } catch (error) {
    console.warn(`api sweep failed: ${failureCode(error)}`);
  }
}

async function start(): Promise<void> {
  const config = loadApiConfig(process.env);
  const screen = liveScreen(process.env);
  const now = () => new Date();
  const stores = await openStores(config.databaseUrl, now);
  await sweepQuietly(stores);
  // Unref'd, so the timer alone never keeps the process alive.
  setInterval(() => void sweepQuietly(stores), SWEEP_EVERY_MS).unref();
  const app = createApp(config, { screen, now, stores });
  const kept = config.databaseUrl === null ? 'in this process only' : 'in Postgres, shared by every copy';
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Thuli paid screening on ${config.networkId}, listening on port ${info.port}`);
    console.log(`  POST ${SCREEN_PATH}   GET ${HEALTH_PATH}`);
    console.log(`  used payments and limits kept ${kept}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`api server stopped: ${error.code ?? error.name}`);
    process.exitCode = 1;
  });
}

start().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof EnvError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    // Library and database errors can quote a URL that carries a key or a password, so only the class and code are printed (C40).
    console.error(`api stopped: ${failureCode(error)}`);
    process.exitCode = 1;
  }
});
