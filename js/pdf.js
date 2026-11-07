// Builds the single tiled PDF.
//
// The scaled outline is written once as a vector Form XObject; every page just
// places that form with a different offset, so file size stays small and lines
// stay crisp at any zoom. Pages have no margins: the page IS the window.

import { STROKE_MM, PT_PER_MM, computeLayout } from './tiling.js';

const num = (v) => String(Math.round(v * 1000) / 1000);

function artworkStream(subpaths, bbox, scale, gridH) {
  // Source space is y-down (SVG); the form is y-up (PDF), so flip against gridH.
  const pad = STROKE_MM / 2;
  const X = (x) => num(((x - bbox.minX) * scale + pad) * PT_PER_MM);
  const Y = (y) => num((gridH - ((y - bbox.minY) * scale + pad)) * PT_PER_MM);
  const out = [`${num(STROKE_MM * PT_PER_MM)} w`, '1 J', '1 j', '0 G'];
  for (const s of subpaths) {
    out.push(`${X(s.start[0])} ${Y(s.start[1])} m`);
    for (const g of s.segs) {
      if (g[0] === 'L') out.push(`${X(g[1])} ${Y(g[2])} l`);
      else out.push(`${X(g[1])} ${Y(g[2])} ${X(g[3])} ${Y(g[4])} ${X(g[5])} ${Y(g[6])} c`);
    }
    if (s.closed) out.push('h');
  }
  out.push('S');
  return out.join('\n');
}

/**
 * @param {object} o
 * @param {object[]} o.subpaths outline geometry in source units
 * @param {object} o.bbox       {minX,minY,w,h} of that geometry
 * @param {number} o.widthMm    requested real-world width of the artwork
 * @param {string} o.paper      key of PAPERS
 * @param {'portrait'|'landscape'} o.orientation
 * @param {boolean} o.overview  add an assembly-map page first
 * @param {string} [o.title]
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf({ subpaths, bbox, widthMm, paper, orientation, overview, title = 'Stencil' }) {
  const PL = globalThis.PDFLib;
  if (!PL) throw new Error('PDF library failed to load.');
  const {
    PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState,
    concatTransformationMatrix, drawObject,
  } = PL;

  const scale = widthMm / bbox.w;
  const artW = widthMm, artH = bbox.h * scale;
  const L = computeLayout(artW, artH, paper, orientation);
  const { pw, ph, cols, rows, stepX, stepY, overlap } = L;

  const doc = await PDFDocument.create();
  doc.setTitle(`${title} - stencil tiles`);
  doc.setProducer('Stencil Tiler');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const form = doc.context.flateStream(artworkStream(subpaths, bbox, scale, L.gridH), {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, L.gridW * PT_PER_MM, L.gridH * PT_PER_MM],
    Resources: {},
  });
  const formRef = doc.context.register(form);

  const PW = pw * PT_PER_MM, PH = ph * PT_PER_MM;
  const gridHpt = L.gridH * PT_PER_MM;

  const placeArt = (page, a, b, c, d, tx, ty) => {
    const name = page.node.newXObject('Art', formRef);
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(a, b, c, d, tx, ty), drawObject(name), popGraphicsState(),
    );
  };

  // ---- optional assembly map (always page 1, not counted as a tile)
  if (overview) {
    const page = doc.addPage([PW, PH]);
    const m = 12 * PT_PER_MM;
    const head = 22 * PT_PER_MM;
    const k = Math.min((PW - 2 * m) / L.totalW, (PH - 2 * m - head) / L.totalH); // map points per real mm
    const ox = (PW - L.totalW * k) / 2;
    const oyTop = PH - m - head; // top edge of the map in page space
    page.drawText('Assembly map', { x: m, y: PH - m - 6, size: 16, font: bold, color: rgb(0, 0, 0) });
    page.drawText(
      `${cols} columns x ${rows} rows = ${L.pages} pages. Final size ${Math.round(artW)} x ${Math.round(artH)} mm. ` +
      'Print every page at 100% / Actual size.',
      { x: m, y: PH - m - 22, size: 8, font, color: rgb(0.3, 0.3, 0.3) },
    );
    // The form is in real points (1 pt = 1/PT_PER_MM mm), so it scales by k / PT_PER_MM.
    // Its origin is the grid's bottom-left corner; the grid sits at the top-left of the map.
    const fs = k / PT_PER_MM;
    placeArt(page, fs, 0, 0, fs, ox, oyTop - L.gridH * k);
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        n++;
        const x = ox + c * stepX * k;
        const y = oyTop - (r * stepY + ph) * k;
        page.drawRectangle({
          x, y, width: pw * k, height: ph * k,
          borderColor: rgb(0.2, 0.45, 0.75), borderWidth: 0.6,
          color: rgb(0.2, 0.45, 0.75), opacity: 0.05, borderOpacity: 0.9,
        });
        const label = `R${r + 1}-C${c + 1}`;
        const fsz = Math.max(5, Math.min(14, pw * k * 0.16));
        page.drawText(String(n), {
          x: x + 3, y: y + ph * k - fsz - 2, size: fsz, font: bold, color: rgb(0.1, 0.3, 0.6),
        });
        page.drawText(label, {
          x: x + 3, y: y + ph * k - fsz * 1.9 - 2, size: Math.max(4, fsz * 0.55), font, color: rgb(0.35, 0.35, 0.35),
        });
      }
    }
  }

  // ---- tile pages
  const half = overlap / 2;
  const cross = 2; // mm half-length of registration crosses
  const grey = rgb(0.35, 0.35, 0.35);
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const page = doc.addPage([PW, PH]);
      // art point (X, Ydown) -> page (X - c*stepX, ph - (Ydown - r*stepY)); form is already y-up.
      placeArt(page, 1, 0, 0, 1, -c * stepX * PT_PER_MM, PH - gridHpt + r * stepY * PT_PER_MM);

      // Registration crosses sit mid-overlap, so the same cross appears at the same
      // art position on the neighbouring page: line the crosses up and tape.
      const hasL = c > 0, hasR = c < cols - 1, hasT = r > 0, hasB = r < rows - 1;
      for (const [xs, ys, onX, onY] of [
        [half, ph - half, hasL, hasT], [pw - half, ph - half, hasR, hasT],
        [half, half, hasL, hasB], [pw - half, half, hasR, hasB],
      ]) {
        if (!onX && !onY) continue;
        const x = xs * PT_PER_MM, y = ys * PT_PER_MM, h = cross * PT_PER_MM;
        page.drawLine({ start: { x: x - h, y }, end: { x: x + h, y }, thickness: 0.35, color: grey });
        page.drawLine({ start: { x, y: y - h }, end: { x, y: y + h }, thickness: 0.35, color: grey });
      }

      // Page label lives inside the page (in the bottom-left overlap strip area).
      page.drawText(`R${r + 1}-C${c + 1}   ${n}/${L.pages}`, {
        x: (overlap + 2) * PT_PER_MM, y: (half - 1) * PT_PER_MM, size: 7, font, color: grey,
      });
    }
  }

  return doc.save();
}
