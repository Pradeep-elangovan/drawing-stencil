// Units, paper sizes and tile layout maths. Everything here is in millimetres.

export const STROKE_MM = 2;   // fixed outline thickness at real-world scale
export const OVERLAP_MM = 10; // shared strip between neighbouring pages
export const PT_PER_MM = 72 / 25.4;
export const MAX_PAGES = 1000;
export const WARN_PAGES = 100;

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
 * artW/artH: artwork size in mm (geometry only, without stroke).
 * The grid covers the artwork plus half a stroke on every side so the outer
 * edge of the line is never clipped.
 */
export function computeLayout(artW, artH, paper, orientation, overlap = OVERLAP_MM) {
  const { pw, ph } = pageDims(paper, orientation);
  const gridW = artW + STROKE_MM, gridH = artH + STROKE_MM;
  const stepX = pw - overlap, stepY = ph - overlap;
  const eps = 1e-9;
  const cols = gridW <= pw + eps ? 1 : Math.ceil((gridW - overlap) / stepX - eps);
  const rows = gridH <= ph + eps ? 1 : Math.ceil((gridH - overlap) / stepY - eps);
  return {
    pw, ph, overlap, gridW, gridH, stepX, stepY, cols, rows,
    pages: cols * rows,
    totalW: (cols - 1) * stepX + pw,
    totalH: (rows - 1) * stepY + ph,
  };
}
