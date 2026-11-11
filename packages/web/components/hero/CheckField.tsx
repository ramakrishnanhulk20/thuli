'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import styles from './hero.module.css';

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const ERROR_TEXT = 'That is not a wallet address. It starts with 0x and has 42 characters.';

export function CheckField() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);

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
        placeholder="0x… paste any wallet"
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
