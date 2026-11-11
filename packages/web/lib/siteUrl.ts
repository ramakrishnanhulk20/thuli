/** Pages the sitemap lists besides the docs. The lab pages and the per-address pages are never listed. */
export const SITEMAP_PAGES = ['/', '/replay', '/check', '/versions', '/break'] as const;

/** Paths robots.txt keeps crawlers out of. /lab covers every lab page, /check/ only the per-address pages. */
export const ROBOTS_DISALLOWED = ['/lab', '/api', '/check/'] as const;

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The origin the site is served from, never ending in a slash. PUBLIC_ORIGIN wins, then the production host Vercel
 * names (which comes without a scheme), then the local dev server.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const origin = env.PUBLIC_ORIGIN?.trim();
  if (origin) return withoutTrailingSlash(origin);
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return withoutTrailingSlash(`https://${vercel}`);
  return 'http://localhost:3000';
}

/**
 * The share picture app/opengraph-image.tsx draws, as a page names it. A page that sets its own openGraph has to name
 * the picture, because the layout's openGraph is replaced by the page's rather than merged with it.
 */
export const SHARE_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'Thuli: airdrop rewards for real users, not farms',
};
