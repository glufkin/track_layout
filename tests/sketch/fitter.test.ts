import { test, expect } from 'vitest';
import { type Pose, type Vec2, angleDiff, dist } from '../../src/geom/vec';
import { Doc } from '../../src/model/doc';
import { type Piece, MAX_LEVEL, emptyLayout } from '../../src/model/types';
import { attachSpec, outPose, specToPiece } from '../../src/sketch/spec';
import { FREEHAND_SET, SHIFT_SET, STEP_DIST, StrokeFitter, crossId } from '../../src/sketch/fitter';

const empty = () => new Doc(emptyLayout());
const docOf = (pieces: Piece[]) => new Doc({ ...emptyLayout(), pieces });
const piece = (id: string, type: string, at: Pose, level = 0, flipped = false): Piece =>
  specToPiece(attachSpec(type, flipped, undefined, at, level), id);

/** Points every `step` along the polyline through `corners`. */
function polyline(corners: Vec2[], step = 0.1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i], b = corners[i + 1];
    const n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

function drag(f: StrokeFitter, pts: Vec2[], shift = false): number {
  let n = 0;
  for (const p of pts) n += f.addPoint(p, shift);
  return n;
}

const inSet = (set: ReadonlyArray<{ type: string; flipped: boolean }>, s: { type: string; flipped: boolean }) =>
  set.some((c) => c.type === s.type && c.flipped === s.flipped);
const on45 = (deg: number) => Math.abs(deg / 45 - Math.round(deg / 45)) < 1e-6;

test('straight drag east lays about 5U of straights along heading 0, lead near the pointer', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: null, level: 0 });
  const clicks = drag(f, polyline([{ x: 0, y: 0 }, { x: 5, y: 0 }]));
  expect(clicks).toBe(f.pieces.length);
  expect(f.pieces.every((s) => s.type.startsWith('straight-'))).toBe(true);
  const total = f.pieces.reduce((t, s) => t + dist(outPose(s, 0), outPose(s, 1)), 0);
  expect(total).toBeGreaterThan(4.2); expect(total).toBeLessThanOrEqual(5.25);
  expect(angleDiff(f.lead.pose.rot, 0)).toBeLessThan(1e-9);
  expect(Math.abs(f.lead.pose.y)).toBeLessThan(1e-9);
  expect(dist(f.lead.pose, { x: 5, y: 0 })).toBeLessThanOrEqual(STEP_DIST);
  expect(f.length).toBeCloseTo(5);
});

test('quarter circle of radius 2.2 ends near heading 90 using freehand pieces, staying on the line', () => {
  const R = 2.2;
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: null, level: 0 });
  // Centre (0, R): starts heading east, turns right (y down) to heading 90.
  const pts: Vec2[] = [];
  const n = Math.round((R * Math.PI) / 2 / 0.1);
  for (let k = 1; k <= n; k++) {
    const a = (k / n) * (Math.PI / 2);
    pts.push({ x: R * Math.sin(a), y: R - R * Math.cos(a) });
  }
  drag(f, pts);
  expect(angleDiff(f.lead.pose.rot, 90)).toBeLessThanOrEqual(22.5 + 1e-9);
  for (const s of f.pieces) expect(inSet(FREEHAND_SET, s)).toBe(true);
  // Smooth: never far off the arc, and no left turns on a right-turning stroke.
  for (const s of f.pieces) {
    const e = outPose(s, 1);
    expect(Math.abs(dist(e, { x: 0, y: R }) - R)).toBeLessThan(0.2);
    expect(s.flipped).toBe(false);
  }
});

test('Shift drag east then north uses only the Shift set on 45° headings', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: null, level: 0 });
  const heads: number[] = [];
  for (const p of polyline([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: -4 }])) {
    f.addPoint(p, true);
    heads.push(f.lead.pose.rot);
  }
  expect(f.pieces.length).toBeGreaterThan(4);
  for (const s of f.pieces) { expect(inSet(SHIFT_SET, s)).toBe(true); expect(on45(outPose(s, 1).rot)).toBe(true); }
  for (const h of heads) expect(on45(h)).toBe(true);
  expect(angleDiff(f.lead.pose.rot, -90)).toBeLessThan(1e-9);
});

test('Shift from a 22.5° heading: one curve-l-22 first, then 45° multiples', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 22.5, level: 0 });
  const u = { x: Math.cos(Math.PI / 8), y: Math.sin(Math.PI / 8) };
  drag(f, polyline([{ x: 0, y: 0 }, { x: 5 * u.x, y: 5 * u.y }]), true);
  expect(f.pieces.length).toBeGreaterThan(2);
  expect(f.pieces[0].type).toBe('curve-l-22');
  for (const s of f.pieces.slice(1)) { expect(s.type).not.toBe('curve-l-22'); expect(inSet(SHIFT_SET, s)).toBe(true); }
  for (const s of f.pieces) expect(on45(outPose(s, 1).rot)).toBe(true);
});

test('a fast pointer: one far point appends many pieces that chain without gaps', () => {
  const start = { x: 0, y: 0 };
  const f = new StrokeFitter(empty(), { pos: start, heading: null, level: 0 });
  const n = f.addPoint({ x: 10, y: 0 }, false);
  expect(n).toBeGreaterThanOrEqual(8);
  expect(f.pieces.length).toBe(n);
  let at: Pose = { ...start, rot: 0 };
  for (const s of f.pieces) {
    const c0 = outPose(s, 0);
    expect(dist(c0, at)).toBeLessThan(1e-9); expect(angleDiff(c0.rot, at.rot + 180)).toBeLessThan(1e-9);
    at = outPose(s, 1);
  }
  expect(dist(at, f.lead.pose)).toBeLessThan(1e-9);
});

test('same input points give the same pieces', () => {
  const pts = polyline([{ x: 0, y: 0 }, { x: 3, y: 0.4 }, { x: 5, y: 2 }, { x: 5.5, y: 4 }]);
  const a = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: null, level: 0 });
  const b = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: null, level: 0 });
  drag(a, pts); drag(b, pts);
  expect(a.pieces).toEqual(b.pieces);
});

test('a pending ramp up is laid on a 4U straight drag and raises the lead level', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  expect(f.requestRamp(1)).toBe(true);
  expect(f.pendingRamp).toBe(1);
  drag(f, polyline([{ x: 0, y: 0 }, { x: 4, y: 0 }]));
  const ramps = f.pieces.filter((s) => s.type === 'ramp-2');
  expect(ramps).toHaveLength(1);
  expect(ramps[0].level).toBe(0);
  expect(f.lead.level).toBe(1);
  expect(f.pendingRamp).toBe(0);
  const after = f.pieces.slice(f.pieces.indexOf(ramps[0]) + 1);
  expect(after.length).toBeGreaterThan(0);
  for (const s of after) expect(s.level).toBe(1);
});

test('a pending ramp down is entered at its high end and lowers the lead level', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 0, level: 2 });
  expect(f.requestRamp(-1)).toBe(true);
  drag(f, polyline([{ x: 0, y: 0 }, { x: 4, y: 0 }]));
  const i = f.pieces.findIndex((s) => s.type === 'ramp-2');
  expect(i).toBeGreaterThanOrEqual(0);
  const ramp = f.pieces[i];
  expect(ramp.level).toBe(1);
  const before = i === 0 ? { x: 0, y: 0, rot: 0 } : outPose(f.pieces[i - 1], 1);
  expect(dist(outPose(ramp, 1), before)).toBeLessThan(1e-9);
  expect(f.lead.level).toBe(1);
});

test('requestRamp out of 0..MAX_LEVEL returns false and changes nothing', () => {
  const top = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 0, level: MAX_LEVEL });
  expect(top.requestRamp(1)).toBe(false);
  expect(top.pendingRamp).toBe(0); expect(top.lead.level).toBe(MAX_LEVEL);
  const ground = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  expect(ground.requestRamp(-1)).toBe(false);
  expect(ground.pendingRamp).toBe(0); expect(ground.lead.level).toBe(0);
});

/** A straight-2 running north-south across y = 0 at x = 2. */
const crossDoc = () => docOf([piece('s', 'straight-2', { x: 2, y: -1, rot: 90 })]);

test('crossing an existing same-level straight records one crossover splice and continues past it', () => {
  const f = new StrokeFitter(crossDoc(), { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  drag(f, polyline([{ x: 0, y: 0 }, { x: 5, y: 0 }]));
  expect(f.redFrom).toBeNull();
  expect(f.crossings).toHaveLength(1);
  const c = f.crossings[0];
  expect(c.ghost).toBe(false);
  expect(c.splice.remove).toEqual(['s']);
  const x = c.splice.add.filter((s) => s.type === 'crossover-90');
  expect(x).toHaveLength(1);
  // The ghost before the crossing ends at the entry; the piece at `index` starts at the exit.
  const entryMate = outPose(f.pieces[c.index - 1], 1);
  const conns = [0, 1, 2, 3].map((i) => outPose(x[0], i));
  expect(conns.some((p) => dist(p, entryMate) < 1e-6 && angleDiff(p.rot, entryMate.rot + 180) < 1e-6)).toBe(true);
  const exitMate = outPose(f.pieces[c.index], 0);
  expect(conns.some((p) => dist(p, exitMate) < 1e-6 && angleDiff(p.rot, exitMate.rot + 180) < 1e-6)).toBe(true);
  expect(f.lead.pose.x).toBeGreaterThan(4);
  // Applied to the doc, the crossing and the ghost join up: no overlaps; open ends only at the
  // stroke's two ends and the old straight's two ends.
  const after = docOf([...c.splice.add.map((s, i) => specToPiece(s, 'x' + i)), ...f.pieces.map((s, i) => specToPiece(s, 'g' + i))]);
  expect(after.graph.overlaps).toEqual([]);
  expect(after.graph.open).toHaveLength(4);
});

test('track on another level is not crossed (a bridge)', () => {
  const f = new StrokeFitter(crossDoc(), { pos: { x: 0, y: 0 }, heading: 0, level: 1 });
  drag(f, polyline([{ x: 0, y: 0 }, { x: 5, y: 0 }]));
  expect(f.crossings).toHaveLength(0);
  expect(f.redFrom).toBeNull();
  expect(f.lead.pose.x).toBeGreaterThan(4);
});

test('crossing an existing curve turns the stroke red and stops appending', () => {
  // A large curve from (2, -1.5) heading south, bending west across y = 0 near x = 1.42.
  const doc = docOf([piece('c', 'curve-l-45', { x: 2, y: -1.5, rot: 90 })]);
  const f = new StrokeFitter(doc, { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  drag(f, polyline([{ x: 0, y: 0 }, { x: 3, y: 0 }]));
  expect(f.redFrom).not.toBeNull();
  const n = f.pieces.length;
  expect(drag(f, polyline([{ x: 3, y: 0 }, { x: 6, y: 0 }]))).toBe(0);
  expect(f.pieces.length).toBe(n);
  expect(f.crossings).toHaveLength(0);
  expect(f.points.length).toBeGreaterThan(f.redFrom!);
  for (const s of f.pieces) expect(outPose(s, 1).x).toBeLessThan(1.6);
});

test('a loop that crosses its own earlier ghost records a ghost crossing', () => {
  const f = new StrokeFitter(empty(), { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  // East along y = 0, round anticlockwise (up the screen) and back down across the first straight at x ≈ 2.
  const pts: Vec2[] = polyline([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  const cx = 4, cy = -1.5, r = 1.5;
  for (let a = 5; a <= 180; a += 5) {
    const t = (a * Math.PI) / 180; // centre (4, -1.5): from (4, 0) up the right side to (4, -3)
    pts.push({ x: cx + r * Math.sin(t), y: cy + r * Math.cos(t) });
  }
  pts.push(...polyline([{ x: 4, y: -3 }, { x: 3, y: -3 }]));
  for (let a = 5; a <= 90; a += 5) {
    const t = (a * Math.PI) / 180; // centre (3, -1.5): from (3, -3) round to (1.5, -1.5)
    pts.push({ x: 3 - r * Math.sin(t), y: -1.5 - r * Math.cos(t) });
  }
  pts.push(...polyline([{ x: 1.5, y: -1.5 }, { x: 1.5, y: 2 }]));
  drag(f, pts);
  expect(f.redFrom).toBeNull();
  const ghost = f.crossings.filter((c) => c.ghost);
  expect(ghost).toHaveLength(1);
  expect(f.pieces[ghost[0].index].type).toMatch(/^crossover-/);
  expect(f.lead.pose.y).toBeGreaterThan(0.5);
  // The ghost, crossover included, is one clean track: no overlaps, open only at its two ends.
  const after = docOf(f.pieces.map((s, i) => specToPiece(s, 'g' + i)));
  expect(after.graph.overlaps).toEqual([]);
  expect(after.graph.open).toHaveLength(2);
});

test('crossing the same run twice: the second splice may name pieces the first one added (crossId)', () => {
  // One run of four straight-2 along y = 0, x = -2 .. 6.
  const run: Piece[] = [];
  for (let i = 0; i < 4; i++) run.push(piece('r' + i, 'straight-2', { x: -2 + 2 * i, y: 0, rot: 0 }));
  const f = new StrokeFitter(docOf(run), { pos: { x: 0.5, y: -2 }, heading: 90, level: 0 });
  // Down across the run at x = 0.5, round underneath, and back up across it at x = 2.5,
  // close enough that the second crossover cuts into the refill the first one added.
  const pts = polyline([{ x: 0.5, y: -2 }, { x: 0.5, y: 1.5 }]);
  for (let a = 5; a <= 180; a += 5) {
    const t = (a * Math.PI) / 180;
    pts.push({ x: 1.5 - Math.cos(t), y: 1.5 + Math.sin(t) });
  }
  pts.push(...polyline([{ x: 2.5, y: 1.5 }, { x: 2.5, y: -2.5 }]));
  drag(f, pts);
  expect(f.redFrom).toBeNull();
  expect(f.crossings).toHaveLength(2);
  expect(f.crossings.every((c) => !c.ghost)).toBe(true);
  expect(f.crossings[1].splice.remove.some((id) => id.startsWith('cross:0:'))).toBe(true);
  // Apply the splices in order, mapping crossId ids to the ids given to earlier added pieces.
  let pieces = run.map((p) => ({ ...p }));
  const given = new Map<string, string>();
  f.crossings.forEach((c, ci) => {
    const remove = new Set(c.splice.remove.map((id) => given.get(id) ?? id));
    for (const id of c.splice.remove) expect(id.startsWith('cross:') ? given.has(id) : run.some((p) => p.id === id)).toBe(true);
    pieces = pieces.filter((p) => !remove.has(p.id));
    c.splice.add.forEach((s, i) => { const id = 'c' + ci + '_' + i; given.set(crossId(ci, i), id); pieces.push(specToPiece(s, id)); });
  });
  pieces.push(...f.pieces.map((s, i) => specToPiece(s, 'g' + i)));
  const after = docOf(pieces);
  expect(after.graph.overlaps).toEqual([]);
  expect(after.graph.open).toHaveLength(4);
});

test('continuing from an open connector does not count the track it starts from as crossed', () => {
  const doc = docOf([piece('a', 'straight-1-4', { x: -0.25, y: 0, rot: 0 }), piece('b', 'straight-1', { x: -1.25, y: 0, rot: 0 })]);
  const f = new StrokeFitter(doc, { pos: { x: 0, y: 0 }, heading: 0, level: 0 });
  drag(f, polyline([{ x: 0, y: 0 }, { x: 3, y: 0.6 }]));
  expect(f.redFrom).toBeNull();
  expect(f.crossings).toHaveLength(0);
  expect(f.pieces.length).toBeGreaterThan(1);
});
