import { z } from 'zod';

/** A project's screening settings. They travel in every run's input, so a project never writes rule text. */
export const Settings = z.strictObject({
  minWalletAgeDays: z.int().min(0),
  minTxCount: z.int().min(0),
  groupMinSize: z.int().min(2),
  funderFanoutMin: z.int().min(2),
  partialShareBps: z.int().min(0).max(10000),
  allowPartial: z.boolean(),
  maxPaidHops: z.int().min(0).max(3),
});

export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  minWalletAgeDays: 30,
  minTxCount: 5,
  groupMinSize: 5,
  funderFanoutMin: 10,
  partialShareBps: 5000,
  allowPartial: true,
  maxPaidHops: 3,
});
