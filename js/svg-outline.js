// SVG -> outline geometry.
//
// Reads an SVG string and returns every visible shape as a list of subpaths in
// absolute user-unit coordinates (transforms applied, arcs/quadratics converted
// to cubic Beziers). Shapes are kept separate: nothing is merged or boolean-ed.
// Fills are discarded; a filled shape contributes its boundary, a stroked-only
// shape contributes its centre line. The caller strokes everything at a fixed width.

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const GROUPS = new Set(['g', 'svg', 'a', 'switch']);
const XLINK = 'http://www.w3.org/1999/xlink';
const STYLE_PROPS = ['fill', 'stroke', 'visibility', 'fill-opacity', 'stroke-opacity', 'display', 'opacity'];

// ---------------------------------------------------------------- matrices

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function parseTransform(str) {
  let m = IDENTITY;
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))) {
    const a = hit[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = null;
    switch (hit[1]) {
      case 'matrix': if (a.length >= 6) t = a.slice(0, 6); break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        t = [c, s, -s, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    if (t && t.every(Number.isFinite)) m = mul(m, t);
  }
  return m;
}

const px = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---------------------------------------------------------------- path data

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cosp = Math.cos(phi), sinp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosp * dx + sinp * dy, y1p = -sinp * dx + cosp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const rx2 = rx * rx, ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let co = Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
  const cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  else if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const delta = dth / n, t = (4 / 3) * Math.tan(delta / 4);
  const map = (u, v) => [cosp * rx * u - sinp * ry * v + cx, sinp * rx * u + cosp * ry * v + cy];
  const out = [];
  let a = th1;
  for (let k = 0; k < n; k++) {
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(a + delta), sb = Math.sin(a + delta);
    out.push(['C', ...map(ca - t * sa, sa + t * ca), ...map(cb + t * sb, sb - t * cb), ...map(cb, sb)]);
    a += delta;
  }
  const last = out[out.length - 1];
  last[5] = x2; last[6] = y2;
  return out;
}

// Returns [{start:[x,y], segs:[['L',x,y] | ['C',x1,y1,x2,y2,x,y]], closed}]
// Tolerant: stops quietly at the first malformed token and keeps what it has.
function parsePathData(d) {
  const subs = [];
  const n = d.length;
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, cur = null;
  let lastCtl = null, lastQ = null, prev = '';

  const ws = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    ws(); NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return NaN;
    i = NUM.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = () => {
    ws();
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1' ? 1 : 0;
    return NaN;
  };
  const ensure = () => {
    if (!cur) { cur = { start: [cx, cy], segs: [], closed: false }; subs.push(cur); }
  };

  while (true) {
    ws();
    if (i >= n) break;
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) { cmd = ch; i++; }
    else if (cmd === null || cmd === 'Z' || cmd === 'z') break;

    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let ok = true;

    if (C === 'Z') {
      if (cur) cur.closed = true;
      cx = sx; cy = sy; cur = null; prev = 'Z'; lastCtl = lastQ = null;
      continue;
    }
    if (C === 'M') {
      const x = num() + ox, y = num() + oy;
      if (!Number.isFinite(x + y)) break;
      cur = { start: [x, y], segs: [], closed: false };
      subs.push(cur);
      cx = sx = x; cy = sy = y;
      cmd = rel ? 'l' : 'L'; // extra pairs after M are implicit lineto
      prev = 'M'; lastCtl = lastQ = null;
    } else if (C === 'L' || C === 'H' || C === 'V') {
      let x = cx, y = cy;
      if (C === 'L') { x = num() + ox; y = num() + oy; }
      else if (C === 'H') x = num() + ox;
      else y = num() + oy;
      if (!Number.isFinite(x + y)) break;
      ensure(); cur.segs.push(['L', x, y]);
      cx = x; cy = y; prev = 'L'; lastCtl = lastQ = null;
    } else if (C === 'C' || C === 'S') {
      let x1, y1;
      if (C === 'C') { x1 = num() + ox; y1 = num() + oy; }
      else if (prev === 'C' && lastCtl) { x1 = 2 * cx - lastCtl[0]; y1 = 2 * cy - lastCtl[1]; }
      else { x1 = cx; y1 = cy; }
      const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
      if (!Number.isFinite(x1 + y1 + x2 + y2 + x + y)) break;
      ensure(); cur.segs.push(['C', x1, y1, x2, y2, x, y]);
      lastCtl = [x2, y2]; cx = x; cy = y; prev = 'C'; lastQ = null;
    } else if (C === 'Q' || C === 'T') {
      let qx, qy;
      if (C === 'Q') { qx = num() + ox; qy = num() + oy; }
      else if (prev === 'Q' && lastQ) { qx = 2 * cx - lastQ[0]; qy = 2 * cy - lastQ[1]; }
      else { qx = cx; qy = cy; }
      const x = num() + ox, y = num() + oy;
      if (!Number.isFinite(qx + qy + x + y)) break;
      ensure();
      cur.segs.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]);
      lastQ = [qx, qy]; cx = x; cy = y; prev = 'Q'; lastCtl = null;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag();
      const x = num() + ox, y = num() + oy;
      if (!Number.isFinite(rx + ry + rot + fa + fs + x + y)) break;
      ensure();
      for (const s of arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y)) cur.segs.push(s);
      cx = x; cy = y; prev = 'A'; lastCtl = lastQ = null;
    } else {
      ok = false;
    }
    if (!ok) break;
  }
  return subs.filter((s) => s.segs.length > 0);
}

// ---------------------------------------------------------------- styles

function parseDecls(text) {
  const out = {};
  for (const part of text.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const name = part.slice(0, k).trim().toLowerCase();
    if (STYLE_PROPS.includes(name)) out[name] = part.slice(k + 1).replace(/!important/i, '').trim();
  }
  return out;
}

function parseStyleSheets(doc) {
  const rules = [];
  for (const el of doc.querySelectorAll('style')) {
    const css = (el.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const decls = parseDecls(m[2]);
      if (!Object.keys(decls).length) continue;
      for (const raw of m[1].split(',')) {
        const sel = raw.trim();
        if (/^[.#]?[\w-]+$/.test(sel) || /^[\w-]+\.[\w-]+$/.test(sel)) rules.push({ sel, decls });
      }
    }
  }
  return rules;
}

function matches(sel, el) {
  if (sel[0] === '.') return el.classList.contains(sel.slice(1));
  if (sel[0] === '#') return el.getAttribute('id') === sel.slice(1);
  const dot = sel.indexOf('.');
  if (dot > 0) return el.localName === sel.slice(0, dot) && el.classList.contains(sel.slice(dot + 1));
  return el.localName === sel;
}

function resolveStyle(el, parent, rules) {
  const s = {
    fill: parent.fill, stroke: parent.stroke, visibility: parent.visibility,
    'fill-opacity': parent['fill-opacity'], 'stroke-opacity': parent['stroke-opacity'],
    display: 'inline', opacity: 1,
  };
  const set = (k, v) => {
    v = String(v).trim().toLowerCase();
    if (!v || v === 'inherit') return;
    if (k === 'opacity' || k.endsWith('-opacity')) { const f = parseFloat(v); if (!Number.isNaN(f)) s[k] = f; }
    else s[k] = v;
  };
  for (const k of STYLE_PROPS) if (el.hasAttribute(k)) set(k, el.getAttribute(k));
  for (const r of rules) if (matches(r.sel, el)) for (const k in r.decls) set(k, r.decls[k]);
  const inline = el.getAttribute('style');
  if (inline) { const d = parseDecls(inline); for (const k in d) set(k, d[k]); }
  return s;
}

const paintVisible = (v, a) =>
  v !== 'none' && v !== 'transparent' && a !== 0 && !/^rgba\(.*,\s*0(\.0+)?\s*\)$/.test(v);

// ---------------------------------------------------------------- shapes

function len(v, def, ref) {
  if (v == null || v === '') return def;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i.exec(v);
  if (!m) return def;
  let n = parseFloat(m[1]);
  switch ((m[2] || '').toLowerCase()) {
    case 'pt': n *= 4 / 3; break;
    case 'pc': n *= 16; break;
    case 'mm': n *= 96 / 25.4; break;
    case 'cm': n *= 96 / 2.54; break;
    case 'in': n *= 96; break;
    case 'em': n *= 16; break;
    case 'ex': n *= 8; break;
    case '%': n = (n / 100) * ref; break;
  }
  return n;
}

function shapeToD(el, tag, vb) {
  const g = (name, def = 0, ref = vb.w) => len(el.getAttribute(name), def, ref);
  switch (tag) {
    case 'path': return el.getAttribute('d') || '';
    case 'rect': {
      const x = g('x'), y = g('y'), w = g('width'), h = g('height', 0, vb.h);
      if (!(w > 0 && h > 0)) return '';
      let rx = el.hasAttribute('rx') ? g('rx') : null;
      let ry = el.hasAttribute('ry') ? g('ry', 0, vb.h) : null;
      if (rx == null && ry == null) { rx = 0; ry = 0; }
      else if (rx == null) rx = ry;
      else if (ry == null) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2); ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle': case 'ellipse': {
      const cx = g('cx'), cy = g('cy', 0, vb.h);
      const rx = tag === 'circle' ? g('r', 0, Math.hypot(vb.w, vb.h) / Math.SQRT2) : g('rx');
      const ry = tag === 'circle' ? rx : g('ry', 0, vb.h);
      if (!(rx > 0 && ry > 0)) return '';
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}Z`;
    }
    case 'line':
      return `M${g('x1')} ${g('y1', 0, vb.h)}L${g('x2')} ${g('y2', 0, vb.h)}`;
    case 'polyline': case 'polygon': {
      const v = (el.getAttribute('points') || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
      if (!v || v.length < 4) return '';
      let d = `M${v[0]} ${v[1]}`;
      for (let k = 2; k + 1 < v.length; k += 2) d += `L${v[k]} ${v[k + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
  }
  return '';
}

// ---------------------------------------------------------------- geometry

function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  const out = [];
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); }
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) { const r = Math.sqrt(disc); out.push((-b + r) / (2 * a), (-b - r) / (2 * a)); }
  }
  return out.filter((t) => t > 0 && t < 1);
}

function growBBox(bb, x, y) {
  if (x < bb.minX) bb.minX = x;
  if (y < bb.minY) bb.minY = y;
  if (x > bb.maxX) bb.maxX = x;
  if (y > bb.maxY) bb.maxY = y;
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function bboxOf(subs) {
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of subs) {
    let [px0, py0] = s.start;
    growBBox(bb, px0, py0);
    for (const g of s.segs) {
      if (g[0] === 'L') { growBBox(bb, g[1], g[2]); px0 = g[1]; py0 = g[2]; continue; }
      const [, x1, y1, x2, y2, x, y] = g;
      growBBox(bb, x, y);
      for (const t of cubicExtrema(px0, x1, x2, x)) growBBox(bb, bezier(px0, x1, x2, x, t), bezier(py0, y1, y2, y, t));
      for (const t of cubicExtrema(py0, y1, y2, y)) growBBox(bb, bezier(px0, x1, x2, x, t), bezier(py0, y1, y2, y, t));
      px0 = x; py0 = y;
    }
  }
  return bb;
}

function transformSub(sub, m) {
  const segs = sub.segs.map((g) => {
    if (g[0] === 'L') return ['L', ...px(m, g[1], g[2])];
    return ['C', ...px(m, g[1], g[2]), ...px(m, g[3], g[4]), ...px(m, g[5], g[6])];
  });
  return { start: px(m, sub.start[0], sub.start[1]), segs, closed: sub.closed };
}

// ---------------------------------------------------------------- main

/**
 * @param {string} text SVG source
 * @returns {{subpaths: object[], bbox: object, warnings: string[], stats: object}}
 */
export function parseSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || !root || root.localName.toLowerCase() !== 'svg') {
    throw new Error('That file is not a valid SVG.');
  }

  const vbAttr = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vb = vbAttr.length === 4 && vbAttr.every(Number.isFinite)
    ? { w: vbAttr[2], h: vbAttr[3] }
    : { w: len(root.getAttribute('width'), 100, 100), h: len(root.getAttribute('height'), 100, 100) };

  const rules = parseStyleSheets(doc);
  const ids = new Map();
  for (const el of doc.querySelectorAll('[id]')) ids.set(el.getAttribute('id'), el);

  const subpaths = [];
  const fx = new Set();
  let shapes = 0;

  const rootStyle = {
    fill: 'black', stroke: 'none', visibility: 'visible', 'fill-opacity': 1, 'stroke-opacity': 1,
  };

  function walk(el, parent, m, depth) {
    if (depth > 40) return;
    const tag = el.localName.toLowerCase();
    const isUse = tag === 'use';
    if (!SHAPES.has(tag) && !GROUPS.has(tag) && !isUse) return;

    const style = resolveStyle(el, parent, rules);
    if (style.display === 'none' || style.opacity === 0) return;
    for (const a of ['clip-path', 'mask', 'filter']) if (el.hasAttribute(a)) fx.add(a);

    let mm = mul(m, parseTransform(el.getAttribute('transform')));

    if (isUse) {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '';
      const target = href.startsWith('#') ? ids.get(href.slice(1)) : null;
      if (!target) return;
      mm = mul(mm, [1, 0, 0, 1, len(el.getAttribute('x'), 0, vb.w), len(el.getAttribute('y'), 0, vb.h)]);
      const t = target.localName.toLowerCase();
      if (t === 'symbol') for (const c of target.children) walk(c, style, mm, depth + 1);
      else walk(target, style, mm, depth + 1);
      return;
    }

    if (GROUPS.has(tag)) {
      for (const c of el.children) walk(c, style, mm, depth + 1);
      return;
    }

    if (style.visibility === 'hidden' || style.visibility === 'collapse') return;
    const fillOn = paintVisible(style.fill, style['fill-opacity']);
    const strokeOn = paintVisible(style.stroke, style['stroke-opacity']);
    if (!fillOn && !strokeOn) return;

    const d = shapeToD(el, tag, vb);
    if (!d) return;
    const subs = parsePathData(d);
    if (!subs.length) return;
    shapes++;
    for (const s of subs) {
      const t = transformSub(s, mm);
      // A filled shape's outline is its closed boundary, even if the path was left open.
      if (fillOn) t.closed = true;
      subpaths.push(t);
    }
  }

  walk(root, rootStyle, IDENTITY, 0);

  const warnings = [];
  const texts = doc.querySelectorAll('text').length;
  if (texts) warnings.push(`${texts} text element${texts > 1 ? 's' : ''} skipped. Convert text to paths first (Inkscape: Path > Object to Path; Illustrator: Type > Create Outlines).`);
  const images = doc.querySelectorAll('image').length;
  if (images) warnings.push(`${images} embedded image${images > 1 ? 's' : ''} ignored (only vector shapes are outlined).`);
  if (fx.size) warnings.push(`${[...fx].join(', ')} ignored; shapes are outlined as if unclipped and unfiltered.`);

  if (!subpaths.length) throw new Error('No drawable shapes found in this SVG.');

  const bbox = bboxOf(subpaths);
  const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
  if (!(w > 1e-9 && h > 1e-9)) throw new Error('The artwork has no width or no height (it is a straight line or a point).');

  const segments = subpaths.reduce((n, s) => n + s.segs.length, 0);
  return { subpaths, bbox: { ...bbox, w, h }, warnings, stats: { shapes, subpaths: subpaths.length, segments } };
}

/** Build an SVG path "d" string for preview use (coordinates unchanged). */
export function toPathD(subpaths) {
  const f = (v) => String(Math.round(v * 1000) / 1000);
  let d = '';
  for (const s of subpaths) {
    d += `M${f(s.start[0])} ${f(s.start[1])}`;
    for (const g of s.segs) {
      d += g[0] === 'L' ? `L${f(g[1])} ${f(g[2])}` : `C${f(g[1])} ${f(g[2])} ${f(g[3])} ${f(g[4])} ${f(g[5])} ${f(g[6])}`;
    }
    if (s.closed) d += 'Z';
  }
  return d;
}
