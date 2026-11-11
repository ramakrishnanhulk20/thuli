import { Drop } from '../Drop';
import { ArrowLink } from './ArrowLink';
import styles from './campaign.module.css';

/** What the page shows when there is no campaign to show: no wallet button, nothing else. */
export function NoCampaign() {
  return (
    <>
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        LIVE CAMPAIGN
      </p>
      <h1 className={styles.title}>No campaign is open right now.</h1>
      <p className={styles.body}>When one opens, this page shows every wallet that asks and every decision, as they happen.</p>
      <div className={styles.links}>
        <ArrowLink href="/replay">Open the replay</ArrowLink>
        <ArrowLink href="/break">Try to break it</ArrowLink>
      </div>
    </>
  );
}
