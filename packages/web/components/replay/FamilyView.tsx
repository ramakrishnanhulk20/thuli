'use client';

import { formatInt, formatUsd } from '@/lib/format';
import { shortAddress } from '@/lib/explorer';
import { loadGroup, useLoaded } from '@/lib/replay/client';
import { OUTCOME_STYLES, type GroupFile } from '@/lib/replay/replayTypes';
import styles from './replay.module.css';

export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.quiet} ${styles.back}`} onClick={onClick}>
      <svg className={styles.backArrow} width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
        <path d="M11 5H1M5 1L1 5L5 9" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      <span className={styles.quietLabel}>{label}</span>
    </button>
  );
}

export function LoadingRows({ what }: { what: string }) {
  return (
    <div className={styles.skeletons} role="status">
      <span className={styles.srOnly}>{`Loading the ${what}`}</span>
      <div className={styles.skeleton} aria-hidden="true" />
      <div className={styles.skeleton} aria-hidden="true" />
      <div className={styles.skeleton} aria-hidden="true" />
    </div>
  );
}

export function LoadFailure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className={styles.failure}>
      <p>{text}</p>
      <button type="button" className={styles.quiet} onClick={onRetry}>
        <span className={styles.quietLabel}>Try again</span>
      </button>
    </div>
  );
}

interface FamilyViewProps {
  index: number;
  usdPerRobo: number;
  onBack: () => void;
  onOpenWallet: (address: string) => void;
}

function Members({ file, onOpenWallet }: { file: GroupFile; onOpenWallet: (address: string) => void }) {
  return (
    <div className={styles.members}>
      {file.members.map((member) => {
        const outcome = OUTCOME_STYLES[member.outcome];
        return (
          <button
            key={member.address}
            type="button"
            className={styles.member}
            data-member-row={member.address}
            onClick={() => onOpenWallet(member.address)}
          >
            <span className={styles.memberAddress}>{shortAddress(member.address)}</span>
            <span className={`${styles.memberOutcome} ${styles[outcome.name]}`}>
              <span className={styles.dot} aria-hidden="true" />
              {outcome.word}
            </span>
            <span className={styles.memberRule}>{member.rule}</span>
            <span className={styles.memberRobo}>{formatInt(member.robo)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FamilyView({ index, usdPerRobo, onBack, onOpenWallet }: FamilyViewProps) {
  const { state, retry } = useLoaded(`group:${index}`, () => loadGroup(index));

  if (state.status !== 'ready') {
    return (
      <>
        <BackLink label="All families" onClick={onBack} />
        {state.status === 'error' ? (
          <LoadFailure text="This family could not be loaded. Try again." onRetry={retry} />
        ) : (
          <LoadingRows what="family" />
        )}
      </>
    );
  }

  const file = state.value;
  const counts = OUTCOME_STYLES.map((outcome) => file.members.filter((member) => member.outcome === outcome.code).length);
  // Held first, then excluded, partial and full.
  const lines = [2, 3, 1, 0]
    .map((code) => ({ outcome: OUTCOME_STYLES[code as 0 | 1 | 2 | 3], count: counts[code] as number }))
    .filter((line) => line.count > 0);

  return (
    <>
      <BackLink label="All families" onClick={onBack} />
      <h2 className={`${styles.heading} ${styles.headingFamily}`}>{`Family of ${formatInt(file.size)} wallets`}</h2>
      <p className={styles.stats}>
        {lines.map((line) => (
          <span key={line.outcome.name} className={styles.stat}>{`${formatInt(line.count)} ${line.outcome.afterCount}`}</span>
        ))}
        <span className={styles.stat}>
          {`${formatInt(file.robo)} ROBO claimed, about ${formatUsd(Math.round(file.robo * usdPerRobo))} at the claim-day price, unrealised`}
        </span>
      </p>
      <p className={styles.familyNote}>
        {"Thuli's code linked these wallets through shared funding or through sweeps to a shared collector. Open any wallet for its own evidence."}
      </p>
      <Members file={file} onOpenWallet={onOpenWallet} />
    </>
  );
}
