// End-to-end smoke test: drives the real app in headless Chromium, downloads the PDF
// and checks page count, page size and the width/height linkage.
//
// Run:  NODE_PATH=<dir containing playwright and pdf-lib> node tests/smoke.mjs [outDir]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.argv[2] || join(root, 'tests', 'out');
await mkdir(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, p === '/' ? 'index.html' : p);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

const MM = 25.4 / 72;
const PAPER = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420] };
const expectPages = (wMm, hMm, [a, b], landscape) => {
  const [pw, ph] = landscape ? [b, a] : [a, b];
  const gw = wMm + 2, gh = hMm + 2, ov = 10;
  const cols = gw <= pw ? 1 : Math.ceil((gw - ov) / (pw - ov) - 1e-9);
  const rows = gh <= ph ? 1 : Math.ceil((gh - ov) / (ph - ov) - 1e-9);
  return { cols, rows, pages: cols * rows, pw, ph };
};

const cases = [
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: false },
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: true },
  { file: 'mixed-features.svg', unit: 'cm', width: '90', paper: 'Letter', landscape: true, overview: false },
  { file: 'mixed-features.svg', unit: 'in', width: '10', paper: 'A4', landscape: false, overview: false },
];

const browser = await chromium.launch();
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

for (const [i, t] of cases.entries()) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.setInputFiles('#file', join(root, 'tests', 'fixtures', t.file));
  await page.selectOption('#unit', t.unit);
  await page.fill('#width', t.width);
  await page.selectOption('#paper', t.paper);
  if (t.landscape) await page.check('input[name="orient"][value="landscape"]');
  if (t.overview) await page.check('#overview');

  const unitMm = { ft: 304.8, in: 25.4, cm: 10, m: 1000 }[t.unit];
  const h = parseFloat(await page.inputValue('#height'));
  const wMm = parseFloat(t.width) * unitMm, hMm = h * unitMm;
  const exp = expectPages(wMm, hMm, PAPER[t.paper], t.landscape);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const path = join(outDir, `case${i + 1}-${t.file.replace('.svg', '')}-${t.paper}.pdf`);
  await dl.saveAs(path);
  await page.screenshot({ path: path.replace('.pdf', '.png') });

  const pdf = await PDFDocument.load(await readFile(path));
  const pages = pdf.getPages();
  const want = exp.pages + (t.overview ? 1 : 0);
  const tag = `case ${i + 1} (${t.file}, ${t.width}${t.unit} on ${t.paper}${t.landscape ? ' landscape' : ''}${t.overview ? ' + map' : ''})`;
  check(errors.length === 0, `${tag}: no page errors ${errors.join('; ')}`);
  check(pages.length === want, `${tag}: ${pages.length} pages, expected ${want} (${exp.cols}x${exp.rows})`);
  const { width, height } = pages[pages.length - 1].getSize();
  check(Math.abs(width * MM - exp.pw) < 0.2 && Math.abs(height * MM - exp.ph) < 0.2,
    `${tag}: page size ${(width * MM).toFixed(1)}x${(height * MM).toFixed(1)} mm`);
  await page.close();
}

// Linked width/height: typing a height must drive the width.
{
  const page = await browser.newPage();
  await page.goto(base);
  await page.click('#sample');
  await page.fill('#height', '3');
  check(parseFloat(await page.inputValue('#width')) === 3, 'square sample: height 3 gives width 3');
  await page.selectOption('#unit', 'cm');
  check(Math.abs(parseFloat(await page.inputValue('#width')) - 91.44) < 0.01, 'unit switch keeps physical size (3 ft = 91.44 cm)');
  await page.close();
}

// Invalid file shows an error instead of crashing.
{
  const page = await browser.newPage();
  await page.goto(base);
  await writeFile(join(outDir, 'bad.svg'), '<html>nope</html>');
  await page.setInputFiles('#file', join(outDir, 'bad.svg'));
  check((await page.textContent('#error')).includes('not a valid SVG'), 'invalid SVG reports an error');
  check(await page.isDisabled('#download'), 'download stays disabled after an invalid SVG');
  await page.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
