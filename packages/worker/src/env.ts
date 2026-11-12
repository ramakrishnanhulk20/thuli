import { z } from 'zod';

export class EnvError extends Error {
  override name = 'EnvError';
}

// https only: the SERV key travels as a bearer header, and chain data should not be readable or editable in transit.
const BaseUrl = z
  .url({ protocol: /^https$/ })
  .transform((url) => url.replace(/\/+$/, ''));

const blankAsMissing = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/**
 * Base mainnet's public RPC, read when BASE_RPC_URL is not set. It serves no traces, so with it the campaign's RPC
 * history stays off.
 */
export const BASE_PUBLIC_RPC_URL = 'https://mainnet.base.org';
/**
 * What a Blockscout API key may be: 8 to 512 visible ASCII characters, no spaces. It travels as a header value, where a
 * line break would be refused, and a value under 8 characters would be too short for the log scrubber to blank (C40).
 */
export const BLOCKSCOUT_KEY = /^[!-~]{8,512}$/;

const EnvSchema = z.object({
  SERV_API_KEY: z.string().trim().min(1),
  SERV_GRAPH_ID: z.preprocess(blankAsMissing, z.string().trim().regex(/^gr_\S+$/).optional()),
  SERV_BASE_URL: BaseUrl,
  ETH_RPC_URL: BaseUrl,
  BLOCKSCOUT_ETH_API: BaseUrl,
  BASE_RPC_URL: z.preprocess(blankAsMissing, BaseUrl.default(BASE_PUBLIC_RPC_URL)),
  BLOCKSCOUT_API_KEY: z.preprocess(blankAsMissing, z.string().trim().regex(BLOCKSCOUT_KEY).optional()),
  EXPLORER_API_URL: z.preprocess(blankAsMissing, BaseUrl.default('https://api.etherscan.io/v2/api')),
  EXPLORER_API_KEY: z.preprocess(blankAsMissing, z.string().trim().min(1).optional()),
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
