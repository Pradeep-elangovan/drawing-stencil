// Cut files for cutting machines (Cricut, Silhouette, ScanNCut, ...).
//
// One file per printed page. Each file is exactly the size of the sheet and holds only
// the outline cuts that fall on that page, in the same position as the printed outline.
//
// "Spotted" cuts: every outline is cut as short dashes with small uncut bridges between
// them, so shapes stay attached until you tear them out along the perforation. The
// dashes are real geometry (not an SVG dash style) because cutting software ignores
// stroke-dasharray.
//
// Four tiny square punches sit at the corners of the sheet. They make the file's
// bounding box equal the sheet, so "top-left of the file = top-left of the sheet".
//
// Units: millimetres. Page space: origin top-left, y down (like SVG).

export const CUT_MM = 5;                                      // length of each cut dash
export const BRIDGE_MM = { small: 1, medium: 1.5, large: 2.5 }; // uncut gap between dashes
export const PUNCH_MM = 2;                                    // corner punch size

const f3 = (v) => String(Math.round(v * 1000) / 1000);
const bez = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };

/** Flatten a subpath to a polyline in artwork-mm (origin = top-left of the artwork grid). */
function flattenMm(sub, bbox, scale, pad) {
  const X = (x) => (x - bbox.minX) * scale + pad;
  const Y = (y) => (y - bbox.minY) * scale + pad;
  const pts = [X(sub.start[0]), Y(sub.start[1])];
  let x = pts[0], y = pts[1];
  for (const g of sub.segs) {
    if (g[0] === 'L') { x = X(g[1]); y = Y(g[2]); pts.push(x, y); continue; }
    const x1 = X(g[1]), y1 = Y(g[2]), x2 = X(g[3]), y2 = Y(g[4]), x3 = X(g[5]), y3 = Y(g[6]);
    const est = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.min(400, Math.max(6, Math.ceil(est / 0.8)));
    for (let k = 1; k <= n; k++) { const t = k / n; pts.push(bez(x, x1, x2, x3, t), bez(y, y1, y2, y3, t)); }
    x = x3; y = y3;
  }
  if (sub.closed && (Math.abs(pts[0] - x) > 1e-9 || Math.abs(pts[1] - y) > 1e-9)) pts.push(pts[0], pts[1]);
  return pts;
}

// Points of the polyline between arc lengths s0 and s1 (dashes are requested in increasing order).
function makeSlicer(pts) {
  const n = pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  let seg = 0;
  const at = (s, i) => {
    const span = cum[i + 1] - cum[i] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[i]) / span));
    return [pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t, pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t];
  };
  return {
    length: cum[n - 1],
    slice(s0, s1) {
      while (seg < n - 2 && cum[seg + 1] < s0) seg++;
      const out = at(s0, seg);
      let i = seg;
      while (i < n - 2 && cum[i + 1] < s1) { i++; out.push(pts[2 * i], pts[2 * i + 1]); }
      out.push(...at(s1, Math.min(i, n - 2)));
      return out;
    },
  };
}

/**
 * Turn one polyline into cut pieces. Perforated: dashes of about CUT_MM with `bridgeMm`
 * gaps, spaced evenly so a closed loop gets at least three bridges and an open line
 * starts and ends with a cut. Full: the polyline unchanged.
 */
export function dashPolyline(pts, closed, { perforated = true, bridgeMm = BRIDGE_MM.medium } = {}) {
  if (pts.length < 4) return [];
  if (!perforated) return [pts];
  const sl = makeSlicer(pts);
  const P = sl.length;
  if (!(P > 0)) return [];
  const out = [];
  if (closed) {
    const n = Math.max(3, Math.round(P / (CUT_MM + bridgeMm)));
    const unit = P / n;
    const br = Math.min(bridgeMm, unit * 0.4);
    const cut = unit - br;
    for (let i = 0; i < n; i++) out.push(sl.slice(br / 2 + i * unit, br / 2 + i * unit + cut));
  } else {
    const n = Math.max(1, Math.round((P + bridgeMm) / (CUT_MM + bridgeMm)));
    const br = n > 1 ? Math.min(bridgeMm, (P / (n - 1)) * 0.4) : 0;
    const cut = (P - (n - 1) * br) / n;
    for (let i = 0; i < n; i++) out.push(sl.slice(i * (cut + br), i * (cut + br) + cut));
  }
  return out;
}

/** All cut pieces of the artwork, in artwork-mm, each with a bounding box. */
export function buildDashes(subpaths, bbox, widthMm, strokeMm, opts) {
  const scale = widthMm / bbox.w;
  const pad = strokeMm / 2;
  const out = [];
  for (const sub of subpaths) {
    const pts = flattenMm(sub, bbox, scale, pad);
    for (const piece of dashPolyline(pts, sub.closed, opts)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < piece.length; i += 2) {
        if (piece[i] < x0) x0 = piece[i]; if (piece[i] > x1) x1 = piece[i];
        if (piece[i + 1] < y0) y0 = piece[i + 1]; if (piece[i + 1] > y1) y1 = piece[i + 1];
      }
      out.push({ pts: piece, x0, y0, x1, y1 });
    }
  }
  return out;
}

// Liang-Barsky: the part of segment a->b inside the rectangle, or null.
function clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return { t0, t1 };
}

function clipPolyline(pts, x0, y0, x1, y1) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    const c = clipSegment(ax, ay, bx, by, x0, y0, x1, y1);
    if (!c) { cur = null; continue; }
    const sx = ax + (bx - ax) * c.t0, sy = ay + (by - ay) * c.t0;
    const ex = ax + (bx - ax) * c.t1, ey = ay + (by - ay) * c.t1;
    if (cur && c.t0 === 0) cur.push(ex, ey);
    else { cur = [sx, sy, ex, ey]; out.push(cur); }
    if (c.t1 < 1) cur = null;
  }
  return out.filter((p) => p.length >= 4 && (Math.abs(p[0] - p[p.length - 2]) + Math.abs(p[1] - p[p.length - 1]) > 1e-6 || p.length > 4));
}

/** The four corner punches as closed squares in page coordinates. */
export function punchPolylines(L) {
  const s = PUNCH_MM, { pw, ph } = L;
  const sq = (x, y) => [x, y, x + s, y, x + s, y + s, x, y + s, x, y];
  return [sq(0, 0), sq(pw - s, 0), sq(0, ph - s), sq(pw - s, ph - s)];
}

/**
 * Cut pieces that land on page (r, c), in page coordinates, clipped to the area that
 * page actually prints (the whole sheet, or the sheet minus its margin when bordered).
 */
export function pagePolylines(dashes, L, r, c) {
  const ox = L.inset - c * L.stepX, oy = L.inset - r * L.stepY;
  const x0 = L.inset, y0 = L.inset, x1 = L.pw - L.inset, y1 = L.ph - L.inset;
  const out = [];
  for (const d of dashes) {
    if (d.x1 + ox < x0 || d.x0 + ox > x1 || d.y1 + oy < y0 || d.y0 + oy > y1) continue;
    const moved = new Array(d.pts.length);
    for (let i = 0; i < d.pts.length; i += 2) { moved[i] = d.pts[i] + ox; moved[i + 1] = d.pts[i + 1] + oy; }
    out.push(...clipPolyline(moved, x0, y0, x1, y1));
  }
  return out;
}

/** SVG for one page, sized exactly to the sheet. Single black hairline path = one cut layer. */
export function toSvg(polys, L) {
  let d = '';
  for (const p of polys) {
    d += `M${f3(p[0])} ${f3(p[1])}`;
    for (let i = 2; i < p.length; i += 2) d += `L${f3(p[i])} ${f3(p[i + 1])}`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f3(L.pw)}mm" height="${f3(L.ph)}mm" viewBox="0 0 ${f3(L.pw)} ${f3(L.ph)}">\n` +
    `<path id="cuts" fill="none" stroke="#000000" stroke-width="0.1" stroke-linecap="butt" stroke-linejoin="miter" d="${d}"/>\n</svg>\n`;
}

/** DXF (R12-style, LINE entities, millimetres, y up) for cutters that prefer DXF. */
export function toDxf(polys, L) {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES'];
  for (const p of polys) {
    for (let i = 0; i + 3 < p.length; i += 2) {
      out.push('0', 'LINE', '8', 'CUT',
        '10', f3(p[i]), '20', f3(L.ph - p[i + 1]), '30', '0',
        '11', f3(p[i + 2]), '21', f3(L.ph - p[i + 3]), '31', '0');
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}
