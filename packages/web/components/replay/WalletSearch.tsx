'use client';

import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { loadRandomWalletAddress } from '@/lib/replay/client';
import type { SearchError, Selection } from '@/lib/replay/replayTypes';
import styles from './replay.module.css';

const WALLET_INPUT = /^0x[0-9a-fA-F]{40}$/;

// The short text is what the server sends. The long one needs about 350px of field, so it waits for a screen of 480px or more.
const SHORT_PLACEHOLDER = 'Paste a wallet address';
const LONG_PLACEHOLDER = 'Paste a claim wallet address';
const LONG_PLACEHOLDER_QUERY = '(min-width: 480px)';

const ERROR_TEXT: Record<Exclude<SearchError, null>, string> = {
  format: 'That is not a wallet address. It starts with 0x and has 42 characters.',
  absent: 'That address did not claim in this airdrop.',
  load: 'This wallet could not be loaded.',
};

/** What the search needs from the page that owns the URL. Before the page is ready, nothing happens. */
export interface SearchBridge {
  error: SearchError;
  setError: (error: SearchError) => void;
  select: (next: Selection) => void;
}

export const SearchContext = createContext<SearchBridge>({
  error: null,
  setError: () => undefined,
  select: () => undefined,
});

export function WalletSearch() {
  const { error, setError, select } = useContext(SearchContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [roomy, setRoomy] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(LONG_PLACEHOLDER_QUERY);
    const update = () => setRoomy(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = (inputRef.current?.value ?? '').trim();
    if (!WALLET_INPUT.test(value)) {
      setError('format');
      inputRef.current?.focus();
      return;
    }
    setError(null);
    select({ wallet: value.toLowerCase() });
  }

  async function openRandom() {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      select({ wallet: await loadRandomWalletAddress() });
    } catch {
      setError('load');
    } finally {
      setPicking(false);
    }
  }

  return (
    <div>
      <form className={styles.search} onSubmit={onSubmit} noValidate>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder={roomy ? LONG_PLACEHOLDER : SHORT_PLACEHOLDER}
          aria-label="Claim wallet address"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? 'replay-search-error' : undefined}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          onInput={() => setError(null)}
        />
        <button type="submit" className={styles.submit}>
          <span className={styles.submitLabel}>Open</span>
        </button>
        {error !== null ? (
          <p id="replay-search-error" className={styles.error} role="alert">
            {ERROR_TEXT[error]}
          </p>
        ) : null}
      </form>
      <div className={styles.randomRow}>
        <button type="button" className={styles.quiet} onClick={openRandom}>
          <span className={styles.quietLabel}>Open a random wallet</span>
        </button>
      </div>
    </div>
  );
}
