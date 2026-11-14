'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isReplayAddress } from '@/lib/explorer';
import { loadWallet, useLoaded } from '@/lib/replay/client';
import type { SearchError, Selection } from '@/lib/replay/replayTypes';
import type { WebGroup } from '@/lib/replay/types';
import { FamilyIndex } from './FamilyIndex';
import { FamilyMap } from './FamilyMap';
import { FamilyView } from './FamilyView';
import { SearchContext, type SearchBridge } from './WalletSearch';
import { WalletView } from './WalletView';
import styles from './replay.module.css';

const REPLAY_PATH = '/replay';
const VIEW_KEY_INDEX = 'index';

function keyOf(next: Selection): string {
  if (next === null) return VIEW_KEY_INDEX;
  return 'family' in next ? `family:${next.family}` : `wallet:${next.wallet}`;
}
const WHOLE_NUMBER = /^(0|[1-9][0-9]*)$/;

type View = { kind: 'index' } | { kind: 'family'; index: number } | { kind: 'wallet'; address: string };

interface ReadResult {
  view: View;
  /** The address bar the page should have, when the one it has carries a value to drop. */
  cleaned: string | null;
}

function pathWith(params: URLSearchParams): string {
  const text = params.toString();
  return text === '' ? REPLAY_PATH : `${REPLAY_PATH}?${text}`;
}

// A wallet beats a family when both are given. A value that does not check out is ignored and dropped from the address.
function readView(params: URLSearchParams, familyCount: number): ReadResult {
  const rawWallet = params.get('wallet');
  const rawFamily = params.get('family');
  const wallet = rawWallet !== null && isReplayAddress(rawWallet) ? rawWallet : null;
  const family = rawFamily !== null && WHOLE_NUMBER.test(rawFamily) && Number(rawFamily) < familyCount ? Number(rawFamily) : null;

  const kept = new URLSearchParams(params);
  if (wallet === null) kept.delete('wallet');
  if (family === null || wallet !== null) kept.delete('family');
  const cleaned = kept.toString() === params.toString() ? null : pathWith(kept);

  if (wallet !== null) return { view: { kind: 'wallet', address: wallet }, cleaned };
  if (family !== null) return { view: { kind: 'family', index: family }, cleaned };
  return { view: { kind: 'index' }, cleaned };
}

interface ReplayExplorerProps {
  /** The panel head, built on the server. */
  head: ReactNode;
  groups: WebGroup[];
  usdPerRobo: number;
  /** The whole replay run: how many wallets it screened and what that cost in SERV credit. */
  run: { wallets: number; spentCents: number };
  /** The size of the public farm list the replay is scored against, which is not the list of linked families. */
  farmKey: { families: number; wallets: number };
}

export function ReplayExplorer({ head, groups, usdPerRobo, run, farmKey }: ReplayExplorerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [searchError, setSearchError] = useState<SearchError>(null);
  const [listHover, setListHover] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownKey = useRef(VIEW_KEY_INDEX);
  const scrollAfterChange = useRef(false);

  const { view, cleaned } = useMemo(() => readView(new URLSearchParams(params.toString()), groups.length), [params, groups.length]);
  const walletAddress = view.kind === 'wallet' ? view.address : null;
  const { state: walletState, retry: retryWallet } = useLoaded(walletAddress, () => loadWallet(walletAddress as string));

  // A choice the visitor makes may bring the panel into view once it shows. A redirect the page makes itself never does.
  const select = useCallback(
    (next: Selection, scroll = true) => {
      scrollAfterChange.current = scroll && keyOf(next) !== shownKey.current;
      const target = new URLSearchParams(params.toString());
      target.delete('family');
      target.delete('wallet');
      if (next !== null && 'family' in next) target.set('family', String(next.family));
      if (next !== null && 'wallet' in next) target.set('wallet', next.wallet);
      setSearchError(null);
      router.replace(pathWith(target), { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    if (cleaned !== null) router.replace(cleaned, { scroll: false });
  }, [cleaned, router]);

  const walletMissing = walletState.status === 'ready' && walletState.value === null;
  useEffect(() => {
    if (!walletMissing) return;
    select(null, false);
    setSearchError('absent');
  }, [walletMissing, select]);

  const bridge = useMemo<SearchBridge>(() => ({ error: searchError, setError: setSearchError, select }), [searchError, select]);

  const detail = walletState.status === 'ready' ? walletState.value : null;
  const selectedFamily = view.kind === 'family' ? view.index : detail !== null && detail.group >= 0 ? detail.group : null;
  const selectedWallet = detail === null ? null : detail.i;
  const walletHasNoFamily = detail !== null && detail.group < 0;

  const bodyKey = view.kind === 'index' ? VIEW_KEY_INDEX : view.kind === 'family' ? `family:${view.index}` : `wallet:${view.address}`;

  useEffect(() => {
    shownKey.current = bodyKey;
  }, [bodyKey]);

  // A wallet waits for its file, so a wallet that turns out not to exist never pulls the page away from the search error.
  const panelReady = view.kind !== 'wallet' || walletState.status === 'error' || (walletState.status === 'ready' && walletState.value !== null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!panelReady || !scrollAfterChange.current || body === null) return;
    scrollAfterChange.current = false;
    const top = body.getBoundingClientRect().top;
    if (top >= 0 && top <= window.innerHeight / 2) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.scrollIntoView({ block: 'start', behavior: reduced ? 'instant' : 'smooth' });
  }, [bodyKey, panelReady]);

  let body: ReactNode;
  if (view.kind === 'family') {
    body = (
      <FamilyView
        index={view.index}
        usdPerRobo={usdPerRobo}
        onBack={() => select(null)}
        onOpenWallet={(address) => select({ wallet: address })}
      />
    );
  } else if (view.kind === 'wallet') {
    body = (
      <WalletView
        address={view.address}
        state={walletState}
        groups={groups}
        run={run}
        onRetry={retryWallet}
        onBack={(family) => select(family === null ? null : { family })}
        onOpenFamily={(family) => select({ family })}
      />
    );
  } else {
    body = <FamilyIndex groups={groups} farmKey={farmKey} onSelect={(index) => select({ family: index })} onHover={setListHover} />;
  }

  return (
    <SearchContext.Provider value={bridge}>
      <div className={styles.page}>
        {head}
        <FamilyMap
          groups={groups}
          selectedFamily={selectedFamily}
          selectedWallet={selectedWallet}
          highlightFamily={listHover}
          walletHasNoFamily={walletHasNoFamily}
          onSelectFamily={(group) => select({ family: group })}
        />
        <div ref={bodyRef} className={styles.body} data-panel-body>
          <div key={bodyKey} className={styles.bodyIn} data-panel={view.kind}>
            {body}
          </div>
        </div>
      </div>
    </SearchContext.Provider>
  );
}
