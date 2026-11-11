'use client';

import { useId, type ReactNode } from 'react';
import { THULI_AGENT } from '@/lib/contracts';
import { explorerAddressUrl, coverageLine, DELAY_CHOICES, formatAmount, readAmount, REASONS, USDC_BASE_SEPOLIA, type Reason, type TermsCheck, type TermsForm } from '@/lib/owner';
import { shortAddress } from '@/lib/explorer';
import { ExplorerLink } from './ExplorerLink';
import styles from './owner.module.css';

interface TermsEditorProps {
  form: TermsForm;
  onChange: (next: TermsForm) => void;
  check: TermsCheck;
  /** The wallet's USDC as the chain says, or null before it has been read. */
  balance: bigint | null;
  noEth: boolean;
  checking: boolean;
  /** What the vault refused when the simulated call ran, if it did. */
  reason: Reason | null;
  onSubmit: () => void;
}

function Field({ id, label, children, help, error }: { id: string; label: string; children: ReactNode; help?: ReactNode; error?: string }) {
  return (
    <div data-field={id}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children}
      {error === undefined ? help : (
        <p className={styles.fieldError} id={`${id}-note`} data-field-error={id}>
          {error}
        </p>
      )}
    </div>
  );
}

function Helper({ id, children, second = false }: { id: string; children: ReactNode; second?: boolean }) {
  return (
    <p className={second ? `${styles.helper} ${styles.helperSecond}` : styles.helper} id={id}>
      {children}
    </p>
  );
}

/** Row 01: the five terms, each with its helper line, and the button that simulates the creation. */
export function TermsEditor({ form, onChange, check, balance, noEth, checking, reason, onSubmit }: TermsEditorProps) {
  const base = useId();
  const id = (name: string) => `${base}-${name}`;
  const cap = readAmount(form.cap);
  const deposit = readAmount(form.deposit);
  const covers = cap.kind === 'ok' && cap.units > 0n && deposit.kind === 'ok' && deposit.units >= cap.units ? coverageLine(cap.units, deposit.units) : null;
  const controlClass = (error: string | undefined) => (error === undefined ? styles.control : `${styles.control} ${styles.controlError}`);

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (check.terms !== null && !checking) onSubmit();
      }}
    >
      <div data-field="token">
        <span className={styles.fieldLabel}>REWARD TOKEN</span>
        <p className={styles.fixed}>
          <span>USDC on Base Sepolia</span>
          <ExplorerLink href={explorerAddressUrl(USDC_BASE_SEPOLIA)}>{shortAddress(USDC_BASE_SEPOLIA)}</ExplorerLink>
        </p>
      </div>

      <Field
        id={id('cap')}
        label="MOST ONE WALLET CAN RECEIVE"
        error={check.errors.cap}
        help={<Helper id={`${id('cap')}-note`}>The vault refuses any claim above this, whatever list is posted.</Helper>}
      >
        <div className={controlClass(check.errors.cap)}>
          <input
            id={id('cap')}
            className={styles.input}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={form.cap}
            aria-invalid={check.errors.cap !== undefined}
            aria-describedby={`${id('cap')}-note`}
            onChange={(event) => onChange({ ...form, cap: event.target.value })}
          />
          <span className={styles.suffix}>USDC</span>
        </div>
      </Field>

      <Field
        id={id('deposit')}
        label="TOTAL TO DEPOSIT"
        error={check.errors.deposit}
        help={covers === null ? null : <Helper id={`${id('deposit')}-note`}>{covers}</Helper>}
      >
        <div className={controlClass(check.errors.deposit)}>
          <input
            id={id('deposit')}
            className={styles.input}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={form.deposit}
            aria-invalid={check.errors.deposit !== undefined}
            aria-describedby={`${id('deposit')}-note ${id('deposit')}-held`}
            onChange={(event) => onChange({ ...form, deposit: event.target.value })}
          />
          <span className={styles.suffix}>USDC</span>
        </div>
        {balance === null ? null : (
          <Helper id={`${id('deposit')}-held`} second>
            {`This wallet holds ${formatAmount(balance)} USDC.`}
          </Helper>
        )}
      </Field>

      <Field
        id={id('end')}
        label="CLAIMS END"
        error={check.errors.end}
        help={<Helper id={`${id('end')}-note`}>After this you can take back what is left.</Helper>}
      >
        <div className={controlClass(check.errors.end)}>
          <input
            id={id('end')}
            className={styles.input}
            type="date"
            value={form.endDate}
            aria-invalid={check.errors.end !== undefined}
            aria-describedby={`${id('end')}-note`}
            onChange={(event) => onChange({ ...form, endDate: event.target.value })}
          />
        </div>
      </Field>

      <Field id={id('delay')} label="WAITING TIME BEFORE A LIST PAYS" help={<Helper id={`${id('delay')}-note`}>Your window to cancel a bad list.</Helper>}>
        <div className={styles.control}>
          <select
            id={id('delay')}
            className={styles.input}
            value={form.delay}
            aria-describedby={`${id('delay')}-note`}
            onChange={(event) => onChange({ ...form, delay: Number(event.target.value) })}
          >
            {DELAY_CHOICES.map((choice) => (
              <option key={choice.seconds} value={choice.seconds}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <div data-field="agent">
        <span className={styles.fieldLabel}>AGENT</span>
        <p className={styles.fixed}>
          <ExplorerLink href={explorerAddressUrl(THULI_AGENT)}>{shortAddress(THULI_AGENT)}</ExplorerLink>
        </p>
        <Helper id={`${base}-agent-note`}>The only address that may post lists.</Helper>
      </div>

      <div>
        {noEth ? (
          <p className={`${styles.reason} ${styles.reasonAbove}`} data-no-gas>
            {REASONS.noGas}
          </p>
        ) : null}
        <button type="submit" className={`${styles.primary} ${styles.submit}`} disabled={check.terms === null || checking} data-create>
          Create the vault
        </button>
        {reason === null ? null : (
          <p className={styles.reason} role="alert" data-reason>
            {reason}
          </p>
        )}
      </div>
    </form>
  );
}
