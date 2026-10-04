import { describe, it, expect } from 'vitest';
import { parseDuckDuckGoHtml, parseGoogleNewsRss, formatResearchContext } from './webResearch.js';

// Fixture trimmed from a real DuckDuckGo HTML response (fetched directly,
// outside Render, for a real query) -- kept close to the actual markup
// rather than a simplified guess, since the bug this guards against was
// exactly a simplified guess ("the block ends at the next </div></div>")
// disagreeing with what DuckDuckGo actually sends. See parseDuckDuckGoHtml's
// own comment in webResearch.js for the root cause.
const REAL_DDG_HTML_FIXTURE = `
<div class="results">
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-one">Article One Title</a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <span class="result__icon">
            <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-one">
              <img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/www.example.com.ico" />
            </a>
          </span>
          <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-one">
            www.example.com/article-one
          </a>
          <span>&nbsp; &nbsp; 2026-03-26T00:00:00.0000000</span>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-one">This is the real snippet body for article one, describing what actually happened.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-two">Article Two Title</a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <span class="result__icon">
            <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-two">
              <img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/www.example.com.ico" />
            </a>
          </span>
          <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-two">
            www.example.com/article-two
          </a>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-two">Second article&#x27;s snippet, with an escaped apostrophe in it.</a>
    </div>
  </div>
</div>
`;

describe('parseDuckDuckGoHtml', () => {
  it('extracts both the title and the real snippet text for each result', () => {
    const results = parseDuckDuckGoHtml(REAL_DDG_HTML_FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Article One Title',
      url: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Farticle-one',
      snippet: 'This is the real snippet body for article one, describing what actually happened.',
    });
    expect(results[1].snippet).toBe("Second article's snippet, with an escaped apostrophe in it.");
  });

  it('returns an empty array for a page with no result markup at all', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results here</body></html>')).toEqual([]);
  });

  it('caps at 6 results even when more are present', () => {
    const oneResult = REAL_DDG_HTML_FIXTURE.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];
    const manyResults = Array(8).fill(oneResult).join('\n');
    const results = parseDuckDuckGoHtml(`<div class="results">${manyResults}</div>`);
    expect(results.length).toBeLessThanOrEqual(6);
  });
});

describe('formatResearchContext', () => {
  it('includes the real snippet text, not a placeholder dash', () => {
    const results = parseDuckDuckGoHtml(REAL_DDG_HTML_FIXTURE);
    const context = formatResearchContext(results);
    expect(context).toContain('This is the real snippet body for article one');
    expect(context).not.toContain('Özet: -');
  });
});

describe('parseGoogleNewsRss', () => {
  const xml = `<rss><channel>
    <item><title>TCMB faizi sabit tuttu - Ekonomi Haber</title><link>https://news.google.com/rss/articles/abc</link><description>&lt;a href="x"&gt;Faiz kararı&lt;/a&gt; açıklandı</description><source url="https://x.com">Ekonomi Haber</source></item>
    <item><title></title><link>https://news.google.com/rss/articles/skip</link></item>
  </channel></rss>`;

  it('extracts title, url and snippet, skipping items without a title', () => {
    const r = parseGoogleNewsRss(xml);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('TCMB faizi sabit tuttu - Ekonomi Haber');
    expect(r[0].url).toBe('https://news.google.com/rss/articles/abc');
    expect(r[0].snippet).toContain('Ekonomi Haber');
    expect(r[0].snippet).toContain('Faiz kararı açıklandı');
  });

  it('returns an empty array for a feed with no items', () => {
    expect(parseGoogleNewsRss('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('parseBingNewsRss', () => {
  const xml = `<rss xmlns:News="x"><channel>
    <item><title>Fon soruşturmasında yeni gelişme</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fwww.example.com%2fhaber%2f1&amp;c=1</link><description>&#304;stanbul Cumhuriyet Ba&#351;savc&#305;l&#305;&#287;&#305; a&#231;ıklama yaptı.</description><pubDate>Sun, 04 Oct 2026 10:00:00 GMT</pubDate><News:Source>Example Haber</News:Source></item>
    <item><title></title><link>http://www.bing.com/x</link></item>
  </channel></rss>`;

  it('unwraps the publisher URL and decodes numeric entities in the description', async () => {
    const { parseBingNewsRss } = await import('./webResearch.js');
    const r = parseBingNewsRss(xml);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe('https://www.example.com/haber/1');
    expect(r[0].snippet).toContain('[04 Oct 2026]');
    expect(r[0].snippet).toContain('Example Haber:');
    expect(r[0].snippet).toContain('İstanbul Cumhuriyet Başsavcılığı');
  });
});

describe('extractArticleText', () => {
  it('keeps article paragraphs and drops scripts/nav/short fragments', async () => {
    const { extractArticleText } = await import('./webResearch.js');
    const p1 = 'SPK yedi portföy yönetim şirketinin fonlarında işlemleri durdurdu ve 131 fonu tasfiye sürecine aldı, yatırımcılar zarar gördü.';
    const html = `<html><head><script>var x = 1;</script></head><body><nav><p>Menü öğesi çok uzun bir metin olsa bile navigasyon içinde kalmalıdır ve alınmamalıdır kesinlikle.</p></nav>
      <article><p>Kısa.</p><p>${p1}</p></article></body></html>`;
    const t = extractArticleText(html);
    expect(t).toContain('131 fonu tasfiye');
    expect(t).not.toContain('Menü öğesi');
    expect(t).not.toContain('var x');
  });

  it('falls back to the meta description when the page has no usable paragraphs', async () => {
    const { extractArticleText } = await import('./webResearch.js');
    const t = extractArticleText('<html><head><meta property="og:description" content="Fon krizinde 800 milyar liralık vurgun iddiası"></head><body><div>js app</div></body></html>');
    expect(t).toContain('800 milyar');
  });
});

describe('formatResearchContext with article bodies', () => {
  it('includes the article text when present', () => {
    const out = formatResearchContext([{ title: 'T', url: 'https://a.com', snippet: 's', body: 'Gövde metni burada' }]);
    expect(out).toContain('Haber metni: Gövde metni burada');
  });
});
