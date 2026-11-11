import { shortHash, txLink } from '@/lib/explorer';
import { formatUtcMinute, LIST_STATUS_WORDS, newestFirst, type CampaignView } from '@/lib/campaign';
import { Drop } from '../Drop';
import styles from './campaign.module.css';

export function Lists({ campaignId, campaign }: { campaignId: string; campaign: CampaignView }) {
  const lists = newestFirst(campaign.lists);
  return (
    <section className={styles.listsBlock} aria-labelledby="lists-title" data-lists>
      <p className={styles.label} id="lists-title">
        <Drop width={8} className={styles.labelMark} />
        POSTED LISTS
      </p>
      <p className={styles.listsBody}>Each list is public. Anyone can rebuild its root from the file and compare it with the vault.</p>
      {lists.length === 0 ? (
        <p className={styles.empty} data-lists-empty>
          No list has been posted yet.
        </p>
      ) : (
        <ul className={styles.rows}>
          {lists.map((list) => {
            const postLink = list.postTx === null ? null : txLink(campaign.chain, list.postTx);
            return (
              <li key={list.version} className={styles.listRow} data-list={list.version}>
                <span className={styles.listVersion}>{`LIST ${list.version}`}</span>
                <span>{shortHash(list.root)}</span>
                <span className={styles.listDim}>{LIST_STATUS_WORDS[list.status]}</span>
                {list.postTx === null || postLink === null ? null : (
                  <a className={styles.tx} href={postLink} target="_blank" rel="noopener noreferrer">
                    <span className={styles.txText}>{shortHash(list.postTx)}</span>
                  </a>
                )}
                {list.claimableAt === null || list.status === 'sending' ? null : (
                  <span className={styles.listDim}>{`claimable ${formatUtcMinute(list.claimableAt * 1000)}`}</span>
                )}
                <a className={styles.tx} href={`/api/campaigns/${encodeURIComponent(campaignId)}/lists/${list.version}`} target="_blank" rel="noopener noreferrer">
                  <span className={styles.txText}>the list</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
