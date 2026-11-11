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

/**
 * What the owner's setup page calls on the vault factory, with the refusals a new vault gives while it is made, so a
 * simulated call that reverts comes back with a name. Kept apart from VAULT_SIGNATURES, which test/break.test.ts holds
 * to the attack page's list.
 */
export const FACTORY_SIGNATURES = [
  'function createVault(address token, address owner, address agent, uint256 perWalletCap, uint64 endTime, uint32 rootDelay) returns (address vault)',
  'event VaultCreated(address indexed vault, address indexed owner, address indexed agent, address token, uint256 perWalletCap, uint64 endTime, uint32 rootDelay)',
  'error ZeroCap()',
  'error RootDelayOutOfRange(uint32 rootDelay)',
  'error EndTimeTooSoon(uint64 endTime, uint256 earliest)',
  'error EndTimeOutOfRange(uint64 endTime)',
] as const;

export const FACTORY_ABI = parseAbi(FACTORY_SIGNATURES);

/** The owner's deposit into a vault, and the error its token transfer can come back with. */
export const VAULT_WRITE_SIGNATURES = ['function deposit(uint256 amount)', 'error SafeERC20FailedOperation(address token)'] as const;

export const VAULT_WRITE_ABI = parseAbi(VAULT_WRITE_SIGNATURES);

/** The three ERC-20 calls the setup page makes on the reward token. */
export const TOKEN_SIGNATURES = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
] as const;

export const TOKEN_ABI = parseAbi(TOKEN_SIGNATURES);
