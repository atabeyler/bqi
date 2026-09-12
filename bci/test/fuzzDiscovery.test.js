import { describe, expect, it } from 'vitest';
import { extractSitemapLocs, isSitemapIndex, parseRobots } from '../src/engines/adapters/fuzzDiscovery.js';

describe('Smart Fuzz discovery inputs', () => {
  it('never turns robots wildcard match rules into executable URLs', () => {
    const parsed = parseRobots(`
      Disallow: /private
      Disallow: /*?lightbox=
      Disallow: /_partials*
      Disallow: /pro-gallery-webapp/v1/galleries/*
      Disallow: /draft$
      Sitemap: https://example.com/sitemap.xml
    `);

    expect(parsed.paths).toEqual(['/private']);
    expect(parsed.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('distinguishes a sitemap index from a page sitemap and extracts real locations', () => {
    const index = '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>';
    const pages = '<urlset><url><loc>https://example.com/page-one</loc></url></urlset>';
    expect(isSitemapIndex(index)).toBe(true);
    expect(isSitemapIndex(pages)).toBe(false);
    expect(extractSitemapLocs(index)).toEqual(['https://example.com/pages.xml']);
    expect(extractSitemapLocs(pages)).toEqual(['https://example.com/page-one']);
  });
});
