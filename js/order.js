// Cut-order analysis.
//
// Stencil logic: once you cut a big shape out, any paper that was inside it is gone
// (or loose), so it can no longer act as a stencil for the small details in there.
// So details nested inside a shape must be cut BEFORE the shape around them.
//
// We build the containment tree of all closed outlines, decide for each one whether it
// is a region to CUT or a region to KEEP (leave as paper), and number the cut regions
// deepest first.
//
//  - A filled shape nested directly inside another filled shape is a hole in it
//    (evenodd-style alternation: cut, keep, cut, keep, ...). That is how solid clip art
//    with white areas, rings and "eyes inside a face" is drawn.
//  - A shape that is only an outline (no fill) is always a region to cut: it is a
//    drawn line, not a hole.
//
// Everything here works in source (SVG) units and does not depend on print size.

const CURVE_STEPS = 10;
const MAX_SHAPES = 2000;
export const MIN_NUM_MM = 2.4;  // smallest number we will print
export const MAX_NUM_MM = 14;   // largest number we will print
export const HATCH_MM = 4;      // spacing of the "leave uncut" hatching

const bez = (a, b, c, d, t) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

function flatten(sub) {
  const pts = [sub.start[0], sub.start[1]];
  let x = sub.start[0], y = sub.start[1];
  for (const g of sub.segs) {
    if (g[0] === 'L') { pts.push(g[1], g[2]); x = g[1]; y = g[2]; continue; }
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS;
      pts.push(bez(x, g[1], g[3], g[5], t), bez(y, g[2], g[4], g[6], t));
    }
    x = g[5]; y = g[6];
  }
  const n = pts.length;
  if (n > 4 && Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) pts.length = n - 2;
  return pts;
}

function area(pts) {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  return Math.abs(a) / 2;
}

function bounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return { x0, y0, x1, y1 };
}

function inside(px, py, pts) {
  let c = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) c = !c;
  }
  return c;
}

// Is shape `a` nested inside shape `b`? Real artwork is rarely tidy: a star's tips may
// poke a little past the circle it sits in, a whisker may cross a head outline. So `a`
// counts as sitting in `b` when its core (the point deepest inside it) is inside `b`
// AND most of its outline is too. A shape that is only half inside is a neighbour.
const NESTED_FRACTION = 0.75;
function nestedIn(a, b) {
  if (a.bb.x0 > b.bb.x1 || a.bb.x1 < b.bb.x0 || a.bb.y0 > b.bb.y1 || a.bb.y1 < b.bb.y0) return false;
  if (!inside(a.core.x, a.core.y, b.pts)) return false;
  const n = a.pts.length / 2;
  const samples = Math.min(n, 12);
  let hit = 0;
  for (let k = 0; k < samples; k++) {
    const i = Math.floor((k * n) / samples);
    if (inside(a.pts[2 * i], a.pts[2 * i + 1], b.pts)) hit++;
  }
  return hit / samples >= NESTED_FRACTION;
}

// ---- pole of inaccessibility: the point in a region farthest from its edges (polylabel-style)

function segDistSq(px, py, ax, ay, bx, by) {
  let x = ax, y = ay, dx = bx - x, dy = by - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

function signedDist(px, py, rings) {
  let isIn = false, min = Infinity;
  for (const pts of rings) {
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) isIn = !isIn;
      const d = segDistSq(px, py, ax, ay, bx, by);
      if (d < min) min = d;
    }
  }
  const d = Math.sqrt(min);
  return isIn ? d : -d;
}

function labelPoint(rings, precision) {
  const bb = bounds(rings[0]);
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  const size = Math.min(w, h);
  if (!(size > 0)) return { x: bb.x0, y: bb.y0, d: 0 };
  const mk = (x, y, hh) => { const d = signedDist(x, y, rings); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };

  const heap = [];
  const push = (c) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].max >= heap[i].max) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const half = size / 2;
  for (let x = bb.x0; x < bb.x1; x += size) for (let y = bb.y0; y < bb.y1; y += size) push(mk(x + half, y + half, half));
  let best = mk(bb.x0 + w / 2, bb.y0 + h / 2, 0);
  for (let guard = 0; heap.length && guard < 6000; guard++) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const hh = c.h / 2;
    push(mk(c.x - hh, c.y - hh, hh)); push(mk(c.x + hh, c.y - hh, hh));
    push(mk(c.x - hh, c.y + hh, hh)); push(mk(c.x + hh, c.y + hh, hh));
  }
  return { x: best.x, y: best.y, d: Math.max(0, best.d) };
}

// ---- main

/**
 * @param {object[]} subpaths from parseSvg (each has start, segs, closed, filled)
 * @returns {{
 *   skipped: string|null, shapes: object[], cut: object[], keep: object[],
 *   passes: number, openCount: number, ignored: number
 * }}
 * Each shape: { sub, subIndex, filled, depth, role: 'cut'|'keep', parent, children[],
 *               order (1-based, cut shapes only), label {x, y, d} (cut shapes only), pts, area }
 */
export function analyzeOrder(subpaths) {
  const out = { skipped: null, shapes: [], cut: [], keep: [], passes: 0, openCount: 0, ignored: 0 };
  const all = [];
  subpaths.forEach((sub, subIndex) => {
    if (!sub.closed) { out.openCount++; return; }
    const pts = flatten(sub);
    if (pts.length < 6) { out.ignored++; return; }
    all.push({ sub, subIndex, filled: !!sub.filled, pts, area: area(pts), bb: bounds(pts), parent: null, children: [], depth: 0, role: 'cut' });
  });
  if (!all.length) return out;

  const maxArea = Math.max(...all.map((s) => s.area));
  const shapes = all.filter((s) => (s.area > maxArea * 1e-9 ? true : (out.ignored++, false)));
  if (shapes.length > MAX_SHAPES) {
    out.skipped = `This SVG has ${shapes.length} closed shapes, too many to number automatically (limit ${MAX_SHAPES}).`;
    return out;
  }

  for (const s of shapes) s.core = labelPoint([s.pts], Math.max(s.bb.x1 - s.bb.x0, s.bb.y1 - s.bb.y0) * 0.02);

  shapes.sort((a, b) => b.area - a.area);
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    // nearest container = smallest earlier (larger-area) shape that holds it
    for (let j = i - 1; j >= 0; j--) {
      if (nestedIn(s, shapes[j])) { s.parent = shapes[j]; break; }
    }
    if (s.parent) {
      s.depth = s.parent.depth + 1;
      s.parent.children.push(s);
      s.role = s.filled && s.parent.filled ? (s.parent.role === 'cut' ? 'keep' : 'cut') : 'cut';
    }
  }

  for (const s of shapes) {
    if (s.role !== 'cut') continue;
    const bb = s.bb;
    const precision = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.004;
    s.label = labelPoint([s.pts, ...s.children.map((c) => c.pts)], precision);
  }

  const cut = shapes.filter((s) => s.role === 'cut');
  cut.sort((a, b) => b.depth - a.depth || a.label.y - b.label.y || a.label.x - b.label.x);
  cut.forEach((s, i) => { s.order = i + 1; });

  out.shapes = shapes;
  out.cut = cut;
  out.keep = shapes.filter((s) => s.role === 'keep');
  out.passes = new Set(cut.map((s) => s.depth)).size;
  return out;
}

/** Print size of a cut-order number for a region whose free radius is rMm. */
export function numberSize(digits, rMm) {
  const k = Math.hypot(0.278 * digits, 0.36); // half-diagonal of the text box, per mm of font size
  const fit = (0.9 * rMm) / k;
  return { fsMm: Math.min(MAX_NUM_MM, Math.max(MIN_NUM_MM, fit)), tiny: fit < MIN_NUM_MM };
}
