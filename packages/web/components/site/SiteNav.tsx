'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Drop } from '../Drop';
import { SiteMenu } from './SiteMenu';
import styles from './site.module.css';

export const NAV_LINKS = [
  { href: '/replay', label: 'Replay' },
  { href: '/campaign', label: 'Campaign' },
  { href: '/check', label: 'Check a wallet' },
  { href: '/versions', label: 'Versions' },
  { href: '/break', label: 'Break it', footerLabel: 'Try to break it' },
  { href: '/docs', label: 'Docs' },
];

const SCROLL_STEP = 8;
const HERO_LEAD = 80;

interface SiteNavProps {
  mode: 'overlay' | 'bar';
  revealAfterHero?: boolean;
}

export function SiteNav({ mode, revealAfterHero = false }: SiteNavProps) {
  const headerRef = useRef<HTMLElement>(null);
  const reveal = mode === 'bar' && revealAfterHero;

  useEffect(() => {
    const header = headerRef.current;
    if (!reveal || header === null) return;
    const hero = document.getElementById('hero-title')?.closest('section') ?? null;
    let heroHeight = hero?.offsetHeight ?? window.innerHeight;
    const watcher = hero === null ? null : new ResizeObserver(() => (heroHeight = hero.offsetHeight));
    if (hero !== null) watcher?.observe(hero);

    let anchor = window.scrollY;
    let shown = false;
    const show = (next: boolean) => {
      if (next === shown) return;
      shown = next;
      header.setAttribute('data-shown', String(next));
    };
    // The anchor moves only after a step of more than 8px, so slow smooth scrolling still counts as a direction.
    const onScroll = () => {
      const y = window.scrollY;
      if (y > anchor + SCROLL_STEP) {
        anchor = y;
        show(false);
      } else if (y < anchor - SCROLL_STEP) {
        anchor = y;
        show(y > heroHeight - HERO_LEAD);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      watcher?.disconnect();
      header.setAttribute('data-shown', 'false');
    };
  }, [reveal]);

  const header = (
    <header
      ref={headerRef}
      className={`${styles.nav} ${mode === 'bar' ? styles.bar : styles.overlay}`}
      data-shown={reveal ? 'false' : undefined}
    >
      <Link href="/" className={styles.wordmark}>
        <Drop width={10} className={styles.wordmarkMark} />
        <span className={styles.wordmarkName}>THULI</span>
        <span className={styles.wordmarkTamil}>துளி</span>
      </Link>
      <nav className={styles.links} aria-label={mode === 'bar' ? 'Site' : 'Main'}>
        {NAV_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={styles.link}>
            {link.label}
          </Link>
        ))}
      </nav>
      <SiteMenu links={NAV_LINKS} />
    </header>
  );

  if (mode === 'bar' && !reveal) {
    return (
      <>
        <div className={styles.spacer} aria-hidden="true" />
        {header}
      </>
    );
  }
  return header;
}
