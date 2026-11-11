import type { MetadataRoute } from 'next';
import { SITEMAP_PAGES, siteUrl } from '../lib/siteUrl';
import { source } from '../lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteUrl();
  const docsPages = source.getPages().map((page) => page.url);
  return [...SITEMAP_PAGES, ...docsPages].map((path) => ({ url: `${origin}${path}` }));
}
