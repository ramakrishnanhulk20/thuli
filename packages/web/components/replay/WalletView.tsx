'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatInt } from '@/lib/format';
import { addressUrl, shortAddress, shortHash, txUrl } from '@/lib/explorer';
import { hopsText, ruleMeaning } from '@/lib/rules';
import { OUTCOME_STYLES, type Loaded, type WalletDetail } from '@/lib/replay/replayTypes';
import type { WebGroup } from '@/lib/replay/types';
import { BackLink, LoadFailure, LoadingRows } from './FamilyView';
import styles from './replay.module.css';

const COPIED_MILLISECONDS = 1500;

interface WalletViewProps {
  address: string;
  /** null inside a ready state means the wallet file holds no such wallet; the page handles that. */
  state: Loaded<WalletDetail | null>;
  groups: WebGroup[];
  onRetry: () => void;
  onBack: (family: number | null) => void;
  onOpenFamily: (family: number) => void;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MILLISECONDS);
  }

  return (
    <button type="button" className={styles.quiet} onClick={copy}>
      <span className={styles.quietLabel}>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function ExternalLink({ href, className, children }: { href: string; className: string | undefined; children: ReactNode }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function AddressLine({ address }: { address: string }) {
  const link = addressUrl(address);
  return (
    <div className={styles.addressRow}>
      <p className={styles.address} data-wallet-address>
        {address}
      </p>
      <div className={styles.actions}>
        <CopyAddress address={address} />
        {link === null ? null : (
          <ExternalLink href={link} className={styles.quiet}>
            <span className={styles.quietLabel}>Etherscan</span>
          </ExternalLink>
        )}
      </div>
    </div>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className={styles.fact} data-fact={name}>
      <dt className={styles.factName}>{name}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

function WhatTheCodeFound({ detail, groups, onOpenFamily }: { detail: WalletDetail; groups: WebGroup[]; onOpenFamily: (family: number) => void }) {
  const { facts, group } = detail;
  const { funder } = facts;
  const funderLink = funder === null ? null : addressUrl(funder.address);
  const family = group >= 0 ? groups[group] : undefined;

  return (
    <dl className={styles.facts}>
      <Fact name="Wallet age">{facts.ageDays === null ? 'not read' : `${formatInt(facts.ageDays)} days at the snapshot`}</Fact>
      <Fact name="Transactions before the snapshot">{facts.txCount === null ? 'not read' : formatInt(facts.txCount)}</Fact>
      <Fact name="Account type">{facts.accountType}</Fact>
      <Fact name="First funder">
        {funder === null ? (
          'none found'
        ) : (
          <>
            {funderLink === null ? (
              <span>{shortAddress(funder.address)}</span>
            ) : (
              <ExternalLink href={funderLink} className={styles.factLink}>
                {shortAddress(funder.address)}
              </ExternalLink>
            )}
            <span>{funder.kind}</span>
          </>
        )}
      </Fact>
      {funder !== null && funder.fanout !== null ? <Fact name="Claim wallets that funder paid">{formatInt(funder.fanout)}</Fact> : null}
      {funder !== null && funder.hops > 0 ? <Fact name="Funding traced back">{hopsText(funder.hops)}</Fact> : null}
      <Fact name="Same-day funding burst">{facts.burstWallets === null ? 'none' : `${formatInt(facts.burstWallets)} wallets`}</Fact>
      <Fact name="Linked family">
        {family === undefined ? (
          'none'
        ) : (
          <button type="button" className={`${styles.quiet} ${styles.factButton}`} onClick={() => onOpenFamily(group)}>
            <span className={styles.quietLabel}>{`Family of ${formatInt(family.size)}`}</span>
          </button>
        )}
      </Fact>
      {facts.sweptToSharedCollector === null ? null : <Fact name="Swept to a shared collector">{facts.sweptToSharedCollector ? 'yes' : 'no'}</Fact>}
      <Fact name="Facts that could not be read">{facts.missing.length === 0 ? 'none' : facts.missing.join(', ')}</Fact>
    </dl>
  );
}

function WalletReport({ detail, groups, onBack, onOpenFamily, address }: { detail: WalletDetail } & Omit<WalletViewProps, 'state' | 'onRetry'>) {
  const outcome = OUTCOME_STYLES[detail.outcome];
  const family = detail.group >= 0 ? groups[detail.group] : undefined;
  const meaning = ruleMeaning(detail.rule);
  const { serv, start } = detail;

  return (
    <>
      <BackLink
        label={family === undefined ? 'All families' : `Family of ${formatInt(family.size)}`}
        onClick={() => onBack(family === undefined ? null : detail.group)}
      />
      <AddressLine address={address} />
      <h2 className={`${styles.banner} ${styles[outcome.name]}`} data-wallet-outcome>
        {outcome.label}
      </h2>
      <p className={styles.bannerMeta}>
        <span>{`SHARE ${detail.shareBps / 100}%`}</span>
        <span>{`${formatInt(detail.robo)} ROBO CLAIMED`}</span>
      </p>

      <h3 className={styles.blockLabel}>Why</h3>
      <div className={styles.ruleLine}>
        <span className={styles.ruleChip} data-wallet-rule>{`RULE ${detail.rule}`}</span>
        {meaning === detail.rule ? null : <p className={styles.ruleMeaning}>{meaning}</p>}
      </div>
      <p className={styles.reason} data-wallet-reason>
        {detail.reason}
      </p>
      <p className={styles.citedLabel}>Cited transactions</p>
      {detail.txs.length === 0 ? (
        <p className={styles.none}>None</p>
      ) : (
        <ul className={styles.txList}>
          {detail.txs.map((hash) => {
            const link = txUrl(hash);
            return (
              <li key={hash}>
                {link === null ? (
                  <span className={styles.tx}>{shortHash(hash)}</span>
                ) : (
                  <ExternalLink href={link} className={styles.tx}>
                    <span className={styles.txText}>{shortHash(hash)}</span>
                  </ExternalLink>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h3 className={styles.blockLabel}>What the code found</h3>
      <WhatTheCodeFound detail={detail} groups={groups} onOpenFamily={onOpenFamily} />

      <h3 className={styles.blockLabel}>How it was decided</h3>
      <div className={styles.decided}>
        <p>{`The code's own checks started at ${start.outcome}, rule ${start.rule}.`}</p>
        <p>{`SERV answered on ${serv.mode === 'v3' ? 'the rules graph' : 'a rulebook call'}${serv.secondAsk ? ', on a second ask' : ''}.`}</p>
        {serv.accepted ? null : <p>{"The answer did not pass Thuli's checks, so the code's decision stands."}</p>}
        {serv.requestId === null ? null : <p className={styles.servRun}>{`SERV RUN ${serv.requestId}`}</p>}
      </div>

      <p className={styles.closing}>This is an assessment of on-chain behaviour from public data. It is not an accusation about a person.</p>
    </>
  );
}

export function WalletView({ address, state, groups, onRetry, onBack, onOpenFamily }: WalletViewProps) {
  if (state.status === 'ready' && state.value !== null) {
    return <WalletReport detail={state.value} address={address} groups={groups} onBack={onBack} onOpenFamily={onOpenFamily} />;
  }
  return (
    <>
      <BackLink label="All families" onClick={() => onBack(null)} />
      {state.status === 'error' ? (
        <LoadFailure text="This wallet could not be loaded." onRetry={onRetry} />
      ) : (
        <LoadingRows what="wallet" />
      )}
    </>
  );
}
