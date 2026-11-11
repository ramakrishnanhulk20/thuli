import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './campaign.module.css';

/** The site's text link: a label with an underline that draws on hover, and a small arrow. */
export function ArrowLink({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  const inner = (
    <>
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={styles.link}>
      {inner}
    </Link>
  );
}
