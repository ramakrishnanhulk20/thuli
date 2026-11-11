import summary from '@/public/replay/robo/summary.json';
import { heroFacts } from '@/lib/replay/derive';
import { Drop } from '../Drop';
import styles from './labNotes.module.css';

const TOKENS = [
  ['night', '#05070b'],
  ['night-2', '#0b0f16'],
  ['line', '#1c2430'],
  ['ink', '#efeae0'],
  ['ink-2', '#a9b0ba'],
  ['ink-3', '#7c8693'],
  ['accent', '#ffb01f'],
  ['full', '#5fe3b3'],
  ['partial', '#7fb2ff'],
  ['hold', '#a78bfa'],
  ['exclude', '#ff5d8f'],
] as const;

const WIDTHS = [75, 100, 125] as const;

const EXAMPLE_ADDRESS = '0x851d044ff4565ccafdbe603d0df20b16de722d30';

export function LabNotes() {
  const { sharePct } = heroFacts(summary);

  return (
    <section className={styles.notes}>
      <p className={styles.label}>
        <Drop width={8} className={styles.mark} />
        LAB NOTES
      </p>

      <h2 className={styles.rowHeading}>Colour</h2>
      <div className={styles.tiles}>
        {TOKENS.map(([name, hex]) => (
          <div key={name}>
            <div className={styles.swatch} style={{ background: hex }} />
            <p className={styles.tokenName}>{name}</p>
            <p className={styles.tokenHex}>{hex}</p>
          </div>
        ))}
      </div>

      <h2 className={styles.rowHeading}>Type</h2>
      {WIDTHS.map((width) => (
        <p key={width} className={styles.display} style={{ fontVariationSettings: `'wdth' ${width}, 'wght' 800` }}>
          Thuli துளி 0123456789
        </p>
      ))}
      <p className={styles.sentence}>
        Farm wallets claimed {sharePct}% of this airdrop. Thuli holds them back before you pay, with a reason for every wallet.
      </p>
      <p className={styles.address}>{EXAMPLE_ADDRESS}</p>
    </section>
  );
}
