import Link from 'next/link';
import summary from '@/public/replay/robo/summary.json';
import { heroFacts } from '@/lib/replay/derive';
import { formatInt, formatUsd } from '@/lib/format';
import { Drop } from '../Drop';
import { SiteNav } from '../site/SiteNav';
import { Credits } from '../site/SiteFooter';
import { CheckField } from './CheckField';
import { HeroStage } from './HeroStage';
import styles from './hero.module.css';

export function Hero() {
  const { sharePct, heldTotal, keptUsd, priceText } = heroFacts(summary);
  const { farmKey } = summary;
  const headline = `Farm wallets claimed ${sharePct}% of this airdrop. Thuli holds them back before you pay, with a reason for every wallet.`;

  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.glow} aria-hidden="true" />
      <HeroStage groups={summary.groups} keptUsd={keptUsd} heldTotal={heldTotal} />
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.topScrim} aria-hidden="true" />
      <SiteNav mode="overlay" />
      <div className={styles.meta}>
        <span className={styles.metaItem}>BASED ON A REAL AIRDROP</span>
        <Drop width={6} className={styles.metaMark} />
        <span className={`${styles.metaItem} ${styles.metaMiddle}`}>ROBO ON ETHEREUM</span>
        <Drop width={6} className={`${styles.metaMark} ${styles.metaMiddle}`} />
        <span className={styles.metaItem}>{formatInt(summary.wallets)} CLAIM WALLETS</span>
      </div>
      <div className={styles.copy}>
        <div className={styles.counter}>
          <p className={styles.counterLabel}>
            <span className={styles.counterLabelLine}>HELD BACK FROM FARM WALLETS</span>
            <span className={styles.counterLabelLine}>IN A REPLAY. NO MONEY MOVED.</span>
          </p>
          <div className={styles.counterValue}>
            <p className={styles.counterNumber} data-hero-counter-number aria-hidden="true">
              {formatUsd(keptUsd)}
            </p>
            <span className={styles.visuallyHidden}>{formatUsd(keptUsd)} held back from farm wallets, in a replay</span>
          </div>
          <p className={styles.counterStats}>
            <span className={styles.counterStat}>
              {formatInt(farmKey.held)} of {formatInt(farmKey.wallets)} farm wallets held
            </span>
            <Drop width={6} className={styles.statMark} />
            <span className={styles.counterStat}>
              {formatInt(farmKey.families.fullyHeld)} of {formatInt(farmKey.families.total)} families held whole
            </span>
          </p>
          <p className={styles.counterNote}>Valued at the claim-day price, {priceText} per ROBO.</p>
        </div>
        <h1 id="hero-title" className={styles.heading} aria-label={headline}>
          <span className={styles.lead} aria-hidden="true">
            Farm wallets claimed <span className={styles.leadShare}>{sharePct}%</span> of this airdrop.
          </span>
          <span className={styles.title} aria-hidden="true">
            {['T', 'H', 'U', 'L', 'I'].map((letter) => (
              <span key={letter} className={styles.letter}>
                {letter}
              </span>
            ))}
          </span>
          <span className={styles.tail} aria-hidden="true">
            holds them back before you pay, with a reason for every wallet.
          </span>
        </h1>
        <div className={styles.cta}>
          <Link href="/replay" prefetch={false} className={styles.primary}>
            <svg className={styles.play} width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
              <path d="M0 0L10 6L0 12Z" fill="currentColor" />
            </svg>
            Watch the replay
          </Link>
          <CheckField />
        </div>
        <Credits className={styles.credits} />
      </div>
    </section>
  );
}
