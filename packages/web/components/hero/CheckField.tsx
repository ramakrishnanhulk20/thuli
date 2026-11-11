'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './hero.module.css';

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const ERROR_TEXT = 'That is not a wallet address. It starts with 0x and has 42 characters.';

// The short text is what the server sends. The long one needs about 350px of field, so it waits for a screen of 480px or more.
const SHORT_PLACEHOLDER = '0x… wallet address';
const LONG_PLACEHOLDER = '0x… paste any wallet';
const LONG_PLACEHOLDER_QUERY = '(min-width: 480px)';

export function CheckField() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);
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
    if (WALLET.test(value)) {
      router.push(`/check/${value.toLowerCase()}`);
      return;
    }
    setInvalid(true);
    inputRef.current?.focus();
  }

  return (
    <form className={styles.check} onSubmit={onSubmit} noValidate>
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder={roomy ? LONG_PLACEHOLDER : SHORT_PLACEHOLDER}
        aria-label="Wallet address to check"
        aria-invalid={invalid}
        aria-describedby={invalid ? 'check-error' : undefined}
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        maxLength={42}
        onInput={() => setInvalid(false)}
      />
      <button type="submit" className={styles.submit}>
        <span className={styles.submitLabel}>Check</span>
      </button>
      {invalid ? (
        <p id="check-error" className={styles.error} role="alert">
          {ERROR_TEXT}
        </p>
      ) : null}
    </form>
  );
}
