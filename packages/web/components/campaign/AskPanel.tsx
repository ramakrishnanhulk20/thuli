'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useDisconnect, useSignMessage } from 'wagmi';
import { askMessage, isOwnKeySignature, signedAtNow } from '@/lib/ask';
import {
  choosePanel,
  currentStep,
  fetchAsk,
  NOTICE_TEXT,
  payoutFor,
  pollDelay,
  postAsk,
  READY_TEXT,
  readyVariant,
  refusalWords,
  UNREACHABLE_TEXT,
  type AskView,
  type CampaignView,
  type Notice,
  type RefusalKind,
  type Step,
} from '@/lib/campaign';
import { shortAddress } from '@/lib/explorer';
import { Drop } from '../Drop';
import { ConnectChoices } from '../wallet/ConnectButton';
import { DecisionView } from './Decision';
import { useReadPause } from './useReadPause';
import { useVisibleInterval } from './useVisibleInterval';
import styles from './campaign.module.css';

const QUEUED_POLL_MILLISECONDS = 4000;
const PAYOUT_POLL_MILLISECONDS = 10_000;
// A signature is good for 600 seconds at the route; one older than this is made again rather than sent.
const SIGNATURE_REFRESH_SECONDS = 300;
const RESEND_LIMIT_MILLISECONDS = 540_000;

interface Signed {
  wallet: string;
  signedAt: number;
  signature: string;
}

/** Everything the panel knows about one connected wallet. It belongs to that wallet alone: another wallet starts clean. */
interface Session {
  wallet: string;
  view: AskView | null;
  /** The first lookup of the wallet's ask has come back, with an ask, with none, or with a failure. */
  checked: boolean;
  lookupFailed: boolean;
  signing: boolean;
  /** The ask was accepted by the route, and the lookup has not yet returned it. */
  sent: boolean;
  notice: Notice | null;
  cause: string;
  /** The ask cannot go ahead, and nothing the visitor can press here changes that. */
  refusal: { kind: RefusalKind; retryAfter: string | null } | null;
}

const freshSession = (wallet: string): Session => ({
  wallet,
  view: null,
  checked: false,
  lookupFailed: false,
  signing: false,
  sent: false,
  notice: null,
  cause: '',
  refusal: null,
});

interface AskPanelProps {
  campaignId: string;
  campaign: CampaignView;
  now: number;
  onGone: () => void;
  /** Told which step of "How it goes" the visitor is on, so the steps beside the panel can light it. */
  onStep: (step: Step | null) => void;
  /** Told when the lookup route is slowed or free again, so the page can show its one line. */
  onSlowed: (route: string, slowed: boolean) => void;
}

/** A refusal stands in place of the ask: a heading and a body, with no button to press. */
function Refusal({ kind, retryAfter }: { kind: RefusalKind; retryAfter: string | null }) {
  const words = refusalWords(kind, retryAfter);
  return (
    <div aria-live="polite" data-refusal={kind}>
      <h3 className={`${styles.panelTitle} ${styles.waitTitle}`}>{words.heading}</h3>
      <p className={styles.panelBody}>{words.body}</p>
    </div>
  );
}

export function AskPanel({ campaignId, campaign, now, onGone, onStep, onSlowed }: AskPanelProps) {
  const connection = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: signMessage } = useSignMessage();
  const address = connection.isConnected && connection.address !== undefined ? connection.address : null;

  const [session, setSession] = useState<Session | null>(null);
  const [signedAt, setSignedAt] = useState(() => signedAtNow());
  const lastSigned = useRef<(Signed & { madeAt: number }) | null>(null);
  const current = useRef<string | null>(null);
  const pause = useReadPause('asks', onSlowed);
  const { busy: pauseBusy, ok: pauseOk, quiet: pauseQuiet } = pause;

  // A session that belongs to another wallet is never shown: the first render after a switch already starts clean.
  const mine: Session | null = address === null ? null : session !== null && session.wallet === address ? session : freshSession(address);

  const patch = useCallback((wallet: string, changes: Partial<Session>) => {
    if (current.current !== wallet) return;
    setSession((before) => ({ ...(before !== null && before.wallet === wallet ? before : freshSession(wallet)), ...changes }));
  }, []);

  const lookUp = useCallback(
    async (wallet: string, initial: boolean) => {
      if (pauseQuiet()) return;
      const found = await fetchAsk(campaignId, wallet);
      if (found.kind === 'busy') {
        // A first lookup that is told to slow down stays on "checking" and is tried again after the pause.
        pauseBusy();
        return;
      }
      if (found.kind === 'found') {
        pauseOk();
        patch(wallet, { view: found.view, sent: false, lookupFailed: false, ...(initial ? { checked: true } : {}) });
      } else if (found.kind === 'none') {
        pauseOk();
        patch(wallet, { lookupFailed: false, ...(initial ? { checked: true } : {}) });
      } else if (initial) {
        patch(wallet, { lookupFailed: true, checked: true });
      }
    },
    [campaignId, patch, pauseBusy, pauseOk, pauseQuiet],
  );

  useEffect(() => {
    current.current = address;
    lastSigned.current = null;
    if (address === null) {
      setSession(null);
      return;
    }
    setSession(freshSession(address));
    void lookUp(address, true);
  }, [address, lookUp]);

  const ask = mine?.view?.ask ?? null;
  const ticket = mine?.view?.ticket;
  const signing = mine?.signing ?? false;
  const notice = mine?.notice ?? null;
  const panel = choosePanel({
    connected: address !== null,
    ask,
    looking: mine !== null && !mine.checked,
    signing,
    sent: mine?.sent ?? false,
    refused: (mine?.refusal ?? null) !== null,
    unreachable: (mine?.lookupFailed ?? false) || notice === 'unreachable',
  });

  // The message shows the time it will be signed with, set when the ask is offered.
  useEffect(() => {
    if (panel === 'ready') setSignedAt(signedAtNow());
  }, [panel]);

  const waiting = (mine?.sent ?? false) || ask?.status === 'queued' || ask?.status === 'screening';
  const approved = ask !== null && ask.status === 'decided' && ask.slot !== null && (ask.action === 'full' || ask.action === 'partial');
  const paid = ticket !== undefined && ticket.claimed !== undefined && BigInt(ticket.claimed) >= BigInt(ticket.cumulativeAmount);
  const approvedUnpaid = approved && !paid;
  const step = currentStep({ ask, sent: mine?.sent ?? false, paid });
  useEffect(() => {
    onStep(step);
  }, [step, onStep]);
  const checked = mine?.checked ?? false;
  const retryingFirstLookup = mine !== null && !checked && pause.slowed;
  useVisibleInterval(
    () => {
      if (address !== null) void lookUp(address, !checked);
    },
    pollDelay(waiting ? QUEUED_POLL_MILLISECONDS : PAYOUT_POLL_MILLISECONDS, pause.slowed),
    address !== null && (waiting || approvedUnpaid || retryingFirstLookup),
  );

  async function send(signed: Signed) {
    lastSigned.current = { ...signed, madeAt: Date.now() };
    const result = await postAsk(campaignId, signed);
    patch(signed.wallet, { signing: false });
    switch (result.kind) {
      case 'queued':
        patch(signed.wallet, { sent: true });
        void lookUp(signed.wallet, false);
        break;
      case 'exists':
        patch(signed.wallet, { view: { ask: result.ask } });
        void lookUp(signed.wallet, false);
        break;
      case 'closed':
        patch(signed.wallet, { notice: 'closed' });
        break;
      case 'full':
        patch(signed.wallet, { refusal: { kind: 'full', retryAfter: null } });
        break;
      case 'ceiling':
        patch(signed.wallet, { refusal: { kind: 'ceiling', retryAfter: result.retryAfter } });
        break;
      case 'limit':
        patch(signed.wallet, { notice: 'limit' });
        break;
      case 'bad':
        patch(signed.wallet, { cause: result.cause, notice: 'bad' });
        break;
      case 'gone':
        if (current.current === signed.wallet) onGone();
        break;
      case 'unreachable':
        patch(signed.wallet, { notice: 'unreachable' });
        break;
    }
  }

  async function onSign() {
    if (address === null) return;
    const fresh = signedAtNow();
    const at = fresh - signedAt > SIGNATURE_REFRESH_SECONDS ? fresh : signedAt;
    setSignedAt(at);
    patch(address, { notice: null, signing: true });
    let signature: string;
    try {
      signature = await signMessage({ message: askMessage({ campaignId, wallet: address, signedAt: at }) });
    } catch {
      patch(address, { signing: false, notice: 'declined' });
      return;
    }
    // A contract wallet answers with a signature of another length. The route cannot check it, so it is not sent.
    if (!isOwnKeySignature(signature)) {
      patch(address, { signing: false, refusal: { kind: 'contract', retryAfter: null } });
      return;
    }
    await send({ wallet: address, signedAt: at, signature });
  }

  function onRetry() {
    if (address === null || mine === null) return;
    const kept = lastSigned.current;
    if (notice === 'unreachable' && kept !== null && Date.now() - kept.madeAt < RESEND_LIMIT_MILLISECONDS) {
      patch(address, { notice: null, signing: true });
      void send(kept);
      return;
    }
    if (mine.lookupFailed) {
      patch(address, { notice: null, lookupFailed: false, checked: false });
      void lookUp(address, true);
      return;
    }
    patch(address, { notice: null });
  }

  const walletRow =
    address === null ? null : (
      <div className={styles.walletRow}>
        <span className={styles.walletAddress} data-wallet>{shortAddress(address)}</span>
        <button type="button" className={styles.quiet} onClick={() => disconnect()}>
          <span className={styles.quietLabel}>Disconnect</span>
        </button>
      </div>
    );

  const variant = readyVariant(campaign, now);
  const message = address === null ? '' : askMessage({ campaignId, wallet: address, signedAt });

  return (
    <section className={styles.panel} aria-labelledby="ask-title" data-panel={panel}>
      <div key={panel} className={styles.rise}>
        {panel === 'connect' ? (
          <>
            <h2 id="ask-title" className={styles.panelTitle}>Ask for a slot</h2>
            <p className={styles.panelBody}>Connect a wallet you control. You sign one short message. It costs nothing and moves nothing.</p>
            <ConnectChoices />
          </>
        ) : null}

        {panel === 'checking' ? <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2> : null}
        {panel === 'checking' ? walletRow : null}

        {(panel === 'ready' || panel === 'signing') && variant === 'stopped' ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2>
            {walletRow}
            <Refusal kind="stopped" retryAfter={null} />
          </>
        ) : null}

        {panel === 'refused' && mine?.refusal ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2>
            {walletRow}
            <Refusal kind={mine.refusal.kind} retryAfter={mine.refusal.retryAfter} />
          </>
        ) : null}

        {(panel === 'ready' || panel === 'signing') && variant !== 'stopped' ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2>
            {walletRow}
            <p className={styles.panelBody}>You will sign this message:</p>
            <pre className={styles.message} data-message>{message}</pre>
            {variant === 'closed' ? (
              <p className={styles.panelBody} data-closed>{READY_TEXT.closed}</p>
            ) : variant === 'full' ? (
              <p className={styles.panelBody} data-full>{READY_TEXT.full}</p>
            ) : (
              <button type="button" className={styles.primary} disabled={signing} onClick={onSign} data-sign>
                {signing ? 'Waiting for your wallet' : 'Sign and ask'}
              </button>
            )}
            <p className={styles.panelNote}>Thuli then reads this wallet&apos;s public history on Ethereum and decides. One ask per wallet.</p>
            {notice === null || notice === 'unreachable' ? null : (
              <p className={styles.notice} role="alert" data-notice={notice}>
                {notice === 'bad' ? mine?.cause : NOTICE_TEXT[notice]}
              </p>
            )}
          </>
        ) : null}

        {panel === 'screening' ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2>
            {walletRow}
            <div aria-live="polite" data-screening>
              <div className={styles.drops} aria-hidden="true">
                <Drop width={14} className={styles.drop} />
                <Drop width={14} className={styles.drop} />
                <Drop width={14} className={styles.drop} />
              </div>
              <h3 className={`${styles.panelTitle} ${styles.waitTitle}`}>Screening your wallet.</h3>
              <p className={styles.panelBody}>This usually takes under a minute. You can leave this page; the decision stays here.</p>
            </div>
          </>
        ) : null}

        {panel === 'decided' && ask !== null ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Your decision</h2>
            {walletRow}
            <DecisionView ask={ask} payout={payoutFor({ ask, ticket: mine?.view?.ticket ?? null, campaign, now })} />
          </>
        ) : null}

        {panel === 'unreachable' ? (
          <>
            <h2 id="ask-title" className={styles.visuallyHidden}>Ask for a slot</h2>
            {walletRow}
            <p className={styles.panelBody} data-unreachable>{UNREACHABLE_TEXT}</p>
            <button type="button" className={styles.primary} onClick={onRetry}>
              Try again
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
