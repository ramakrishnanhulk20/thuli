import campaign from '../campaign/campaign.module.css';

/** A short address or hash that opens on the explorer. With no link to give, it is plain text. */
export function ExplorerLink({ href, children }: { href: string | null; children: string }) {
  if (href === null) return <span className={campaign.none}>{children}</span>;
  return (
    <a className={campaign.tx} href={href} target="_blank" rel="noopener noreferrer">
      <span className={campaign.txText}>{children}</span>
    </a>
  );
}
