// Unit tests for the cut-order analysis (pure geometry, no browser).
// Run: node tests/order.test.mjs
import assert from 'node:assert/strict';
import { analyzeOrder, numberSize } from '../js/order.js';

const poly = (pts, { filled = true, closed = true } = {}) => ({
  start: pts[0], segs: pts.slice(1).map(([x, y]) => ['L', x, y]), closed, filled,
});
const rect = (x, y, w, h, o) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], o);
const circle = (cx, cy, r, o, n = 40) =>
  poly(Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]), o);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const byIdx = (r) => Object.fromEntries(r.shapes.map((s) => [s.subIndex, s]));

test('ring with a star in its hole: star is cut first, hole is kept', () => {
  // 0 ring outer, 1 ring hole (white), 2 star inside the hole
  const r = analyzeOrder([circle(100, 100, 95), circle(100, 100, 78), circle(100, 100, 30)]);
  const s = byIdx(r);
  assert.equal(s[0].role, 'cut'); assert.equal(s[1].role, 'keep'); assert.equal(s[2].role, 'cut');
  assert.equal(s[2].order, 1); assert.equal(s[0].order, 2);
  assert.equal(r.cut.length, 2); assert.equal(r.keep.length, 1); assert.equal(r.passes, 2);
});

test('five nested squares alternate cut/keep and are cut innermost first', () => {
  const subs = [0, 1, 2, 3, 4].map((i) => rect(i * 10, i * 10, 200 - i * 20, 200 - i * 20));
  const r = analyzeOrder(subs);
  const s = byIdx(r);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => s[i].role), ['cut', 'keep', 'cut', 'keep', 'cut']);
  assert.deepEqual([4, 2, 0].map((i) => s[i].order), [1, 2, 3]);
});

test('outline-only face with eyes: every outline is cut, eyes before face', () => {
  const o = { filled: false };
  const r = analyzeOrder([circle(100, 100, 90, o), circle(70, 90, 12, o), circle(130, 90, 12, o), circle(100, 130, 8, o)]);
  const s = byIdx(r);
  assert.ok([0, 1, 2, 3].every((i) => s[i].role === 'cut'));
  assert.equal(s[0].order, 4);
  assert.deepEqual([1, 2, 3].map((i) => s[i].order).sort(), [1, 2, 3]);
  assert.equal(r.keep.length, 0);
});

test('overlapping (not nested) shapes are siblings', () => {
  const r = analyzeOrder([circle(50, 50, 40), circle(100, 50, 40)]);
  assert.ok(r.shapes.every((s) => s.depth === 0 && s.role === 'cut'));
});

test('open paths are counted but not numbered', () => {
  const r = analyzeOrder([circle(50, 50, 40), poly([[0, 0], [10, 10]], { closed: false, filled: false })]);
  assert.equal(r.openCount, 1); assert.equal(r.cut.length, 1);
});

test('label point lies inside its shape and outside the holes', () => {
  const sq = rect(0, 0, 200, 200);
  const hole = circle(100, 100, 70);
  const r = analyzeOrder([sq, hole]);
  const L = byIdx(r)[0].label;
  const d = Math.hypot(L.x - 100, L.y - 100);
  assert.ok(d > 70 && L.x > 0 && L.x < 200 && L.y > 0 && L.y < 200, `label at ${L.x},${L.y}`);
  assert.ok(L.d > 20, `free radius ${L.d}`); // the ring-shaped band between square and circle
});

test('a stroke-only outline inside a filled shape is still cut (not a hole)', () => {
  const r = analyzeOrder([circle(100, 100, 90), circle(100, 100, 30, { filled: false })]);
  assert.equal(byIdx(r)[1].role, 'cut');
});

test('a star with two tips poking slightly out of its circle is still inside it', () => {
  // the sample star: tips at (55,165) and (145,165) sit just past the r=78 circle (79.1 away)
  const star = poly([[100, 28], [119, 78], [172, 80], [130, 113], [145, 165], [100, 135], [55, 165], [70, 113], [28, 80], [81, 78]]);
  const r = analyzeOrder([circle(100, 100, 95), circle(100, 100, 78), star]);
  const s = byIdx(r);
  assert.ok(s[2].parent === s[1], 'star should sit in the white circle');
  assert.equal(s[1].role, 'keep'); assert.equal(s[2].role, 'cut');
});

test('a shape only half inside another is a neighbour, not a child', () => {
  const r = analyzeOrder([circle(100, 100, 90), rect(60, 95, 200, 12)]); // bar crossing the circle edge
  const s = byIdx(r);
  assert.ok(s[1].parent === null); assert.equal(s[1].role, 'cut');
});

test('too many shapes is reported, not crashed on', () => {
  const subs = Array.from({ length: 2100 }, (_, i) => rect(i, 0, 0.5, 0.5));
  const r = analyzeOrder(subs);
  assert.ok(r.skipped && r.cut.length === 0);
});

test('number sizing: roomy regions are capped, tiny ones are flagged', () => {
  assert.equal(numberSize(2, 500).fsMm, 14);
  const t = numberSize(2, 0.5);
  assert.ok(t.tiny && t.fsMm === 2.4);
  assert.ok(!numberSize(1, 5).tiny);
});

console.log(failed ? `\n${failed} test(s) failed` : '\nAll order tests passed');
process.exit(failed ? 1 : 0);
