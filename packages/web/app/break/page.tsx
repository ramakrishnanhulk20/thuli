import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { BreakPage } from '@/components/break/BreakPage';
import styles from '@/components/break/break.module.css';
import { SiteNav } from '@/components/site/SiteNav';
import { settlementUrl, type ProofFacts } from '@/lib/attacks';
import { loadVaultProof } from '@/lib/vaultProof';
import { SHARE_IMAGE } from '@/lib/siteUrl';

const DESCRIPTION = "Ten real attacks against Thuli's vault and routes, run live from your browser, each one refused.";

export const metadata: Metadata = {
  title: 'Try to break it',
  description: DESCRIPTION,
  openGraph: { title: 'Try to break it', description: DESCRIPTION, images: [SHARE_IMAGE] },
};

/** The settlement of the paid example, read at build from the API's captured answer. */
function paidExampleTransaction(): unknown {
  const file = path.join(process.cwd(), '..', 'api', 'examples', 'paid-screen-response.json');
  const example = JSON.parse(fs.readFileSync(file, 'utf8')) as { payment?: { transaction?: unknown } };
  return example.payment?.transaction;
}

export default function BreakRoute() {
  const record = loadVaultProof();
  const facts: ProofFacts = {
    chainId: record.chainId,
    vault: record.vault,
    token: record.token,
    owner: record.owner,
    agent: record.agent,
    root: record.root,
    perWalletCap: record.perWalletCap,
    paidAccount: record.paid.account,
    paidAmount: record.paid.amount,
    refusedAccount: record.refused.account,
    explorer: record.explorer,
  };

  return (
    <>
      <SiteNav mode="bar" />
      <main id="break" className={styles.page}>
        <div className={styles.column}>
          <BreakPage facts={facts} settlementHref={settlementUrl(record.explorer, paidExampleTransaction())} />
        </div>
      </main>
    </>
  );
}
