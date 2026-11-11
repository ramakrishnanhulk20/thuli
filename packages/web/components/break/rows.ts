export type RowId =
  | 'claimOther'
  | 'claimTwice'
  | 'claimMore'
  | 'withdraw'
  | 'postRoot'
  | 'mistyped'
  | 'unpaid'
  | 'forged'
  | 'oversized'
  | 'markup';

export type RowTag = 'VAULT' | 'API' | 'PAGE';

export interface RowCopy {
  id: RowId;
  title: string;
  line: string;
  tag: RowTag;
}

/** The ten attacks in the order they are shown and run. */
export const ROWS: readonly RowCopy[] = [
  { id: 'claimOther', tag: 'VAULT', title: "Claim another wallet's reward", line: 'A wallet that is not on the list asks the vault for the 1 USDC.' },
  { id: 'claimTwice', tag: 'VAULT', title: 'Claim the same reward twice', line: 'The wallet that was already paid asks again with its real proof.' },
  { id: 'claimMore', tag: 'VAULT', title: 'Claim more than the list says', line: 'The listed wallet asks for double its amount.' },
  { id: 'withdraw', tag: 'VAULT', title: "Thuli's own key takes the pool", line: "The key that posts lists tries to withdraw the vault's money." },
  { id: 'postRoot', tag: 'VAULT', title: 'A stranger posts a new list', line: 'An address with no role posts a list that pays itself.' },
  { id: 'mistyped', tag: 'API', title: 'A mistyped address', line: 'One wrong letter in an address must be refused, never quietly accepted.' },
  { id: 'unpaid', tag: 'API', title: 'A paid answer without paying', line: 'Ask the paid route for a screening and send no payment.' },
  { id: 'forged', tag: 'API', title: 'A forged payment', line: 'Send the paid route a payment header that is not a payment.' },
  { id: 'oversized', tag: 'API', title: 'An oversized request', line: 'Send two kilobytes where one is the limit.' },
  { id: 'markup', tag: 'PAGE', title: 'Markup in a reason', line: 'A reason is model text. If it carried a script, it must show as text and do nothing.' },
];
