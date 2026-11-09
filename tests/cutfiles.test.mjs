// Unit tests for the cut-file geometry and the ZIP writer (no browser needed).
// Run: node tests/cutfiles.test.mjs
import assert from 'node:assert/strict';
import { crc32 as nodeCrc32 } from 'node:zlib';
import {
  dashPolyline, buildDashes, pagePolylines, punchPolylines, toSvg, toDxf, CUT_MM, BRIDGE_MM,
} from '../js/cutfiles.js';
import { computeLayout } from '../js/tiling.js';
import { makeZip, crc32 } from '../js/zip.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 300)}`); }
};

const circlePts = (r, n = 720, cx = 0, cy = 0) => {
  const p = [];
  for (let i = 0; i <= n; i++) p.push(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n));
  return p;
};
const len = (p) => { let s = 0; for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return s; };
const ends = (p) => [[p[0], p[1]], [p[p.length - 2], p[p.length - 1]]];

test('closed loop: even dashes, bridges of the requested size, at least the expected count', () => {
  const r = 50, P = 2 * Math.PI * r;
  const d = dashPolyline(circlePts(r), true, { perforated: true, bridgeMm: 1.5 });
  const n = Math.round(P / (CUT_MM + 1.5));
  assert.equal(d.length, n);
  for (let i = 0; i < d.length; i++) {
    const [, e] = ends(d[i]); const [s] = ends(d[(i + 1) % d.length]);
    const gap = Math.hypot(e[0] - s[0], e[1] - s[1]);
    assert.ok(Math.abs(gap - 1.5) < 0.05, `bridge ${i} is ${gap.toFixed(3)} mm`);
  }
  const cutTotal = d.reduce((a, p) => a + len(p), 0);
  assert.ok(Math.abs(cutTotal - (P - n * 1.5)) < 0.5, `cut total ${cutTotal}`);
});

test('a tiny closed shape still gets three bridges', () => {
  const sq = [0, 0, 4, 0, 4, 4, 0, 4, 0, 0];
  assert.equal(dashPolyline(sq, true, { perforated: true, bridgeMm: 1.5 }).length, 3);
});

test('open line: starts and ends with a cut, bridges in between', () => {
  const d = dashPolyline([0, 0, 100, 0], false, { perforated: true, bridgeMm: 2.5 });
  assert.ok(d.length > 10);
  assert.ok(Math.abs(d[0][0] - 0) < 1e-9 && Math.abs(d[d.length - 1][d[d.length - 1].length - 2] - 100) < 1e-6);
  for (let i = 0; i + 1 < d.length; i++) {
    const gap = d[i + 1][0] - d[i][d[i].length - 2];
    assert.ok(Math.abs(gap - 2.5) < 0.01, `gap ${gap}`);
  }
});

test('full cut keeps the polyline whole', () => {
  const sq = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
  const d = dashPolyline(sq, true, { perforated: false });
  assert.equal(d.length, 1); assert.deepEqual(d[0], sq);
});

// A 100 x 100 mm square outline drawn at its real size, 2 mm line.
const square = { start: [0, 0], segs: [['L', 100, 0], ['L', 100, 100], ['L', 0, 100]], closed: true };
const bbox = { minX: 0, minY: 0, w: 100, h: 100 };

test('page coordinates match the PDF: outline starts one half-stroke inside the printed area', () => {
  // bordered A4: margin 15 mm (default), stroke 2 mm => the square's top-left corner is at 15 + 1 = 16 mm on page 1,1
  const L = computeLayout(100, 100, 'A4', 'portrait', { mode: 'bordered', strokeMm: 2 });
  const dashes = buildDashes([square], bbox, 100, 2, { perforated: false });
  const polys = pagePolylines(dashes, L, 0, 0);
  const xs = polys.flatMap((p) => p.filter((_, i) => i % 2 === 0)), ys = polys.flatMap((p) => p.filter((_, i) => i % 2 === 1));
  assert.ok(Math.abs(Math.min(...xs) - 16) < 1e-6 && Math.abs(Math.min(...ys) - 16) < 1e-6, `${Math.min(...xs)}, ${Math.min(...ys)}`);
  // edge to edge: no margin, so 0 + 1
  const E = computeLayout(100, 100, 'A4', 'portrait', { mode: 'edge', strokeMm: 2 });
  const pe = pagePolylines(dashes, E, 0, 0);
  assert.ok(Math.abs(Math.min(...pe.flatMap((p) => p.filter((_, i) => i % 2 === 0))) - 1) < 1e-6);
});

test('every cut stays inside the area the page prints, and pieces join across a seam', () => {
  const big = { start: [0, 0], segs: [['L', 400, 0], ['L', 400, 300], ['L', 0, 300]], closed: true };
  const bb = { minX: 0, minY: 0, w: 400, h: 300 };
  const L = computeLayout(400, 300, 'A4', 'portrait', { mode: 'bordered', strokeMm: 2 });
  const dashes = buildDashes([big], bb, 400, 2, { perforated: false });
  assert.ok(L.cols > 1 && L.rows > 1);
  let total = 0;
  for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
    const polys = pagePolylines(dashes, L, r, c);
    for (const p of polys) for (let i = 0; i < p.length; i += 2) {
      assert.ok(p[i] >= L.inset - 1e-6 && p[i] <= L.pw - L.inset + 1e-6 && p[i + 1] >= L.inset - 1e-6 && p[i + 1] <= L.ph - L.inset + 1e-6, `page ${r},${c} has a point outside the window`);
    }
    total += polys.reduce((a, p) => a + len(p), 0);
  }
  // bordered windows tile exactly, so the cut length over all pages equals the outline length (4 sides = 1400 mm)
  assert.ok(Math.abs(total - 1400) < 1, `total cut length ${total}`);
});

test('svg: sheet-sized, one path; dxf: LINE entities, flipped to y-up, ends with EOF', () => {
  const L = computeLayout(100, 100, 'A4', 'portrait', { mode: 'edge', strokeMm: 2 });
  const polys = [...pagePolylines(buildDashes([square], bbox, 100, 2, { perforated: true, bridgeMm: BRIDGE_MM.medium }), L, 0, 0), ...punchPolylines(L)];
  const svg = toSvg(polys, L);
  assert.ok(svg.includes('width="210mm"') && svg.includes('height="297mm"') && svg.includes('viewBox="0 0 210 297"'));
  assert.equal((svg.match(/<path /g) || []).length, 1);
  const dxf = toDxf(polys, L);
  assert.ok(dxf.trimEnd().endsWith('EOF') && dxf.includes('\nLINE\n'));
  // top-left punch corner (0,0) in page space is (0, 297) in DXF space
  assert.ok(dxf.includes('\n20\n297\n'));
});

test('corner punches make the file exactly the size of the sheet', () => {
  const L = computeLayout(100, 100, 'Letter', 'landscape', { mode: 'bordered', strokeMm: 2 });
  const all = punchPolylines(L).flat();
  const xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...xs) === 0 && Math.min(...ys) === 0 && Math.abs(Math.max(...xs) - L.pw) < 1e-9 && Math.abs(Math.max(...ys) - L.ph) < 1e-9);
});

test('zip: entries, sizes and checksums are right', () => {
  const enc = new TextEncoder();
  const files = [{ name: 'a.txt', data: enc.encode('hello') }, { name: 'dir/b.bin', data: new Uint8Array(1000).map((_, i) => i % 251) }];
  const zip = makeZip(files);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  let p = dv.getUint32(eocd + 16, true);
  for (const f of files) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    assert.equal(dv.getUint32(p + 16, true), nodeCrc32(f.data));
    assert.equal(dv.getUint32(p + 24, true), f.data.length);
    const nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    assert.equal(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nl)), f.name);
    const lnl = dv.getUint16(off + 26, true);
    assert.deepEqual(zip.subarray(off + 30 + lnl, off + 30 + lnl + f.data.length), f.data);
    p += 46 + nl;
  }
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

console.log(failed ? `\n${failed} test(s) failed` : '\nAll cut-file tests passed');
process.exit(failed ? 1 : 0);
