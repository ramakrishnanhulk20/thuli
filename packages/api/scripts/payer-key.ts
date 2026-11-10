import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export class PayerKeyError extends Error {
  override name = 'PayerKeyError';
}

/**
 * Takes PAYER_PRIVATE_KEY out of env and returns the account it signs for. The variable is deleted before anything is
 * checked, so the API started in this process afterwards finds no key in its environment, even when the key turns out
 * to be unreadable (C39). The key then lives only in the returned account.
 *
 * @throws PayerKeyError when the key is missing or is not 32 bytes of hex. The message names the variable and never
 * holds its value (C40).
 */
export function takePayerAccount(env: Record<string, string | undefined>): PrivateKeyAccount {
  const value = env.PAYER_PRIVATE_KEY?.trim();
  delete env.PAYER_PRIVATE_KEY;
  if (value === undefined || value === '') throw new PayerKeyError('PAYER_PRIVATE_KEY is missing. Set it in .env (see .env.example).');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(value)) throw new PayerKeyError('PAYER_PRIVATE_KEY is set but is not a 32-byte hex private key.');
  return privateKeyToAccount((value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`);
}
