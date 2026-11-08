// The instruction sheet that goes in the cutting kit (a small multi-page PDF).

import { MACHINES, fitReport } from './machines.js';
import { paperLabel } from './tiling.js';

const A4 = [595.28, 841.89];
const M = 50;
const fmt = (v) => String(Math.round(v * 10) / 10);

/**
 * @param {object} o
 * @param {string} o.machineId
 * @param {object} o.L layout from computeLayout
 * @param {{n:number,r:number,c:number,files:string[]}[]} o.pages
 * @param {boolean} o.perforated
 * @param {number} o.bridgeMm
 * @param {string} o.paper @param {string} o.orientation @param {string} o.title
 * @param {boolean} o.hasGuide  cut-order numbers are printed on the sheets
 * @param {string[]} o.testFiles
 */
export async function buildGuidePdf(o) {
  const { PDFDocument, StandardFonts, rgb } = globalThis.PDFLib;
  const machine = MACHINES[o.machineId];
  const { L } = o;
  const doc = await PDFDocument.create();
  doc.setTitle(`${o.title} - cutting guide`);
  doc.setProducer('Stencil Tiler');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page, y;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - M; };
  newPage();
  const need = (h) => { if (y - h < M) newPage(); };
  const wrap = (text, f, size, width) => {
    const lines = [];
    let line = '';
    for (const word of String(text).split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(t, size) <= width) line = t;
      else { if (line) lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (text, { size = 10, f = font, indent = 0, gap = 6, color = rgb(0.12, 0.12, 0.12) } = {}) => {
    const lines = wrap(text, f, size, A4[0] - 2 * M - indent);
    const lh = size * 1.4;
    need(lines.length * lh + gap);
    for (const l of lines) { page.drawText(l, { x: M + indent, y: y - size, size, font: f, color }); y -= lh; }
    y -= gap;
  };
  const h1 = (t) => { need(40); page.drawText(t, { x: M, y: y - 20, size: 20, font: bold }); y -= 32; };
  const h2 = (t) => { need(34); y -= 8; page.drawText(t, { x: M, y: y - 13, size: 13, font: bold, color: rgb(0.06, 0.46, 0.43) }); y -= 22; };
  const steps = (list) => list.forEach((s, i) => {
    const lines = wrap(s, font, 10, A4[0] - 2 * M - 22);
    need(lines.length * 14 + 6);
    page.drawText(`${i + 1}.`, { x: M, y: y - 10, size: 10, font: bold });
    for (const l of lines) { page.drawText(l, { x: M + 22, y: y - 10, size: 10, font }); y -= 14; }
    y -= 6;
  });

  const wMm = fmt(L.pw), hMm = fmt(L.ph), wIn = fmt(L.pw / 25.4), hIn = fmt(L.ph / 25.4);
  const fit = fitReport(o.machineId, L.pw, L.ph);
  const fitText = !fit.checked ? 'Check that the sheet fits your machine and mat.'
    : fit.ok ? `This sheet should fit the ${fit.fits.join(' or ')} mat (allowing about 0.25 in clearance on each side; check your model's maximum cutting area).`
      : `This sheet is probably too big for the usual mats (${fit.all.join(', ')}). Choose a smaller paper size, or check your machine's maximum cutting area.`;
  const ctx = {
    // Silhouette's free edition opens DXF, so point it at that one
    first: (o.machineId === 'silhouette' && o.pages[0].files.find((f) => f.endsWith('.dxf'))) || o.pages[0].files[0], w: wMm, h: hMm, wIn, hIn, mat: fit.fits.length ? fit.fits[fit.fits.length - 1] : null,
  };

  h1(`Cutting guide: ${machine.name}`);
  para(`${o.title}: ${L.cols} x ${L.rows} = ${L.pages} pages on ${paperLabel(o.paper)}, ${o.orientation}, ` +
    `${L.bordered ? 'bordered with cut marks' : 'edge to edge with overlap'}.`, { size: 11, f: bold });

  h2('At a glance');
  steps([
    `Sheet size: ${wMm} x ${hMm} mm (${wIn} x ${hIn} in). Every cut file is exactly this size.`,
    o.perforated
      ? `Cut style: spotted. Each outline is cut as dashes about 5 mm long with ${fmt(o.bridgeMm)} mm uncut bridges between them, so shapes stay attached until you tear them out.`
      : 'Cut style: full cut. Outlines are cut all the way round, so shapes fall out as soon as the paper is lifted.',
    `Files: ${o.pages.length} page file${o.pages.length === 1 ? '' : 's'} plus an alignment test, as ${machine.formats.map((x) => x.toUpperCase()).join(' and ')}.`,
    fitText,
  ]);

  h2('How this works');
  para('Print the PDF first. Each cut file then cuts the outlines of one printed sheet, in the same position as the printed lines. ' +
    'This is a cut-only job: do not use Print Then Cut or registration marks. Full A4 and Letter sheets are larger than Print Then Cut allows on Cricut, ' +
    'so you line the sheet up by its corner on the mat instead.');
  para('The cut runs down the middle of each printed line, so half the line stays on each side of the cut.');
  para('Four tiny square holes are punched at the corners of every sheet. They make each file exactly the size of the sheet, so the file\'s top-left corner matches the sheet\'s top-left corner. Ignore the holes afterwards.');

  h2('Test the alignment first');
  steps([
    `Load a blank sheet of the same paper, in the same orientation, and cut ${(o.machineId === 'silhouette' && o.testFiles.find((f) => f.endsWith('.dxf'))) || o.testFiles[0]} (it only punches the four corners).`,
    'Check that the four little holes sit in the four corners. If all four are shifted the same way, load the next sheet that much the other way, or move the design in the software by the same amount.',
    'Adjust the pressure or blade depth until the paper cuts cleanly all the way through.',
  ]);

  h2(`Cutting each page (${machine.name})`);
  steps(machine.steps(ctx));
  para('Menu names differ a little between software versions. If a step does not match your screen, the same idea applies: exact sheet size, top-left corner to the mat corner, cut only.', { size: 9, color: rgb(0.4, 0.4, 0.4) });

  h2('After cutting');
  const after = [];
  if (L.bordered) after.push('Trim the margin off along the printed cut marks on every side that joins another page. The outer sides of the whole stencil keep their margin.');
  else after.push('Pages overlap by 10 mm. Line up the grey crosses on neighbouring sheets, then tape or glue them down.');
  after.push('Stick the sheets in place with a low-tack or temporary adhesive, lining them up carefully.');
  if (o.hasGuide) after.push('Tear shapes out in the order of the red numbers: 1 first, so small inner details are painted while the paper is still whole. Leave the hatched areas.');
  else after.push('Tear out the small inner shapes first and the big shapes last, so the paper still works as a stencil while you paint the details.');
  after.push(o.perforated ? 'Push gently along the dashes to tear a shape free. If a bridge is too strong, cut it with a craft knife.' : 'Lift each shape out as you reach it.');
  steps(after);

  h2('Page list');
  need(24);
  page.drawText('Page', { x: M, y: y - 10, size: 9, font: bold });
  page.drawText('Position', { x: M + 50, y: y - 10, size: 9, font: bold });
  page.drawText('File', { x: M + 130, y: y - 10, size: 9, font: bold });
  y -= 16;
  for (const p of o.pages) {
    need(14);
    page.drawText(String(p.n), { x: M, y: y - 9, size: 9, font });
    page.drawText(`Row ${p.r}, column ${p.c}`, { x: M + 50, y: y - 9, size: 9, font });
    page.drawText(p.files.join('  /  '), { x: M + 130, y: y - 9, size: 9, font });
    y -= 13;
  }
  y -= 8;
  para('These instructions have not been tested on every machine. Always do a test cut on scrap paper first.', { size: 9, color: rgb(0.4, 0.4, 0.4) });

  return doc.save();
}
