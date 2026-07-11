// Direct iframe verification — skip the SPA, just hit the chapter endpoint.
import { chromium } from 'playwright';

const BOOK_ID = process.argv[2];
if (!BOOK_ID) { console.error('Usage: node verify-spread.mjs <bookId>'); process.exit(1); }

const CHAPTER_URL = `http://localhost:13100/api/library/${BOOK_ID}/chapters/chapter008?theme=sepia&layout=spread&width=820&padt=56&padb=96&padx=56&size=18&lh=1.85&font=serif&indent=0`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(CHAPTER_URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(() => {
  const spread = document.querySelector('.epub-spread');
  const ps = Array.from(document.querySelectorAll('p')).slice(0, 5).map((p) => {
    const cs = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    return {
      margin: cs.margin,
      textIndent: cs.textIndent,
      columns: cs.columns,
      columnCount: cs.columnCount,
      columnWidth: cs.columnWidth,
      width: r.width.toFixed(1),
      x: r.x.toFixed(1),
      y: r.y.toFixed(1),
      text: (p.textContent || '').slice(0, 50),
    };
  });
  const spreadCS = spread ? getComputedStyle(spread) : null;
  const spreadRect = spread ? spread.getBoundingClientRect() : null;
  const bodyCS = getComputedStyle(document.body);
  return {
    spreadExists: !!spread,
    spreadColumnCount: spreadCS ? spreadCS.columnCount : null,
    spreadColumns: spreadCS ? spreadCS.columns : null,
    spreadColumnWidth: spreadCS ? spreadCS.columnWidth : null,
    spreadRect: spreadRect ? { x: spreadRect.x.toFixed(0), y: spreadRect.y.toFixed(0), w: spreadRect.width.toFixed(0), h: spreadRect.height.toFixed(0) } : null,
    spreadScrollWidth: spread ? spread.scrollWidth : null,
    spreadScrollHeight: spread ? spread.scrollHeight : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    firstFivePs: ps,
    psCount: document.querySelectorAll('p').length,
    bodyColumns: bodyCS.columns,
    bodyMargin: bodyCS.margin,
    bodyPadding: bodyCS.padding,
    styleTagsInBody: document.body.querySelectorAll('style').length,
    styleTagsInHead: document.head.querySelectorAll('style').length,
  };
});

console.log(JSON.stringify(result, null, 2));

await page.screenshot({ path: '/tmp/spread-debug.png' });
console.log('Screenshot: /tmp/spread-debug.png');

await browser.close();