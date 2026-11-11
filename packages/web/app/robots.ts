import type { MetadataRoute } from 'next';
import { ROBOTS_DISALLOWED, siteUrl } from '../lib/siteUrl';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOWED] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
