'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { useBalance, useConfig, useReadContract, type Config } from 'wagmi';
import { getPublicClient, readContract, simulateContract, writeContract } from 'wagmi/actions';
import { BASE_SEPOLIA } from '@/lib/contracts';
import { addressLink, shortAddress, shortHash, txLink } from '@/lib/explorer';
import {
  approveRequest,
  checkTerms,
  clearResume,
  createVaultRequest,
  DEFAULT_CAP,
  DEFAULT_DELAY,
  DEFAULT_DEPOSIT,
  defaultEndDate,
  depositRequest,
  formatAmount,
  holdsOf,
  isNotAVault,
  loadResume,
  readCreation,
  reasonFor,
  REASONS,
  saveResume,
  settle,
  stageFor,
  STATE_ABI,
  termsFromChain,
  termsFromRecord,
  termsSummary,
  USDC_BASE_SEPOLIA,
  vaultMatches,
  WAIT_LIMIT_KEY,
  waitLimit,
  watchCreation,
  type CallStep,
  type Reason,
  type ResumeRecord,
  type Stage,
  type Terms,
  type TermsForm,
  type VaultState,
} from '@/lib/owner';
import { TOKEN_ABI } from '@/lib/vaultAbi';
import { Drop } from '../Drop';
import campaign from '../campaign/campaign.module.css';
import { CopyButton } from './CopyButton';
import { ExplorerLink } from './ExplorerLink';
import { FundedCard } from './FundedCard';
import { Row, type Word } from './Row';
import { TermsEditor } from './TermsEditor';
import styles from './owner.module.css';

const CHAIN = BASE_SEPOLIA.chainId;
const SETTLE_TRIES = 30;
const SETTLE_WAIT_MILLISECONDS = 1000;
const RESUME_POLL_MILLISECONDS = 5000;
const CREATION_POLL_MILLISECONDS = 2000;

type Phase = 'idle' | 'checking' | 'wallet' | 'network' | 'failed' | 'done';

interface StepState {
  phase: Phase;
  hash: string | null;
  reason: Reason | null;
}

const IDLE: StepState = { phase: 'idle', hash: null, reason: null };

function wordOf(step: StepState): Word {
  switch (step.phase) {
    case 'idle':
      return 'todo';
    case 'checking':
    case 'network':
      return 'network';
    case 'wallet':
      return 'wallet';
    case 'failed':
      return 'failed';
    case 'done':
      return 'done';
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSetting(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_WAIT_MILLISECONDS));
const nowSeconds = () => Math.floor(Date.now() / 1000);

type Sent = { ok: true; hash: Hex } | { ok: false; reason: Reason };

/** Sends a call that already passed its simulation. `onSent` is told the hash the moment the wallet returns it. */
async function sendOnly(config: Config, request: unknown, step: CallStep, report: (next: StepState) => void, onSent: (hash: Hex) => void): Promise<Sent> {
  report({ phase: 'wallet', hash: null, reason: null });
  let hash: Hex;
  try {
    hash = await writeContract(config, request as never);
  } catch (error) {
    return { ok: false, reason: reasonFor(error, step) };
  }
  onSent(hash);
  report({ phase: 'network', hash, reason: null });
  return { ok: true, hash };
}

type Submitted = { ok: true; hash: Hex; receipt: TransactionReceipt } | { ok: false; reason: Reason; hash: Hex | null };

/** Sends a call that already passed its simulation, then waits for it to be mined. */
async function submit(config: Config, request: unknown, step: CallStep, report: (next: StepState) => void): Promise<Submitted> {
  const sent = await sendOnly(config, request, step, report, () => {});
  if (!sent.ok) return { ok: false, reason: sent.reason, hash: null };
  const hash = sent.hash;
  try {
    // The client is used directly because wagmi's own wait throws a bare Error for a reverted receipt, which could not be
    // told apart from any other failure. A timeout of 0 means no limit, as wagmi sets it.
    const client = getPublicClient(config, { chainId: CHAIN });
    if (client === undefined) return { ok: false, reason: REASONS.other, hash };
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 0 });
    if (receipt.status !== 'success') return { ok: false, reason: REASONS.network, hash };
    return { ok: true, hash, receipt };
  } catch (error) {
    return { ok: false, reason: reasonFor(error, step), hash };
  }
}

function TxLink({ hash }: { hash: string }) {
  return (
    <span className={styles.statusLinks}>
      <ExplorerLink href={txLink(CHAIN, hash)}>{shortHash(hash)}</ExplorerLink>
    </span>
  );
}

interface CallBodyProps {
  step: StepState;
  /** The line and the button shown before the call is started. Row 02 has none: its button is row 01's. */
  start?: { line: string; button: string };
  onRun: () => void;
}

/** The inside of an open row while a wallet call goes through: the line and button, then each wait, then a failure. */
function CallBody({ step, start, onRun }: CallBodyProps) {
  if (step.phase === 'wallet') return <p className={styles.status} data-status="wallet">Confirm in your wallet.</p>;
  if (step.phase === 'network') {
    return (
      <div data-status="network">
        <p className={styles.status}>Sent. Waiting for the network.</p>
        {step.hash === null ? null : <TxLink hash={step.hash} />}
      </div>
    );
  }
  if (step.phase === 'failed') {
    return (
      <div data-status="failed">
        <p className={styles.reason} role="alert" data-reason>
          {step.reason}
        </p>
        <button type="button" className={styles.secondary} onClick={onRun} data-retry>
          Try again
        </button>
      </div>
    );
  }
  if (start === undefined) return null;
  return (
    <div data-status="start">
      <p className={styles.status}>{start.line}</p>
      <button type="button" className={`${styles.primary} ${styles.afterLine}`} disabled={step.phase === 'checking'} onClick={onRun} data-run>
        {start.button}
      </button>
    </div>
  );
}

interface FlowProps {
  wallet: Address;
  /** Starts the page over for the same wallet, after the kept record has been cleared. */
  onRestart: () => void;
}

/** The four rows for one connected wallet on Base Sepolia. Every amount it shows after the form comes from the chain. */
export function Flow({ wallet, onRestart }: FlowProps) {
  const config = useConfig();
  const [form, setForm] = useState<TermsForm>(() => ({ cap: DEFAULT_CAP, deposit: DEFAULT_DEPOSIT, endDate: defaultEndDate(Date.now()), delay: DEFAULT_DELAY }));
  // Mounted only after the wallet has connected in the browser, so the kept record can be read at once.
  const [kept] = useState<ResumeRecord | null>(() => loadResume(browserStorage(), wallet, CHAIN));
  const [record, setRecord] = useState<ResumeRecord | null>(kept);
  // A record with a hash and no vault is a creation that was sent: the row waits for it as if it had just been sent.
  const sentBefore = kept !== null && kept.vault === null ? kept : null;
  const [accepted, setAccepted] = useState<Terms | null>(() => (sentBefore === null ? null : termsFromRecord(sentBefore)));
  const [checking, setChecking] = useState(false);
  const [formReason, setFormReason] = useState<Reason | null>(null);
  const [create, setCreate] = useState<StepState>(() => (sentBefore === null ? IDLE : { phase: 'network', hash: sentBefore.txHash, reason: null }));
  const [allow, setAllow] = useState<StepState>(IDLE);
  const [deposit, setDeposit] = useState<StepState>(IDLE);
  const [createdHere, setCreatedHere] = useState(false);

  const vault = record === null || record.vault === null ? null : (record.vault as Address);
  const pendingHash = record !== null && record.vault === null ? record.txHash : null;
  const usdcBalance = useReadContract({ address: USDC_BASE_SEPOLIA, abi: TOKEN_ABI, functionName: 'balanceOf', args: [wallet], chainId: CHAIN });
  const ethBalance = useBalance({ address: wallet, chainId: CHAIN });
  const stateRead = useReadContract({
    address: vault ?? zeroAddress,
    abi: STATE_ABI,
    functionName: 'state',
    chainId: CHAIN,
    query: { enabled: vault !== null, refetchInterval: (query) => (query.state.data === undefined ? RESUME_POLL_MILLISECONDS : false) },
  });
  const allowanceRead = useReadContract({
    address: USDC_BASE_SEPOLIA,
    abi: TOKEN_ABI,
    functionName: 'allowance',
    args: [wallet, vault ?? zeroAddress],
    chainId: CHAIN,
    query: { enabled: vault !== null, refetchInterval: (query) => (query.state.data === undefined ? RESUME_POLL_MILLISECONDS : false) },
  });
  const chainState = stateRead.data as VaultState | undefined;

  // A kept record is only a pointer. If the vault it names is not this wallet's, or is no vault at all, it is dropped and
  // the form starts clean. A read that merely failed to reach the network is not a reason to drop it.
  const stateError = stateRead.error;
  useEffect(() => {
    if (record === null || record.vault === null || createdHere) return;
    const foreign = chainState !== undefined && !vaultMatches(chainState, wallet);
    if (!foreign && !(chainState === undefined && isNotAVault(stateError))) return;
    clearResume(browserStorage(), wallet, CHAIN);
    setRecord(null);
  }, [record, createdHere, chainState, stateError, wallet]);

  const planned = record === null ? null : BigInt(record.deposit);
  const verified = record !== null && record.vault !== null && (createdHere || (chainState !== undefined && vaultMatches(chainState, wallet)));

  let stage: 'terms' | 'create' | 'resuming' | Stage;
  if (record === null) stage = accepted === null ? 'terms' : 'create';
  else if (record.vault === null) stage = 'create';
  else if (!verified || planned === null) stage = 'resuming';
  else if (deposit.phase === 'done') stage = 'funded';
  else stage = stageFor({ deposited: chainState?.deposited ?? 0n, planned, allowance: allow.phase === 'done' ? planned : (allowanceRead.data ?? null) });

  const balance = usdcBalance.data ?? null;
  const noEth = ethBalance.data !== undefined && ethBalance.data.value === 0n;
  const check = checkTerms(form, balance, nowSeconds());

  const shownTerms: Terms | null =
    record === null
      ? accepted
      : record.vault === null
        ? termsFromRecord(record)
        : !verified
          ? null
          : chainState !== undefined
            ? termsFromChain(chainState, record)
            : termsFromRecord(record);
  const amount = planned === null ? '' : formatAmount(planned);

  // The hash is kept the moment the wallet returns it, so one effect waits for it whether it was sent a second ago or before
  // the tab was closed. The vault comes from the factory's log, a revert keeps the terms, and a transaction the network has
  // never heard of is dropped after the limit.
  useEffect(() => {
    if (pendingHash === null || record === null) return;
    const hash = pendingHash;
    const terms = termsFromRecord(record);
    let stop = false;
    void (async () => {
      const client = getPublicClient(config, { chainId: CHAIN });
      if (client === undefined) return;
      const outcome = await watchCreation(
        hash,
        {
          receipt: async (txHash) => {
            try {
              return await client.getTransactionReceipt({ hash: txHash as Hex });
            } catch (error) {
              if (error instanceof TransactionReceiptNotFoundError) return null;
              throw error;
            }
          },
          known: async (txHash) => {
            try {
              await client.getTransaction({ hash: txHash as Hex });
              return true;
            } catch (error) {
              if (error instanceof TransactionNotFoundError) return false;
              throw error;
            }
          },
        },
        {
          limitMilliseconds: waitLimit(readSetting(WAIT_LIMIT_KEY)),
          pollMilliseconds: CREATION_POLL_MILLISECONDS,
          now: Date.now,
          wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
          stopped: () => stop,
        },
      );
      if (stop || outcome.kind === 'stopped') return;
      setAccepted(terms);
      if (outcome.kind === 'not-on-network') {
        clearResume(browserStorage(), wallet, CHAIN);
        setRecord(null);
        setCreate({ phase: 'failed', hash: null, reason: REASONS.notOnNetwork });
        return;
      }
      const read = readCreation(outcome.receipt, wallet);
      if (read.kind !== 'created') {
        setCreate({ phase: 'failed', hash, reason: read.kind === 'reverted' ? REASONS.network : REASONS.other });
        return;
      }
      // The cap, the end and the wait are kept as the factory logged them, so what the page shows next came from the chain.
      const made: ResumeRecord = {
        vault: read.vault,
        txHash: hash,
        cap: read.cap.toString(),
        deposit: terms.deposit.toString(),
        endTime: Number(read.endTime),
        rootDelay: read.rootDelay,
      };
      saveResume(browserStorage(), wallet, CHAIN, made);
      setCreatedHere(true);
      setRecord(made);
      setCreate({ phase: 'done', hash, reason: null });
    })();
    return () => {
      stop = true;
    };
  }, [pendingHash]);

  function changeForm(next: TermsForm) {
    setForm(next);
    setFormReason(null);
  }

  async function runCreate(terms: Terms, from: 'form' | 'retry') {
    if (from === 'form') {
      setChecking(true);
      setFormReason(null);
    } else {
      setCreate({ phase: 'checking', hash: null, reason: null });
    }
    let request: unknown;
    try {
      request = (await simulateContract(config, { ...createVaultRequest(wallet, terms), account: wallet, chainId: CHAIN })).request;
    } catch (error) {
      const reason = reasonFor(error, 'create');
      if (from === 'form') {
        setChecking(false);
        setFormReason(reason);
      } else {
        setCreate({ phase: 'failed', hash: null, reason });
      }
      return;
    }
    if (from === 'form') {
      setChecking(false);
      setAccepted(terms);
    }
    const sent = await sendOnly(config, request, 'create', setCreate, (hash) => {
      const pending: ResumeRecord = {
        vault: null,
        txHash: hash,
        cap: terms.cap.toString(),
        deposit: terms.deposit.toString(),
        endTime: terms.endTime,
        rootDelay: terms.rootDelay,
      };
      saveResume(browserStorage(), wallet, CHAIN, pending);
      setRecord(pending);
    });
    if (!sent.ok) setCreate({ phase: 'failed', hash: null, reason: sent.reason });
  }

  async function runAllow() {
    if (vault === null || planned === null) return;
    setAllow({ phase: 'checking', hash: null, reason: null });
    let request: unknown;
    try {
      request = (await simulateContract(config, { ...approveRequest(vault, planned), account: wallet, chainId: CHAIN })).request;
    } catch (error) {
      setAllow({ phase: 'failed', hash: null, reason: reasonFor(error, 'approve') });
      return;
    }
    const sent = await submit(config, request, 'approve', setAllow);
    if (!sent.ok) {
      setAllow({ phase: 'failed', hash: sent.hash, reason: sent.reason });
      return;
    }
    await settle(
      () => readContract(config, { address: USDC_BASE_SEPOLIA, abi: TOKEN_ABI, functionName: 'allowance', args: [wallet, vault], chainId: CHAIN }),
      (allowed) => allowed >= planned,
      { tries: SETTLE_TRIES, wait: pause },
    );
    await allowanceRead.refetch();
    setAllow({ phase: 'done', hash: sent.hash, reason: null });
  }

  async function runDeposit() {
    if (vault === null || planned === null) return;
    setDeposit({ phase: 'checking', hash: null, reason: null });
    let request: unknown;
    try {
      request = (await simulateContract(config, { ...depositRequest(vault, planned), account: wallet, chainId: CHAIN })).request;
    } catch (error) {
      setDeposit({ phase: 'failed', hash: null, reason: reasonFor(error, 'deposit') });
      return;
    }
    const sent = await submit(config, request, 'deposit', setDeposit);
    if (!sent.ok) {
      setDeposit({ phase: 'failed', hash: sent.hash, reason: sent.reason });
      return;
    }
    await settle(
      async () => (await readContract(config, { address: vault, abi: STATE_ABI, functionName: 'state', chainId: CHAIN })).deposited,
      (deposited) => deposited >= planned,
      { tries: SETTLE_TRIES, wait: pause },
    );
    await Promise.all([stateRead.refetch(), usdcBalance.refetch()]);
    setDeposit({ phase: 'done', hash: sent.hash, reason: null });
  }

  function restart() {
    clearResume(browserStorage(), wallet, CHAIN);
    onRestart();
  }

  const word = {
    one: stage === 'terms' ? (checking ? 'network' : 'todo') : stage === 'resuming' ? 'network' : 'done',
    two: stage === 'terms' || stage === 'resuming' ? 'todo' : stage === 'create' ? wordOf(create) : 'done',
    three: stage === 'terms' || stage === 'create' || stage === 'resuming' ? 'todo' : stage === 'reading' ? 'network' : stage === 'allow' ? wordOf(allow) : 'done',
    four: stage === 'deposit' ? wordOf(deposit) : stage === 'funded' ? 'done' : 'todo',
  } satisfies Record<string, Word>;

  const termsResult: ReactNode =
    stage === 'terms' || stage === 'resuming' || shownTerms === null ? null : (
      <>
        <span className={styles.resultLead} data-terms-summary>
          {termsSummary(shownTerms)}
        </span>
        {stage === 'create' && create.phase === 'failed' ? (
          <button
            type="button"
            className={campaign.quiet}
            onClick={() => {
              if (record !== null && record.vault === null) {
                clearResume(browserStorage(), wallet, CHAIN);
                setRecord(null);
              }
              setAccepted(null);
              setCreate(IDLE);
            }}
            data-change
          >
            <span className={campaign.quietLabel}>Change</span>
          </button>
        ) : null}
      </>
    );

  const vaultResult: ReactNode =
    record === null || record.vault === null || !verified ? null : (
      <>
        <span className={styles.resultLead}>Vault created</span>
        <span className={styles.addressLine} data-vault-line>
          <span className={styles.falling} aria-hidden="true">
            <Drop width={8} />
          </span>
          <ExplorerLink href={addressLink(CHAIN, record.vault)}>{shortAddress(record.vault)}</ExplorerLink>
          <CopyButton value={record.vault} label="vault address" />
        </span>
      </>
    );

  const allowedResult: ReactNode =
    stage !== 'deposit' && stage !== 'funded' ? null : allow.phase === 'done' || stage === 'funded' ? (
      <>
        <span>{`Allowed ${amount} USDC.`}</span>
        {allow.hash === null ? null : <TxLink hash={allow.hash} />}
      </>
    ) : (
      <span>Already allowed.</span>
    );

  const depositedResult: ReactNode =
    stage !== 'funded' || chainState === undefined ? null : (
      <>
        <span data-holds>{`The vault holds ${formatAmount(holdsOf(chainState))} USDC.`}</span>
        {deposit.hash === null ? null : <TxLink hash={deposit.hash} />}
      </>
    );

  return (
    <div className={styles.rows} data-stage={stage}>
      <Row number="01" title="Terms" word={word.one} open={stage === 'terms'} result={termsResult}>
        <TermsEditor
          form={form}
          onChange={changeForm}
          check={check}
          balance={balance}
          noEth={noEth}
          checking={checking}
          reason={formReason}
          onSubmit={() => {
            const fresh = checkTerms(form, balance, nowSeconds());
            if (fresh.terms === null) return;
            void runCreate(fresh.terms, 'form');
          }}
        />
      </Row>

      <Row number="02" title="Create the vault" word={word.two} open={stage === 'create'} result={vaultResult}>
        <CallBody
          step={create}
          onRun={() => {
            if (accepted !== null) void runCreate(accepted, 'retry');
          }}
        />
      </Row>

      <Row number="03" title="Allow the deposit" word={word.three} open={stage === 'allow'} result={allowedResult}>
        <CallBody
          step={allow}
          start={planned === null ? undefined : { line: `Let the vault take exactly ${amount} USDC from this wallet, no more.`, button: `Allow ${amount} USDC` }}
          onRun={() => void runAllow()}
        />
      </Row>

      <Row number="04" title="Deposit" word={word.four} open={stage === 'deposit'} result={depositedResult}>
        <CallBody
          step={deposit}
          start={planned === null ? undefined : { line: `Move ${amount} USDC into the vault.`, button: `Deposit ${amount} USDC` }}
          onRun={() => void runDeposit()}
        />
      </Row>

      {stage === 'funded' && record !== null && record.vault !== null ? <FundedCard vault={record.vault} txHash={record.txHash} onRestart={restart} /> : null}
    </div>
  );
}
