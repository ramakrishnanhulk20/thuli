// Covers the docs source files: the sidebar order against the files, the front matter, and every internal link against
// the routes in the app folder and the docs set. It does not cover rendering, search, the diagram or any styling; those
// need a built page in a browser.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.join(import.meta.dirname, '..');
const docsDir = path.join(web, 'content', 'docs');
const appDir = path.join(web, 'app');

const meta = JSON.parse(fs.readFileSync(path.join(docsDir, 'meta.json'), 'utf8')) as { pages: string[] };
const listed = meta.pages.filter((entry) => !/^---.*---$/.test(entry));
const files = fs.readdirSync(docsDir).filter((name) => name.endsWith('.mdx')).map((name) => name.replace(/\.mdx$/, ''));

function readPage(slug: string): string {
  return fs.readFileSync(path.join(docsDir, `${slug}.mdx`), 'utf8');
}

function frontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1] as string] = (pair[2] as string).replace(/^["']|["']$/g, '').trim();
  }
  return fields;
}

// Links outside code blocks, in markdown form and in href form.
function internalLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const found = [...prose.matchAll(/\]\((\/[^)\s]*)\)/g), ...prose.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1] as string);
  return found.map((link) => link.split('#')[0]?.split('?')[0] as string);
}

function routeExists(route: string): boolean {
  if (route === '/docs') return files.includes('index');
  if (route.startsWith('/docs/')) return files.includes(route.slice('/docs/'.length));
  const folder = path.join(appDir, ...route.split('/').filter(Boolean));
  return fs.existsSync(path.join(folder, 'page.tsx')) || fs.existsSync(path.join(folder, 'page.mdx'));
}

describe('the sidebar order', () => {
  it('lists seventeen pages and four group separators', () => {
    expect(listed).toHaveLength(17);
    expect(meta.pages.filter((entry) => /^---.*---$/.test(entry))).toHaveLength(4);
  });

  it('has a file for every slug in meta.json', () => {
    for (const slug of listed) expect(fs.existsSync(path.join(docsDir, `${slug}.mdx`)), `${slug}.mdx`).toBe(true);
  });

  it('lists every .mdx file, once', () => {
    expect([...files].sort()).toEqual([...listed].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('the front matter', () => {
  it('gives every page a non-empty title and description', () => {
    for (const slug of listed) {
      const fields = frontMatter(readPage(slug));
      expect(fields.title, `${slug} title`).toBeTruthy();
      expect(fields.description, `${slug} description`).toBeTruthy();
    }
  });

  it('gives every page its own title', () => {
    const titles = listed.map((slug) => frontMatter(readPage(slug)).title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('internal links', () => {
  it('finds links in the pages, so the next check is not empty', () => {
    const all = listed.flatMap((slug) => internalLinks(readPage(slug)));
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((link) => link.startsWith('/docs/'))).toBe(true);
    expect(all).toEqual(expect.arrayContaining(['/replay', '/check', '/versions']));
  });

  it('points every link at a docs page or a route in the app folder', () => {
    for (const slug of listed) {
      for (const link of internalLinks(readPage(slug))) expect(routeExists(link), `${slug}.mdx links to ${link}`).toBe(true);
    }
  });

  it('refuses a link to a page that does not exist', () => {
    expect(routeExists('/docs/no-such-page')).toBe(false);
    expect(routeExists('/no-such-route')).toBe(false);
    expect(routeExists('/docs')).toBe(true);
    expect(routeExists('/replay')).toBe(true);
  });
});
