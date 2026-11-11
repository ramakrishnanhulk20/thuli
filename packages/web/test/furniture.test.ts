// Covers siteUrl, robots.ts and sitemap.ts, the descriptions and Open Graph fields as written in the page files, the copy
// of the 404 and error blocks, and the licence beside every font file. It does not cover rendering, the share image, the
// status codes, the drop's fall or any link in a browser; those need a built page.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import robots from '../app/robots';
import sitemap from '../app/sitemap';
import { ROBOTS_DISALLOWED, SHARE_IMAGE, SITEMAP_PAGES, siteUrl } from '../lib/siteUrl';

// The docs source needs Fumadocs' generated files, so the test hands the sitemap the pages meta.json lists.
vi.mock('../lib/source', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const dir = nodePath.join(import.meta.dirname, '..', 'content', 'docs');
  const meta = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'meta.json'), 'utf8')) as { pages: string[] };
  const urls = meta.pages.filter((entry) => !entry.startsWith('---')).map((slug) => (slug === 'index' ? '/docs' : `/docs/${slug}`));
  return { source: { getPages: () => urls.map((url) => ({ url })) } };
});

const web = path.join(import.meta.dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(web, ...parts), 'utf8');

describe('siteUrl', () => {
  it('uses PUBLIC_ORIGIN first', () => {
    expect(siteUrl({ PUBLIC_ORIGIN: 'https://thuli.example', VERCEL_PROJECT_PRODUCTION_URL: 'thuli.vercel.app' })).toBe('https://thuli.example');
  });

  it('then the Vercel production host, which comes without a scheme', () => {
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'thuli.vercel.app' })).toBe('https://thuli.vercel.app');
  });

  it('then the local dev server', () => {
    expect(siteUrl({})).toBe('http://localhost:3000');
    expect(siteUrl({ PUBLIC_ORIGIN: '', VERCEL_PROJECT_PRODUCTION_URL: '' })).toBe('http://localhost:3000');
    expect(siteUrl({ PUBLIC_ORIGIN: '   ' })).toBe('http://localhost:3000');
  });

  it('never ends in a slash', () => {
    expect(siteUrl({ PUBLIC_ORIGIN: 'https://thuli.example/' })).toBe('https://thuli.example');
    expect(siteUrl({ PUBLIC_ORIGIN: 'https://thuli.example///' })).toBe('https://thuli.example');
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'thuli.vercel.app/' })).toBe('https://thuli.vercel.app');
    expect(siteUrl({})).not.toMatch(/\/$/);
  });
});

describe('robots', () => {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

  it('allows everything except /lab, /api and /check/', () => {
    expect(rules?.userAgent).toBe('*');
    expect(rules?.allow).toBe('/');
    expect(rules?.disallow).toEqual(['/lab', '/api', '/check/']);
    expect([...ROBOTS_DISALLOWED]).toEqual(['/lab', '/api', '/check/']);
  });

  it('points at the sitemap on the site origin', () => {
    expect(result.sitemap).toBe(`${siteUrl()}/sitemap.xml`);
  });
});

describe('sitemap', () => {
  const entries = sitemap();
  const paths = entries.map((entry) => entry.url.replace(siteUrl(), ''));

  it('lists the six pages and the seventeen docs pages, nothing else', () => {
    const docs = JSON.parse(read('content', 'docs', 'meta.json')) as { pages: string[] };
    const slugs = docs.pages.filter((entry) => !entry.startsWith('---'));
    expect(slugs).toHaveLength(17);
    expect(paths.slice(0, 6)).toEqual(['/', '/replay', '/campaign', '/check', '/versions', '/break']);
    expect(paths.slice(6)).toEqual(slugs.map((slug) => (slug === 'index' ? '/docs' : `/docs/${slug}`)));
    expect(entries).toHaveLength(23);
    expect([...SITEMAP_PAGES]).toEqual(['/', '/replay', '/campaign', '/check', '/versions', '/break']);
  });

  it('never lists a lab page, an api route or a per-address page', () => {
    for (const entry of paths) {
      expect(entry.startsWith('/lab'), entry).toBe(false);
      expect(entry.startsWith('/api'), entry).toBe(false);
      expect(entry.startsWith('/check/'), entry).toBe(false);
    }
    expect(paths).toContain('/check');
  });

  it('writes every address with the site origin and lists none twice', () => {
    for (const entry of entries) expect(entry.url.startsWith(siteUrl())).toBe(true);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
  });
});

describe('descriptions and Open Graph fields in the page files', () => {
  const described = [
    ['app/replay/page.tsx', "Every wallet that claimed the ROBO airdrop, with Thuli's decision, its reason and the transactions behind it."],
    ['app/versions/page.tsx', 'Each Thuli rulebook version scored the same way, with what changed and what the numbers do not cover.'],
    ['app/check/page.tsx', "Paste any Ethereum address and get Thuli's decision for that one wallet, free, with no sign-in."],
    ['app/break/page.tsx', "Ten real attacks against Thuli's vault and routes, run live from your browser, each one refused."],
  ] as const;

  it('puts each description on its page, with Open Graph fields from the same values', () => {
    for (const [file, description] of described) {
      const text = read(...file.split('/'));
      expect(text, file).toContain(description);
      expect(text, file).toMatch(/description: DESCRIPTION,/);
      expect(text, file).toMatch(/openGraph: \{ title: '[^']+', description: DESCRIPTION, images: \[SHARE_IMAGE\] \}/);
    }
  });

  it('keeps the per-address page out of the index and gives it its description', () => {
    const text = read('app', 'check', '[address]', 'page.tsx');
    expect(text).toContain("Thuli's decision for this wallet, with its reason and what a single check cannot see.");
    expect(text).toContain('robots: { index: false, follow: false }');
    expect(text).not.toContain('openGraph');
  });

  it('gives the home page its own title and description as Open Graph fields', () => {
    const text = read('app', 'page.tsx');
    expect(text).toContain("const TITLE = 'Thuli: airdrop rewards for real users, not farms';");
    expect(text).toContain("const DESCRIPTION = 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.';");
    expect(text).toContain('openGraph: { title: TITLE, description: DESCRIPTION }');
  });

  it('keeps the layout description and sets the base of every absolute address', () => {
    const text = read('app', 'layout.tsx');
    expect(text).toContain("description: 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.'");
    expect(text).toContain('metadataBase: new URL(siteUrl())');
  });

  it('gives every docs page its own front-matter description as the Open Graph description too', () => {
    const text = read('app', 'docs', '[[...slug]]', 'page.tsx');
    expect(text).toContain('const { title, description } = page.data;');
    expect(text).toContain('openGraph: { title, description, images: [SHARE_IMAGE] }');
  });

  it('leaves the lab pages out of the index with no description of their own', () => {
    for (const file of ['app/lab/page.tsx', 'app/lab/vault/page.tsx']) {
      const text = read(...file.split('/'));
      expect(text, file).toContain('robots: { index: false, follow: false }');
      expect(text, file).not.toContain('description');
    }
  });
});

describe('the share image', () => {
  it('is named at the size the image file draws it', () => {
    const image = read('app', 'opengraph-image.tsx');
    expect(SHARE_IMAGE).toMatchObject({ url: '/opengraph-image', width: 1200, height: 630 });
    expect(image).toContain('export const size = { width: 1200, height: 630 };');
    expect(image).toContain(`export const alt = '${SHARE_IMAGE.alt}';`);
    expect(read('app', 'twitter-image.tsx')).toContain("from './opengraph-image'");
  });
});

describe('the 404 and error blocks', () => {
  const block = read('components', 'site', 'NotFound.tsx');

  it('says what the page asks for, and links home, to the replay and to the check page', () => {
    for (const line of ['NOT FOUND', 'This drop landed nowhere.', 'The page you asked for does not exist, or it moved.']) expect(block).toContain(line);
    expect(block).toContain("{ href: '/', label: 'Home' }");
    expect(block).toContain("{ href: '/replay', label: 'Open the replay' }");
    expect(block).toContain("{ href: '/check', label: 'Check a wallet' }");
    expect(block).toContain('404');
  });

  it('says the error copy and offers Try again and Home', () => {
    for (const line of ['SOMETHING BROKE', 'That did not work.', 'The page hit an error on our side. Nothing you did caused it.', 'Try again']) expect(block).toContain(line);
  });

  it('never reads or shows the error that was thrown', () => {
    for (const file of [['components', 'site', 'NotFound.tsx'], ['app', 'error.tsx'], ['app', 'global-error.tsx']]) {
      const text = read(...file);
      expect(text, file.join('/')).not.toMatch(/\.(message|stack|digest)\b/);
      expect(text, file.join('/')).not.toMatch(/\(\s*\{\s*error\b/);
    }
  });

  it('gives the global error page its own html, body, colours and wording, with no site imports', () => {
    const text = read('app', 'global-error.tsx');
    expect(text).toContain('<html lang="en">');
    expect(text).toContain('<body');
    expect(text).toContain("background: '#05070b'");
    expect(text).toContain("color: '#efeae0'");
    for (const line of ['That did not work.', 'The page hit an error on our side. Nothing you did caused it.', 'Try again', 'Home']) expect(text).toContain(line);
    expect(text).not.toMatch(/^import /m);
  });
});

describe('font files', () => {
  it('ships every font with its licence text beside it', () => {
    const dir = path.join(web, 'public', 'fonts');
    const files = fs.readdirSync(dir);
    const fonts = files.filter((name) => /\.(woff2?|ttf|otf)$/i.test(name));
    expect(fonts.length).toBeGreaterThanOrEqual(2);
    const licences = files.filter((name) => /licen[cs]e/i.test(name));
    expect(licences.length).toBeGreaterThanOrEqual(1);
    for (const name of licences) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toContain('SIL OPEN FONT LICENSE');
  });
});
