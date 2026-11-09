// Units, paper sizes and tile layout maths. Everything here is in millimetres.

export const PT_PER_MM = 72 / 25.4;
export const MAX_PAGES = 1000;
export const WARN_PAGES = 100;

// Edge-to-edge: neighbouring pages share this strip so slight paper drift never leaves a gap.
export const OVERLAP_MM = 10;
// Bordered: blank margin kept on every page for printers that cannot print to the edge.
// Home printers typically lose 3-6 mm on three sides and more at the bottom (some inkjets
// 12 mm or more), and cut marks plus the page number live inside this margin, so the
// default is 15 mm. 10 mm is the minimum.
export const MARGIN_OPTIONS_MM = [10, 12.7, 15, 20];
export const MARGIN_DEFAULT_MM = 15;

// Line thickness is chosen by the user and is a real-world size, independent of artwork size.
export const STROKE_DEFAULT_MM = 2;
export const STROKE_MIN_MM = 0.1;
export const STROKE_MAX_MM = 100;
export const STROKE_UNITS = { mm: 1, cm: 10, in: 25.4 };

export const MM_PER = { ft: 304.8, in: 25.4, cm: 10, m: 1000 };

// [short side, long side] in mm
export const PAPERS = {
  A5: [148, 210],
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
  '4x6': [101.6, 152.4],
  '5x7': [127, 177.8],
};

export function paperLabel(key) {
  const [a, b] = PAPERS[key];
  const inch = ['Letter', 'Legal', 'Tabloid', '4x6', '5x7'].includes(key);
  const f = (v) => String(Math.round((inch ? v / 25.4 : v) * 100) / 100);
  const name = key === '4x6' ? '4 x 6 in' : key === '5x7' ? '5 x 7 in' : key;
  return `${name} (${f(a)} x ${f(b)} ${inch ? 'in' : 'mm'})`;
}

export function pageDims(paper, orientation) {
  const [a, b] = PAPERS[paper];
  return orientation === 'landscape' ? { pw: b, ph: a } : { pw: a, ph: b };
}

/**
 * Grid of pages needed to cover an artwork.
 *
 * Each page shows a "window" of the artwork:
 *  - mode 'edge':     the window is the whole page; neighbours overlap by OVERLAP_MM.
 *  - mode 'bordered': the window is the page minus the margin on every side; windows
 *                     tile exactly (no overlap). On sides that touch a neighbour the
 *                     margin is cut off along the cut marks; on the outside it stays.
 *
 * artW/artH: artwork geometry in mm. The grid adds half a stroke on every side
 * so the outer edge of the line is never clipped.
 */
export function computeLayout(artW, artH, paper, orientation, { mode = 'edge', strokeMm = STROKE_DEFAULT_MM, marginMm = MARGIN_DEFAULT_MM } = {}) {
  const { pw, ph } = pageDims(paper, orientation);
  const bordered = mode === 'bordered';
  const inset = bordered ? marginMm : 0;
  const overlap = bordered ? 0 : OVERLAP_MM;
  const winW = pw - 2 * inset, winH = ph - 2 * inset;
  const gridW = artW + strokeMm, gridH = artH + strokeMm;
  const stepX = winW - overlap, stepY = winH - overlap;
  const eps = 1e-9;
  const cols = gridW <= winW + eps ? 1 : Math.ceil((gridW - overlap) / stepX - eps);
  const rows = gridH <= winH + eps ? 1 : Math.ceil((gridH - overlap) / stepY - eps);
  return {
    mode, bordered, strokeMm, pw, ph, inset, overlap, winW, winH, gridW, gridH, stepX, stepY, cols, rows,
    pages: cols * rows,
    totalW: (cols - 1) * stepX + winW,
    totalH: (rows - 1) * stepY + winH,
  };
}
