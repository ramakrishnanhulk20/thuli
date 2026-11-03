import { z } from 'zod';

export class EnvError extends Error {
  override name = 'EnvError';
}

// https only: the SERV key travels as a bearer header, and chain data should not be readable or editable in transit.
const BaseUrl = z
  .url({ protocol: /^https$/ })
  .transform((url) => url.replace(/\/+$/, ''));

const blankAsMissing = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const EnvSchema = z.object({
  SERV_API_KEY: z.string().trim().min(1),
  SERV_GRAPH_ID: z.preprocess(blankAsMissing, z.string().trim().regex(/^gr_\S+$/).optional()),
  SERV_BASE_URL: BaseUrl,
  ETH_RPC_URL: BaseUrl,
  BLOCKSCOUT_ETH_API: BaseUrl,
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Reads and checks only the variables the worker needs, so other secrets in .env never enter this process's config.
 *
 * @throws EnvError naming each missing or malformed variable. The message never contains a value (threat model C40).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new EnvError(
    `Missing or invalid environment variable: ${names.join(', ')}. Set it in .env (see .env.example for what goes there).`,
  );
}
