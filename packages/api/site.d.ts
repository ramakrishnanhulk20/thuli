// The website's one entry into this package, src/site.ts. The site's TypeScript settings stop at this declaration, so
// they never check this package's sources, which import with .ts extensions the site does not allow. A test in
// test/site.test.ts fails to compile if the two ever disagree.

/** Files the API reads from the repository, carried by the caller because a bundled server cannot find them by path. */
export interface SiteFiles {
  /** The rulebook text. */
  readonly rulebook: string;
  /** Every migration of the store, by file name, such as 001_init.sql. */
  readonly migrations: Readonly<Record<string, string>>;
}

export interface SiteApi {
  /** Answers one request to /api/x402/*, /api/check* or /api/campaigns/*, handed to the API unchanged. Never rejects. */
  fetch(request: Request): Promise<Response>;
}

/**
 * The paid and free API for one server copy. Every request answers 503 {busy: true} when a setting is missing, malformed
 * or forbidden, or when production lacks DATABASE_URL or TRUSTED_CLIENT_HEADER. The campaign routes share its database.
 */
export declare function siteApi(env: Record<string, string | undefined>, files: SiteFiles): SiteApi;
