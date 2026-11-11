'use client';

import { useRef, useState } from 'react';
import { useSignMessage } from 'wagmi';
import {
  APPEAL_COUNTER_FROM,
  APPEAL_MAX_CHARS,
  appealMessage,
  appealProblem,
  appealSendable,
  appealTextHash,
  appealWarning,
  isOwnKeySignature,
  prepareAppealText,
  signedAtNow,
} from '@/lib/ask';
import {
  APPEAL_COPY,
  appealRefusalText,
  appealStage,
  checkedWords,
  NOTICE_TEXT,
  postAppeal,
  refusalWords,
  settledWords,
  type AppealPanel,
  type AppealPost,
  type AppealTone,
  type AppealView,
} from '@/lib/campaign';
import { Drop } from '../Drop';
import styles from './campaign.module.css';

// A signature is good for 600 seconds at the route; the same signed body is sent again only while it is younger than this.
const RESEND_LIMIT_MILLISECONDS = 540_000;

const TONE_CLASS: Record<AppealTone, string> = {
  hold: styles.toneHold ?? '',
  partial: styles.tonePartial ?? '',
  full: styles.toneFull ?? '',
  quiet: styles.toneQuiet ?? '',
};

interface Signed {
  wallet: string;
  text: string;
  signedAt: number;
  signature: string;
}

type Notice =
  | { kind: 'declined' }
  | { kind: 'contract' }
  | { kind: 'post'; post: Extract<AppealPost, { kind: 'undecided' | 'approved' | 'limit' | 'ceiling' | 'bad' | 'unreachable' }> };

/** The owner's call, under the outside check, in the panel's big-word style at half its size. */
function Settled({ appeal }: { appeal: AppealView }) {
  const words = settledWords(appeal);
  if (words === null) return null;
  return (
    <div className={styles.settled} data-settled={appeal.outcome}>
      <h4 className={`${styles.settledHead} ${words.tone === 'full' ? styles.settledFull : ''}`}>{words.headline}</h4>
      <p className={`${styles.appealLine} ${words.tone === 'ink' ? '' : styles.appealLineInk}`}>{words.line}</p>
    </div>
  );
}

/** What the visitor sees once an appeal is filed: with the judge, the judges' answer, or that no check could be made. */
function Filed({ appeal }: { appeal: AppealView | null }) {
  const stage = appeal === null ? 'judge' : appealStage(appeal);
  if (stage === 'judge') {
    return (
      <div className={styles.appeal} data-appeal="judge">
        <div className={styles.appealHead}>
          <span className={styles.appealLabel}>{APPEAL_COPY.filedLabel}</span>
          <span className={styles.appealState}>{APPEAL_COPY.withJudge}</span>
        </div>
        <p className={styles.appealLine}>{APPEAL_COPY.judgeLine}</p>
      </div>
    );
  }
  if (appeal === null) return null;
  if (stage === 'unchecked') {
    return (
      <div className={styles.appeal} data-appeal="unchecked">
        <p className={styles.appealLabel}>{APPEAL_COPY.filedLabel}</p>
        <p className={styles.appealLine}>{APPEAL_COPY.uncheckedLine}</p>
        <Settled appeal={appeal} />
      </div>
    );
  }
  const words = checkedWords(appeal);
  return (
    <div className={styles.appeal} data-appeal="checked">
      <p className={styles.appealLabel}>{APPEAL_COPY.checkedLabel}</p>
      <div className={styles.appealRise} data-check>
        <div className={styles.checkHead}>
          <Drop width={8} className={`${styles.checkDrop} ${TONE_CLASS[words.tone]}`} />
          <h4 className={styles.checkHeadline} data-check-headline>
            {words.headline}
          </h4>
        </div>
        {words.note === null ? null : (
          <p className={styles.appealLine} data-check-note>
            {words.note}
          </p>
        )}
        <p className={styles.appealSmall} data-check-advice>
          {words.advice}
        </p>
        {words.evalLine === null ? null : (
          <p className={`${styles.appealSmall} ${styles.appealMono}`} data-check-id>
            {words.evalLine}
          </p>
        )}
      </div>
      <Settled appeal={appeal} />
    </div>
  );
}

interface AppealBlockProps {
  campaignId: string;
  wallet: string;
  panel: AppealPanel;
  /** An appeal was taken by the route and the ask does not show it yet. */
  sent: boolean;
  /** Told when the route took the appeal, so the ask is read again straight away. */
  onSent: () => void;
  onGone: () => void;
}

/** The appeal inside the decision panel: the form to file one, or the state of the one that is filed. */
export function AppealBlock({ campaignId, wallet, panel, sent, onSent, onGone }: AppealBlockProps) {
  const { mutateAsync: signMessage } = useSignMessage();
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'signing' | 'sending'>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const lastSigned = useRef<(Signed & { madeAt: number }) | null>(null);

  if (panel.kind === 'hidden' && !sent) return null;
  if (panel.kind === 'filed') return <Filed appeal={panel.appeal} />;
  if (sent) return <Filed appeal={null} />;

  const problem = appealProblem(text);
  const warning = appealWarning(problem);
  const busy = phase !== 'idle';

  async function send(signed: Signed) {
    lastSigned.current = { ...signed, madeAt: Date.now() };
    setPhase('sending');
    const result = await postAppeal(campaignId, signed);
    setPhase('idle');
    switch (result.kind) {
      case 'queued':
      case 'exists':
        setNotice(null);
        onSent();
        break;
      case 'gone':
        onGone();
        break;
      default:
        setNotice({ kind: 'post', post: result });
    }
  }

  async function onAppeal() {
    if (problem !== null || busy) return;
    setNotice(null);
    const prepared = prepareAppealText(text);
    const textHash = await appealTextHash(prepared);
    const signedAt = signedAtNow();
    setPhase('signing');
    let signature: string;
    try {
      signature = await signMessage({ message: appealMessage({ campaignId, wallet, textHash, signedAt }) });
    } catch {
      setPhase('idle');
      setNotice({ kind: 'declined' });
      return;
    }
    // A contract wallet answers with a signature of another length. The route cannot check it, so it is not sent.
    if (!isOwnKeySignature(signature)) {
      setPhase('idle');
      setNotice({ kind: 'contract' });
      return;
    }
    await send({ wallet, text: prepared, signedAt, signature });
  }

  function onRetry() {
    const kept = lastSigned.current;
    if (kept !== null && Date.now() - kept.madeAt < RESEND_LIMIT_MILLISECONDS) {
      setNotice(null);
      void send(kept);
      return;
    }
    void onAppeal();
  }

  const label = phase === 'signing' ? APPEAL_COPY.signing : phase === 'sending' ? APPEAL_COPY.sending : APPEAL_COPY.button;
  const noticeText = notice === null || notice.kind === 'contract' ? null : notice.kind === 'declined' ? NOTICE_TEXT.declined : appealRefusalText(notice.post);
  const contractWords = notice?.kind === 'contract' ? refusalWords('contract') : null;

  return (
    <div className={styles.appeal} data-appeal="form">
      <p className={styles.appealLabel}>{APPEAL_COPY.formLabel}</p>
      <p className={styles.appealLine}>{APPEAL_COPY.formLine}</p>
      <div className={styles.appealRow}>
        <div className={styles.appealField}>
          <div className={styles.appealControl}>
            <input
              className={styles.appealInput}
              type="text"
              value={text}
              maxLength={APPEAL_MAX_CHARS}
              placeholder={APPEAL_COPY.placeholder}
              aria-label={APPEAL_COPY.placeholder}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              data-appeal-input
            />
          </div>
          <div className={styles.appealMeta}>
            {warning !== null ? (
              <p className={styles.appealWarning} role="alert" data-appeal-unplain>
                {warning}
              </p>
            ) : (
              <span />
            )}
            {text.length >= APPEAL_COUNTER_FROM ? (
              <p className={styles.appealCounter} data-appeal-counter>{`${text.length} of ${APPEAL_MAX_CHARS}`}</p>
            ) : null}
          </div>
        </div>
        <button type="button" className={styles.secondary} disabled={!appealSendable(text) || busy} onClick={() => void onAppeal()} data-appeal-send>
          {label}
        </button>
      </div>
      {contractWords === null ? null : (
        <div data-appeal-notice="contract">
          <p className={styles.appealRefusalHeading}>{contractWords.heading}</p>
          <p className={styles.notice}>{contractWords.body}</p>
        </div>
      )}
      {noticeText === null ? null : (
        <p className={styles.notice} role="alert" data-appeal-notice={notice?.kind === 'post' ? notice.post.kind : notice?.kind}>
          {noticeText}
        </p>
      )}
      {notice?.kind === 'post' && notice.post.kind === 'unreachable' ? (
        <button type="button" className={styles.quiet} onClick={onRetry} data-appeal-retry>
          <span className={styles.quietLabel}>Try again</span>
        </button>
      ) : null}
      <p className={styles.appealSmall}>{APPEAL_COPY.privacy}</p>
    </div>
  );
}
