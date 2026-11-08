// Builds the single tiled PDF.
//
// The scaled outline is written once as a vector Form XObject; every page just
// places that form with a different offset, so file size stays small and lines
// stay crisp at any zoom.
//
// Two print styles:
//  - edge:     the page is the window (no margin), neighbours overlap, registration
//              crosses sit mid-overlap.
//  - bordered: a blank MARGIN_MM border on every page, art clipped to the inner
//              window, cut marks on the sides that join a neighbour (outer sides
//              of the whole grid keep their margin and get no marks).

import { PT_PER_MM, computeLayout } from './tiling.js';
import { numberSize, HATCH_MM } from './order.js';

const num = (v) => String(Math.round(v * 1000) / 1000);

// Everything the guide draws sits inside the shared art form, so it is shifted and
// clipped per page together with the outline.
function artworkStream(subpaths, bbox, scale, gridH, strokeMm, guide) {
  // Source space is y-down (SVG); the form is y-up (PDF), so flip against gridH.
  const pad = strokeMm / 2;
  const fx = (x) => ((x - bbox.minX) * scale + pad) * PT_PER_MM;
  const fy = (y) => (gridH - ((y - bbox.minY) * scale + pad)) * PT_PER_MM;
  const X = (x) => num(fx(x));
  const Y = (y) => num(fy(y));
  const formW = (bbox.w * scale + strokeMm) * PT_PER_MM, formH = gridH * PT_PER_MM;
  const pathOps = (subs) => {
    const ops = [];
    for (const s of subs) {
      ops.push(`${X(s.start[0])} ${Y(s.start[1])} m`);
      for (const g of s.segs) {
        if (g[0] === 'L') ops.push(`${X(g[1])} ${Y(g[2])} l`);
        else ops.push(`${X(g[1])} ${Y(g[2])} ${X(g[3])} ${Y(g[4])} ${X(g[5])} ${Y(g[6])} c`);
      }
      if (s.closed) ops.push('h');
    }
    return ops;
  };

  const out = [];

  // 1. hatching over the areas that stay uncut (drawn first, so outlines sit on top)
  if (guide) {
    for (const k of guide.order.keep) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < k.pts.length; i += 2) {
        const px = fx(k.pts[i]), py = fy(k.pts[i + 1]);
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      let step = HATCH_MM * PT_PER_MM * Math.SQRT2; // spacing along y for 45 degree lines
      const lines = (y1 - y0 + (x1 - x0)) / step;
      if (lines > 6000) step *= lines / 6000; // keep huge regions from bloating the file
      // clip to the area, then (second clip, intersected) to everything outside its
      // children, so a child that pokes out of the area is never hatched
      out.push('q', ...pathOps([k.sub]), 'W* n');
      if (k.children.length) {
        out.push(`-10 -10 ${num(formW + 20)} ${num(formH + 20)} re`, ...pathOps(k.children.map((c) => c.sub)), 'W* n');
      }
      out.push('0.55 G', `${num(0.25 * PT_PER_MM)} w`);
      for (let c = y0 - x1; c <= y1 - x0; c += step) out.push(`${num(x0)} ${num(x0 + c)} m ${num(x1)} ${num(x1 + c)} l`);
      out.push('S', 'Q');
    }
  }

  // 2. the outlines themselves
  out.push(`${num(strokeMm * PT_PER_MM)} w`, '1 J', '1 j', '0 G', ...pathOps(subpaths), 'S');

  // 3. cut-order numbers, centred in the free part of each shape
  if (guide) {
    out.push('0.75 0.1 0.1 rg');
    for (const s of guide.order.cut) {
      const text = String(s.order);
      const { fsMm } = numberSize(text.length, s.label.d * scale);
      const size = fsMm * PT_PER_MM;
      const w = guide.font.widthOfTextAtSize(text, size);
      out.push('BT', `/F1 ${num(size)} Tf`, `${num(fx(s.label.x) - w / 2)} ${num(fy(s.label.y) - size * 0.36)} Td`, `(${text}) Tj`, 'ET');
    }
  }
  return out.join('\n');
}

/**
 * @param {object} o
 * @param {object[]} o.subpaths outline geometry in source units
 * @param {object} o.bbox       {minX,minY,w,h} of that geometry
 * @param {number} o.widthMm    requested real-world width of the artwork
 * @param {number} o.strokeMm   real-world line thickness
 * @param {'edge'|'bordered'} o.mode
 * @param {string} o.paper      key of PAPERS
 * @param {'portrait'|'landscape'} o.orientation
 * @param {boolean} o.overview  add an assembly-map page first
 * @param {object|null} [o.order] result of analyzeOrder(); when given, numbers and hatching are drawn
 * @param {string} [o.title]
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf({
  subpaths, bbox, widthMm, strokeMm, mode, paper, orientation, overview, order = null, title = 'Stencil',
}) {
  const PL = globalThis.PDFLib;
  if (!PL) throw new Error('PDF library failed to load.');
  const {
    PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState,
    concatTransformationMatrix, drawObject, rectangle, clip, endPath,
  } = PL;

  const scale = widthMm / bbox.w;
  const artW = widthMm, artH = bbox.h * scale;
  const L = computeLayout(artW, artH, paper, orientation, { mode, strokeMm });
  const { pw, ph, cols, rows, stepX, stepY, overlap, inset, winW, winH, bordered } = L;

  const doc = await PDFDocument.create();
  doc.setTitle(`${title} - stencil tiles`);
  doc.setProducer('Stencil Tiler');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const guide = order && !order.skipped && (order.cut.length || order.keep.length) ? { order, font: bold } : null;
  const form = doc.context.flateStream(artworkStream(subpaths, bbox, scale, L.gridH, strokeMm, guide), {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, L.gridW * PT_PER_MM, L.gridH * PT_PER_MM],
    Resources: guide ? { Font: { F1: bold.ref } } : {},
  });
  const formRef = doc.context.register(form);

  const PW = pw * PT_PER_MM, PH = ph * PT_PER_MM;

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
    // one wrapped note, so it stays on the page even on narrow paper such as 4x6
    page.drawText(
      `${cols} columns x ${rows} rows = ${L.pages} pages. Final size ${Math.round(artW)} x ${Math.round(artH)} mm. ` +
      'Print every page at 100% / Actual size.' +
      (bordered ? ' Cut off the margin along the cut marks where pages join.' : '') +
      (guide ? ' Red numbers = cut order (1 first, smallest inner details first). Grey hatching = leave uncut.' : ''),
      { x: m, y: PH - m - 22, size: 8, lineHeight: 10, maxWidth: PW - 2 * m, font, color: rgb(0.3, 0.3, 0.3) },
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
        const y = oyTop - (r * stepY + winH) * k;
        page.drawRectangle({
          x, y, width: winW * k, height: winH * k,
          borderColor: rgb(0.2, 0.45, 0.75), borderWidth: 0.6,
          color: rgb(0.2, 0.45, 0.75), opacity: 0.05, borderOpacity: 0.9,
        });
        const fsz = Math.max(5, Math.min(14, winW * k * 0.16));
        page.drawText(String(n), {
          x: x + 3, y: y + winH * k - fsz - 2, size: fsz, font: bold, color: rgb(0.1, 0.3, 0.6),
        });
        page.drawText(`R${r + 1}-C${c + 1}`, {
          x: x + 3, y: y + winH * k - fsz * 1.9 - 2, size: Math.max(4, fsz * 0.55), font, color: rgb(0.35, 0.35, 0.35),
        });
      }
    }
  }

  // ---- tile pages
  const grey = rgb(0.35, 0.35, 0.35);
  const black = rgb(0, 0, 0);
  const seg = (page, x1, y1, x2, y2, thickness, color) => page.drawLine({
    start: { x: x1 * PT_PER_MM, y: y1 * PT_PER_MM }, end: { x: x2 * PT_PER_MM, y: y2 * PT_PER_MM }, thickness, color,
  });

  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const page = doc.addPage([PW, PH]);
      const hasL = c > 0, hasR = c < cols - 1, hasT = r > 0, hasB = r < rows - 1;

      // Art point (X, Ydown) lands at page (inset + X - c*stepX, ph - inset - (Ydown - r*stepY)).
      const tx = (inset - c * stepX) * PT_PER_MM;
      const ty = (ph - inset - L.gridH + r * stepY) * PT_PER_MM;
      if (bordered) {
        // keep the margin blank: art only shows inside the window
        page.pushOperators(
          pushGraphicsState(),
          rectangle(inset * PT_PER_MM, inset * PT_PER_MM, winW * PT_PER_MM, winH * PT_PER_MM),
          clip(), endPath(),
        );
        placeArt(page, 1, 0, 0, 1, tx, ty);
        page.pushOperators(popGraphicsState());
      } else {
        placeArt(page, 1, 0, 0, 1, tx, ty);
      }

      if (bordered) {
        // Cut marks only where this page joins a neighbour. Each mark sits in the margin,
        // just outside the window corner, in line with the trim line (gap 1 mm, length 4 mm).
        const M = inset, gap = 1, len = 4, th = 0.45;
        const xl = M, xr = pw - M, yb = M, yt = ph - M;
        if (hasL || hasR) {
          for (const x of [hasL ? xl : null, hasR ? xr : null]) {
            if (x == null) continue;
            seg(page, x, yt + gap, x, yt + gap + len, th, black);
            seg(page, x, yb - gap, x, yb - gap - len, th, black);
          }
        }
        if (hasT || hasB) {
          for (const y of [hasT ? yt : null, hasB ? yb : null]) {
            if (y == null) continue;
            seg(page, xl - gap, y, xl - gap - len, y, th, black);
            seg(page, xr + gap, y, xr + gap + len, y, th, black);
          }
        }
        page.drawText(`R${r + 1}-C${c + 1}   ${n}/${L.pages}`, {
          x: (M + 3) * PT_PER_MM, y: 4 * PT_PER_MM, size: 7, font, color: grey,
        });
      } else {
        // Registration crosses sit mid-overlap, so the same cross appears at the same
        // art position on the neighbouring page: line the crosses up and tape.
        const half = overlap / 2, cross = 2;
        for (const [xs, ys, onX, onY] of [
          [half, ph - half, hasL, hasT], [pw - half, ph - half, hasR, hasT],
          [half, half, hasL, hasB], [pw - half, half, hasR, hasB],
        ]) {
          if (!onX && !onY) continue;
          seg(page, xs - cross, ys, xs + cross, ys, 0.35, grey);
          seg(page, xs, ys - cross, xs, ys + cross, 0.35, grey);
        }
        page.drawText(`R${r + 1}-C${c + 1}   ${n}/${L.pages}`, {
          x: (overlap + 2) * PT_PER_MM, y: (half - 1) * PT_PER_MM, size: 7, font, color: grey,
        });
      }
    }
  }

  return doc.save();
}
