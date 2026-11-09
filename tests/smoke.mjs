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
const PAPER = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420], '5x7': [127, 177.8] };
const STROKE_UNIT = { mm: 1, cm: 10, in: 25.4 };

// Independent re-statement of the layout rules (kept separate from js/tiling.js on purpose).
const expectLayout = (wMm, hMm, [a, b], landscape, mode, strokeMm) => {
  const [pw, ph] = landscape ? [b, a] : [a, b];
  const inset = mode === 'bordered' ? 15 : 0, ov = mode === 'bordered' ? 0 : 10;
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
  { file: 'cat.svg', unit: 'cm', width: '60', paper: 'A4', landscape: false, overview: true, mode: 'bordered', stroke: '2', sUnit: 'mm' },
  { file: 'nested.svg', unit: 'cm', width: '40', paper: '5x7', landscape: false, overview: true, mode: 'edge', stroke: '2', sUnit: 'mm' },
  { file: 'star-ring.svg', unit: 'ft', width: '2', paper: 'A4', landscape: false, overview: false, mode: 'edge', stroke: '2', sUnit: 'mm', order: false },
];

// Read a STORE zip (what the app writes) into { name: Buffer }.
function readZip(buf) {
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    const size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26);
    out[name] = buf.subarray(off + 30 + lnl, off + 30 + lnl + size);
    p += 46 + nl;
  }
  return out;
}

// Decoded content of the embedded artwork form (outline, plus numbers and hatching when on).
async function formText(pdf) {
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (String(obj.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;
    return Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
  }
  return '';
}
// The outline width is the "w" that precedes "1 J / 1 j / 0 G" (hatching uses its own width).
async function strokeFromPdf(pdf) {
  const m = /([\d.]+) w\n1 J\n1 j\n0 G/.exec(await formText(pdf));
  return m ? parseFloat(m[1]) * MM : NaN;
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
  if (t.order === false) await page.uncheck('#order');

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
  // cut-order guide: one number per shape to cut (plus hatching) inside the art form, or nothing when off
  const text = await formText(pdf);
  const texts = (text.match(/\bBT\b/g) || []).length;
  if (t.order === false) {
    check(texts === 0 && !text.includes('W*'), `${tag}: guide off leaves no numbers or hatching in the PDF`);
  } else {
    const cutN = parseInt(await page.textContent('#orderinfo'), 10);
    check(texts === cutN && text.includes('(1) Tj') && text.includes(`(${cutN}) Tj`),
      `${tag}: ${texts} cut-order numbers in the PDF, UI says ${cutN} shapes to cut`);
  }
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

// Cut guide in the UI: the sample is a ring with a star in its hole, so the star is cut first.
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(base);
  await page.click('#sample');
  const info = await page.textContent('#orderinfo');
  check(info.includes('2 shapes to cut in 2 passes') && info.includes('1 area to leave uncut'), `sample reports its cut order (${info.trim()})`);
  const nums = await page.$$eval('.preview .num', (n) => n.map((x) => x.textContent));
  check(nums.join(',') === '1,2', `preview numbers the star 1 and the ring 2 (${nums})`);
  check((await page.$$('.preview path[fill="url(#hatch)"]')).length === 1, 'preview hatches the one area left uncut');
  await page.uncheck('#order');
  check((await page.$$('.preview .num')).length === 0 && (await page.$$('.preview path[fill="url(#hatch)"]')).length === 0,
    'toggling the guide off removes numbers and hatching from the preview');
  await page.check('#order');
  // a very small print makes the numbers too big for their shapes: warn
  await page.setInputFiles('#file', join(root, 'tests', 'fixtures', 'cat.svg'));
  await page.selectOption('#unit', 'cm');
  await page.fill('#width', '8');
  check((await page.textContent('#orderinfo')).includes('too small for a number'), 'tiny prints warn that some numbers will not fit');
  await page.close();
}

// Cutting kit: checkbox reveals the options, the ZIP holds a cut file per page, a guide and the print PDF.
for (const k of [
  { machine: 'silhouette', style: 'perf', formats: ['svg', 'dxf'], mode: 'bordered' },
  { machine: 'cricut', style: 'full', formats: ['svg'], mode: 'edge' },
]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.setInputFiles('#file', join(root, 'tests', 'fixtures', 'cat.svg'));
  await page.selectOption('#unit', 'cm');
  await page.fill('#width', '60');
  await page.check(`input[name="mode"][value="${k.mode}"]`);
  const tag = `kit (${k.machine}, ${k.style}, ${k.mode})`;
  check(await page.isHidden('#kit'), `${tag}: kit button is hidden until the checkbox is ticked`);
  await page.check('#machineOn');
  check(await page.isVisible('#kit') && await page.isVisible('#machine'), `${tag}: checkbox reveals machine options and kit button`);
  await page.selectOption('#machine', k.machine);
  await page.selectOption('#cutstyle', k.style);
  check((await page.isHidden('#bridgeField')) === (k.style === 'full'), `${tag}: bridge size only shows for spotted cuts`);
  const pagesN = parseInt((await page.textContent('#summary')).match(/= (\d+) page/)[1], 10);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#kit')]);
  const zpath = join(outDir, `kit-${k.machine}.zip`);
  await dl.saveAs(zpath);
  const z = readZip(await readFile(zpath));
  const names = Object.keys(z);
  const svgs = names.filter((n) => /^cut-files\/page-\d+_R\d+-C\d+\.svg$/.test(n));
  check(svgs.length === pagesN, `${tag}: ${svgs.length} page cut files for ${pagesN} pages`);
  check(names.includes('cut-files/00_alignment-test.svg'), `${tag}: alignment test file included`);
  const dxfs = names.filter((n) => n.endsWith('.dxf')).length;
  check(k.formats.includes('dxf') ? dxfs === pagesN + 1 : dxfs === 0, `${tag}: ${dxfs} DXF files (${k.formats.join('+')} expected)`);
  const sv = z[svgs[0]].toString();
  check(sv.startsWith('<?xml') && sv.includes('width="210mm"') && sv.includes('</svg>'), `${tag}: SVG is sheet-sized and well formed`);
  const dashed = sv.match(/ d="([^"]*)"/)[1];
  const pieces = (dashed.match(/M/g) || []).length;
  check(k.style === 'perf' ? pieces > 40 : pieces < 40, `${tag}: ${pieces} cut pieces on page 1 (${k.style === 'perf' ? 'dashed' : 'continuous'})`);
  const guide = names.find((n) => n.startsWith('cutting-guide-'));
  const gdoc = await PDFDocument.load(z[guide]);
  check(gdoc.getPageCount() >= 2, `${tag}: guide PDF has ${gdoc.getPageCount()} pages`);
  const printName = names.find((n) => n.endsWith('.pdf') && n !== guide);
  const pdoc = await PDFDocument.load(z[printName]);
  check(pdoc.getPageCount() === pagesN, `${tag}: print PDF inside the kit has ${pdoc.getPageCount()} pages`);
  check(errors.length === 0, `${tag}: no page errors ${errors.join('; ')}`);
  await page.screenshot({ path: join(outDir, `kit-${k.machine}.png`) });
  await page.close();
}

// A page that does not fit the machine's mat says so.
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(base);
  await page.click('#sample');
  await page.check('#machineOn');
  await page.selectOption('#machine', 'cricut-joy-xtra');
  await page.selectOption('#paper', 'A3');
  check((await page.textContent('#machineinfo')).includes('too big'), 'A3 on a Joy Xtra warns the paper is too big for the mat');
  await page.selectOption('#paper', '5x7');
  check((await page.textContent('#machineinfo')).includes('fits'), '5x7 on a Joy Xtra fits the mat');
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
