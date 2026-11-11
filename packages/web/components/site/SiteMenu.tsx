'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import styles from './site.module.css';

interface NavLink {
  href: string;
  label: string;
}

export function SiteMenu({ links }: { links: NavLink[] }) {
  const [open, setOpen] = useState(false);
  const sheetId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const sheet = sheetRef.current;
    sheet?.querySelector<HTMLElement>('a')?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || sheet === null) return;
      const stops = [buttonRef.current, ...Array.from(sheet.querySelectorAll<HTMLElement>('a'))].filter(
        (stop): stop is HTMLElement => stop !== null,
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!stops.includes(active as HTMLElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    // The button is hidden from 1024px up, so a sheet left open there would have no way to close.
    const wide = window.matchMedia('(min-width: 1024px)');
    const onWide = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener('change', onWide);

    return () => {
      root.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.menuLabel}>{open ? 'Close' : 'Menu'}</span>
      </button>
      {open ? (
        <div ref={sheetRef} id={sheetId} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Site menu" data-lenis-prevent>
          <nav aria-label="Menu" className={styles.sheetNav}>
            {links.map((link, index) => (
              <Link
                key={link.href}
                href={link.href}
                className={styles.sheetLink}
                style={{ '--i': index } as CSSProperties}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
