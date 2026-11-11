'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { BASE_SEPOLIA } from '@/lib/contracts';
import { Drop } from '../Drop';
import { NAV_LINKS } from './SiteNav';
import styles from './site.module.css';

const CREDITS = [
  ['A REPLAY OF', 'THE ROBO AIRDROP'],
  ['REASONING BY', 'SERV'],
  ['SECOND OPINION BY', 'REPPO'],
  ['PAID OUT FROM', 'A VAULT ON BASE'],
  ['FARM LIST BY', 'BITQUERY'],
  ['CONTROL GROUP FROM', 'HOP PROTOCOL'],
] as const;

const BUILT_WITH = [
  { href: 'https://www.openserv.ai', label: 'SERV by OpenServ' },
  { href: 'https://docs.reppo.ai', label: 'Reppo' },
  { href: 'https://base.org', label: 'Base' },
];

/** The film billing block, one copy for the hero and the footer. The caller adds its own spacing and motion. */
export function Credits({ className }: { className?: string }) {
  return (
    <ul className={className ? `${styles.credits} ${className}` : styles.credits}>
      {CREDITS.map(([role, name]) => (
        <li key={role}>
          <span className={styles.creditRole}>{role}</span>
          <span className={styles.creditName}>{name}</span>
        </li>
      ))}
    </ul>
  );
}

export function SiteFooter() {
  const pathname = usePathname();
  // The docs have their own page frame and no site footer.
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return null;

  const { factory, explorer } = BASE_SEPOLIA;
  const shortFactory = `${factory.slice(0, 6)}…${factory.slice(-4)}`;

  return (
    <footer className={styles.footer}>
      <motion.p
        className={styles.footerLine}
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      >
        Every drop of an airdrop should land in a real hand.
      </motion.p>
      <p className={styles.footerMeaning}>
        <Drop width={8} className={styles.footerMark} />
        Thuli is Tamil for a drop.
      </p>

      <div className={styles.columns}>
        <div>
          <h2 className={styles.columnLabel}>PRODUCT</h2>
          <ul className={styles.footLinks}>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.footLink}>
                  <span className={styles.footLinkLabel}>{link.footerLabel ?? link.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={styles.columnLabel}>ON CHAIN</h2>
          <ul className={styles.footLinks}>
            <li>
              <a href={`${explorer}/address/${factory}`} target="_blank" rel="noopener noreferrer" className={styles.footLink}>
                <span className={styles.footLinkLabel}>Vault factory on Base Sepolia</span>
                <span className={styles.footAddress}>{shortFactory}</span>
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h2 className={styles.columnLabel}>BUILT WITH</h2>
          <ul className={styles.footLinks}>
            {BUILT_WITH.map((link) => (
              <li key={link.href}>
                <a href={link.href} target="_blank" rel="noopener noreferrer" className={styles.footLink}>
                  <span className={styles.footLinkLabel}>{link.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Credits className={styles.footerCredits} />

      <div className={styles.footerBase}>
        <p>Replay figures come from past chain data. No money moved.</p>
        <p>© 2026 Thuli</p>
      </div>
    </footer>
  );
}
