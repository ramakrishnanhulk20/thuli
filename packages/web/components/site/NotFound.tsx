'use client';

import Link from 'next/link';
import { Drop } from '../Drop';
import { SiteNav } from './SiteNav';
import styles from './notFound.module.css';

const NOT_FOUND_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/replay', label: 'Open the replay' },
  { href: '/check', label: 'Check a wallet' },
];

function ArrowLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} prefetch={false} className={styles.link}>
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </Link>
  );
}

function Label({ children }: { children: string }) {
  return (
    <p className={styles.label}>
      <Drop width={8} className={styles.labelMark} />
      {children}
    </p>
  );
}

/** Any address the site has no page for, and every notFound() call. */
export function NotFound() {
  return (
    <>
      <SiteNav mode="bar" />
      <main className={styles.page} id="not-found">
        <Label>NOT FOUND</Label>
        <h1 className={styles.numeral}>
          404
          <svg className={styles.drop} viewBox="0 0 12 17.2" aria-hidden="true">
            <path d="M6 0C6 0 0 7.2 0 11.2a6 6 0 0 0 12 0C12 7.2 6 0 6 0Z" fill="currentColor" />
          </svg>
        </h1>
        <p className={styles.line}>This drop landed nowhere.</p>
        <p className={styles.body}>The page you asked for does not exist, or it moved.</p>
        <div className={styles.links}>
          {NOT_FOUND_LINKS.map((link) => (
            <ArrowLink key={link.href} href={link.href}>
              {link.label}
            </ArrowLink>
          ))}
        </div>
      </main>
    </>
  );
}

/** What a page that threw shows. It is given the reset function and nothing about the error, so nothing of it can be shown. */
export function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <SiteNav mode="bar" />
      <main className={styles.page} id="error">
        <Label>SOMETHING BROKE</Label>
        <h1 className={styles.heading}>That did not work.</h1>
        <p className={styles.body}>The page hit an error on our side. Nothing you did caused it.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={reset}>
            Try again
          </button>
          <ArrowLink href="/">Home</ArrowLink>
        </div>
      </main>
    </>
  );
}
