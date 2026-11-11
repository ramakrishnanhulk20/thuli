const RULE_MEANINGS = new Map<string, string>([
  ['A1', 'A fact about this wallet could not be read, so it waits for a person.'],
  ['A2', 'The claimant is a contract, not a personal wallet.'],
  ['A3', "This wallet's own transfers link it to a group of claim wallets that sweep to one collector."],
  ['A4', 'The wallet belongs to a linked group of claim wallets.'],
  ['A5', 'One ordinary wallet funded this wallet and many other claim wallets.'],
  ['A6', 'It shares an exchange deposit address with other claimants.'],
  ['A7', 'Its claim was paid to a different address.'],
  ['A8', 'A new or little-used wallet, or one funded in a same-day burst from an exchange. It gets a partial reward.'],
  ['A9', 'Nothing in the record points to a farm.'],
  ['B1', 'The model held the wallet because a traced funding trail leads to a shared source.'],
  ['B2', 'The model raised a held wallet because its shared links look like ordinary infrastructure.'],
]);

/** What a rule code means in plain words. A code the table does not know comes back as the code alone. */
export function ruleMeaning(code: string): string {
  return RULE_MEANINGS.get(code) ?? code;
}

/** How far back the first funder's trail was traced, with the noun in the right number. */
export function hopsText(hops: number): string {
  return hops === 1 ? '1 hop' : `${hops} hops`;
}
