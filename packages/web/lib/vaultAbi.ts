import { parseAbi } from 'viem';

/**
 * The parts of ThuliVault the attack page calls or expects back. The strings are kept as text so a test can compare
 * every one of them with the generated ABI in packages/worker/src/vault/abi.ts.
 */
export const VAULT_SIGNATURES = [
  'function claim(address account, uint256 cumulativeAmount, bytes32[] proof)',
  'function withdrawAfterEnd(address to)',
  'function postRoot(bytes32 root, uint256 declaredTotal)',
  'function claimed(address account) view returns (uint256)',
  'error InvalidProof()',
  'error NothingToClaim(address account)',
  'error NotAgent(address caller)',
  'error OwnableUnauthorizedAccount(address account)',
  'error CampaignNotEnded()',
  'error CampaignEnded()',
  'error NoClaimableRoot()',
  'error EnforcedPause()',
  'error DepositExhausted(uint256 amount, uint256 available)',
] as const;

export const VAULT_ABI = parseAbi(VAULT_SIGNATURES);
