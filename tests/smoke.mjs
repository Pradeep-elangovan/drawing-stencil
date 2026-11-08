// End-to-end smoke test: drives the real app in headless Chromium, downloads the PDF
// and checks page count, page size, line thickness and the width/height linkage.
//
// Run:  NODE_PATH=<dir containing playwright and pdf-lib> node tests/smoke.mjs [outDir]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } = require('pdf-lib');

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
const STROKE_UNIT = { mm: 1, cm: 10, in: 25.4 };

// Independent re-statement of the layout rules (kept separate from js/tiling.js on purpose).
const expectLayout = (wMm, hMm, [a, b], landscape, mode, strokeMm) => {
  const [pw, ph] = landscape ? [b, a] : [a, b];
  const inset = mode === 'bordered' ? 10 : 0, ov = mode === 'bordered' ? 0 : 10;
  const ww = pw - 2 * inset, wh = ph - 2 * inset;
  const gw = wMm + strokeMm, gh = hMm + strokeMm;
  const cols = gw <= ww ? 1 : Math.ceil((gw - ov) / (ww - ov) - 1e-9);
  const rows = gh <= wh ? 1 : Math.ceil((gh - ov) / (wh - ov) - 1e-9);
  return { cols, rows, pages: cols * rows, pw, ph };
};

const cases = [
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: false, mode: 'edge', stroke: '2', sUnit: 'mm' },
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: true, mode: 'edge', stroke: '2', sUnit: 'mm' },
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: false, mode: 'bordered', stroke: '2', sUnit: 'mm' },
  { file: 'star-ring.svg', unit: 'ft', width: '3', paper: 'A4', landscape: false, overview: true, mode: 'bordered', stroke: '6', sUnit: 'mm' },
  { file: 'mixed-features.svg', unit: 'cm', width: '90', paper: 'Letter', landscape: true, overview: false, mode: 'bordered', stroke: '0.5', sUnit: 'cm' },
  { file: 'mixed-features.svg', unit: 'in', width: '10', paper: 'A4', landscape: false, overview: false, mode: 'edge', stroke: '0.1', sUnit: 'in' },
];

// Read the line width (in mm) out of the embedded artwork form: the first operator is "<pt> w".
async function strokeFromPdf(pdf) {
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (String(obj.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;
    const text = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
    const m = /^([\d.]+) w/.exec(text);
    if (m) return parseFloat(m[1]) * MM;
  }
  return NaN;
}

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
  await page.selectOption('#strokeUnit', t.sUnit);
  await page.fill('#stroke', t.stroke);
  if (t.landscape) await page.check('input[name="orient"][value="landscape"]');
  await page.check(`input[name="mode"][value="${t.mode}"]`);
  if (t.overview) await page.check('#overview');

  const unitMm = { ft: 304.8, in: 25.4, cm: 10, m: 1000 }[t.unit];
  const strokeMm = parseFloat(t.stroke) * STROKE_UNIT[t.sUnit];
  const h = parseFloat(await page.inputValue('#height'));
  const wMm = parseFloat(t.width) * unitMm, hMm = h * unitMm;
  const exp = expectLayout(wMm, hMm, PAPER[t.paper], t.landscape, t.mode, strokeMm);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const path = join(outDir, `case${i + 1}-${t.file.replace('.svg', '')}-${t.paper}-${t.mode}.pdf`);
  await dl.saveAs(path);
  await page.screenshot({ path: path.replace('.pdf', '.png') });

  const pdf = await PDFDocument.load(await readFile(path));
  const pages = pdf.getPages();
  const want = exp.pages + (t.overview ? 1 : 0);
  const tag = `case ${i + 1} (${t.file}, ${t.width}${t.unit}, ${t.mode}, line ${t.stroke}${t.sUnit}, ${t.paper}${t.landscape ? ' landscape' : ''}${t.overview ? ' + map' : ''})`;
  check(errors.length === 0, `${tag}: no page errors ${errors.join('; ')}`);
  check(pages.length === want, `${tag}: ${pages.length} pages, expected ${want} (${exp.cols}x${exp.rows})`);
  const { width, height } = pages[pages.length - 1].getSize();
  check(Math.abs(width * MM - exp.pw) < 0.2 && Math.abs(height * MM - exp.ph) < 0.2,
    `${tag}: page size ${(width * MM).toFixed(1)}x${(height * MM).toFixed(1)} mm`);
  const got = await strokeFromPdf(pdf);
  check(Math.abs(got - strokeMm) < 0.01, `${tag}: PDF line thickness ${got.toFixed(3)} mm, expected ${strokeMm}`);
  await page.close();
}

// Line thickness is independent of artwork size: same stroke at two very different sizes.
{
  const sizes = [];
  for (const w of ['30', '300']) {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(base);
    await page.click('#sample');
    await page.selectOption('#unit', 'cm');
    await page.fill('#width', w);
    await page.fill('#stroke', '3');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const path = join(outDir, `scale-${w}.pdf`);
    await dl.saveAs(path);
    sizes.push(await strokeFromPdf(await PDFDocument.load(await readFile(path))));
    await page.close();
  }
  check(sizes.every((s) => Math.abs(s - 3) < 0.01), `line stays 3 mm at 30 cm and 300 cm wide (${sizes.map((s) => s.toFixed(3)).join(', ')})`);
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
  // line thickness validation and unit switch
  await page.fill('#stroke', '0');
  check(await page.isDisabled('#download'), 'zero line thickness disables download');
  await page.fill('#stroke', '2');
  await page.selectOption('#strokeUnit', 'cm');
  check(parseFloat(await page.inputValue('#stroke')) === 0.2, 'stroke unit switch keeps 2 mm (0.2 cm)');
  // bordered mode changes the hint text
  await page.check('input[name="mode"][value="bordered"]');
  check((await page.textContent('#modehint')).includes('cut marks'), 'bordered mode explains cut marks');
  await page.close();
}

// Invalid file shows an error instead of crashing.
{
  const page = await browser.newPage();
  await page.goto(base);
  await writeFile(join(outDir, 'bad.svg'), '<html>nope</html>');
  await page.setInputFiles('#file', join(outDir, 'bad.svg'));
  await page.waitForFunction(() => document.getElementById('error').textContent.includes('not a valid SVG'), null, { timeout: 5000 })
    .catch(() => {});
  check((await page.textContent('#error')).includes('not a valid SVG'), 'invalid SVG reports an error');
  check(await page.isDisabled('#download'), 'download stays disabled after an invalid SVG');
  await page.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
