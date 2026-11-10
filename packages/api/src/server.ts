import { serve } from '@hono/node-server';
import { EnvError } from '@thuli/worker/src/env.ts';
import { createApp, HEALTH_PATH, SCREEN_PATH } from './app.ts';
import { ConfigError, loadApiConfig } from './config.ts';
import { liveScreen } from './live.ts';

function start(): void {
  const config = loadApiConfig(process.env);
  const app = createApp(config, { screen: liveScreen(process.env) });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Thuli paid screening on ${config.networkId}, listening on port ${info.port}`);
    console.log(`  POST ${SCREEN_PATH}   GET ${HEALTH_PATH}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`api server stopped: ${error.code ?? error.name}`);
    process.exitCode = 1;
  });
}

try {
  start();
} catch (error) {
  if (error instanceof ConfigError || error instanceof EnvError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    // Library errors can quote a URL that carries a key, so only the class name is printed (C40).
    console.error(`api stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  }
}
