import { test, expect } from 'vitest';
import { type Pose, type Vec2, dist } from '../../src/geom/vec';
import { samplePath } from '../../src/geom/path';
import { Doc } from '../../src/model/doc';
import { type Piece, type Train, emptyLayout } from '../../src/model/types';
import { History } from '../../src/editor/history';
import { Simulation } from '../../src/sim/simulation';
import { attachSpec, outPose, specToPiece } from '../../src/sketch/spec';
import { StrokeFitter } from '../../src/sketch/fitter';
import { type StrokeStart, beginStroke, finishStroke, strokeDoc } from '../../src/sketch/stroke';
import { D, pieceGeometry } from '../../src/track/catalog';
import { connKey, worldRoutePath } from '../../src/track/graph';

const R = 0.5;
const docOf = (pieces: Piece[], trains: Train[] = []) => new Doc({ ...emptyLayout(), pieces, trains });
const piece = (id: string, type: string, at: Pose, level = 0, flipped = false): Piece =>
  specToPiece(attachSpec(type, flipped, undefined, at, level), id);

/** Straights of `type` end to end from outward pose `at`, ids prefix0, prefix1, ... */
function run(prefix: string, type: string, at: Pose, n: number, level = 0): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const p = piece(prefix + i, type, at, level);
    out.push(p);
    at = outPose(p, 1);
  }
  return out;
}

/** Points every `step` along the polyline through `corners` (excluding the first corner). */
function polyline(corners: Vec2[], step = 0.1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i], b = corners[i + 1];
    const n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Begin at corners[0], drag through the rest and release at the last corner. */
function sketch(doc: Doc, corners: Vec2[], level = 0, dir?: Vec2) {
  const start = beginStroke(doc, corners[0], level, R, dir);
  if (start === 'refused') throw new Error('refused');
  const fitter = new StrokeFitter(strokeDoc(doc, start), start);
  for (const p of polyline(corners)) fitter.addPoint(p, false);
  return { start, fitter, cmd: finishStroke(doc, start, fitter, corners[corners.length - 1], R) };
}

const ofType = (doc: Doc, type: string) => doc.layout.pieces.filter((p) => p.type === type);
const openKeys = (doc: Doc) => doc.graph.open.map((c) => connKey(c.pieceId, c.index)).sort();

test('from an empty table: buffers at both ends, no open connectors; one exec, one undo', () => {
  const doc = docOf([]);
  const { start, cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  expect(start.empty).toBe(true);
  expect(cmd).not.toBeNull();
  const h = new History();
  h.exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(ofType(doc, 'buffer')).toHaveLength(2);
  expect(doc.layout.pieces.length).toBeGreaterThan(2);
  expect(doc.graph.open).toEqual([]);
  expect(doc.graph.nearMisses).toEqual([]);
  expect(doc.graph.overlaps).toEqual([]);
  expect(new Set(doc.layout.pieces.map((p) => p.id)).size).toBe(doc.layout.pieces.length);
  // straights merged: about 5U of straight in few pieces
  expect(doc.layout.pieces.filter((p) => p.type !== 'buffer').length).toBeLessThanOrEqual(4);
  expect(h.undo(doc)).toBe(true);
  expect(doc.layout.pieces).toEqual([]);
  expect(h.canUndo).toBe(false);
});

test('from an open end: continues it, no buffer at the start', () => {
  const a = piece('a', 'straight-1', { x: -1, y: 0, rot: 0 });
  const doc = docOf([a]);
  const { start, cmd } = sketch(doc, [{ x: 0.1, y: 0.1 }, { x: 5, y: 0 }]);
  expect(start.empty).toBe(false);
  expect(start.attachedTo).toMatchObject({ pieceId: 'a', index: 1 });
  expect(start.heading).toBeCloseTo(0);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(ofType(doc, 'buffer')).toHaveLength(1);
  expect(openKeys(doc)).toEqual(['a:0']);
  expect(doc.graph.joins.has('a:1')).toBe(true);
});

test('from a buffer stop: the buffer is removed and the new track mates with the old connector', () => {
  const a = piece('a', 'straight-1', { x: -1, y: 0, rot: 0 });
  const b = piece('b', 'buffer', outPose(a, 1));
  const doc = docOf([a, b]);
  expect(doc.graph.joins.has('a:1')).toBe(true);
  // on the buffer's body, away from its connector
  const { start, cmd } = sketch(doc, [{ x: 0.35, y: 0.05 }, { x: 5, y: 0 }]);
  expect(start.removeBuffer).toBe('b');
  expect(start.pos.x).toBeCloseTo(0); expect(start.pos.y).toBeCloseTo(0);
  const h = new History();
  h.exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('b')).toBeUndefined();
  const mate = doc.graph.joins.get('a:1');
  expect(mate).toBeDefined();
  expect(doc.piece(mate!.pieceId)!.type).not.toBe('buffer');
  expect(openKeys(doc)).toEqual(['a:0']);
  h.undo(doc);
  expect(doc.layout.pieces).toEqual([a, b]);
});

test('ending near an open connector 0.3U off-line joins it exactly', () => {
  // z's open connector 0 is at (6, 0.3), facing the stroke
  const z = piece('z', 'straight-1', { x: 6, y: 0.3, rot: 0 });
  const doc = docOf([z]);
  expect(outPose(z, 0)).toMatchObject({ x: 6, rot: 180 }); expect(outPose(z, 0).y).toBeCloseTo(0.3);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 5.85, y: 0.1 }]);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(openKeys(doc)).toEqual(['z:1']);
  expect(doc.graph.joins.has('z:0')).toBe(true);
  expect(doc.graph.nearMisses).toEqual([]);
  expect(ofType(doc, 'buffer')).toHaveLength(1); // the start only
});

test('ending near a buffer stop removes it and joins its track', () => {
  const z = piece('z', 'straight-1', { x: 7, y: 0, rot: 180 }); // z:1 at (6, 0) pointing west
  const b = piece('b', 'buffer', outPose(z, 1));
  const doc = docOf([z, b]);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 5.6, y: 0 }]);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('b')).toBeUndefined();
  expect(doc.graph.joins.has('z:1')).toBe(true);
  expect(openKeys(doc)).toEqual(['z:0']);
});

test('ending on the middle of a straight creates a merging switch, fully joined', () => {
  // vertical run at x = 6 from y = -3 to y = 3
  const track = run('v', 'straight-2', { x: 6, y: -3, rot: 90 }, 3);
  const doc = docOf(track);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 6, y: 0 }]);
  expect(cmd).not.toBeNull();
  const h = new History();
  h.exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  const sw = ofType(doc, 'switch');
  expect(sw).toHaveLength(1);
  expect(sw[0].switch).toEqual({ mode: 'manual', state: 0 });
  for (let i = 0; i < 3; i++) expect(doc.graph.joins.has(connKey(sw[0].id, i))).toBe(true);
  // only the run's two outer ends stay open; the stroke start has a buffer
  expect(doc.graph.open).toHaveLength(2);
  expect(doc.graph.open.every((c) => Math.abs(Math.abs(c.pos.y) - 3) < 1e-6)).toBe(true);
  expect(doc.graph.nearMisses).toEqual([]);
  expect(ofType(doc, 'buffer')).toHaveLength(1);
  h.undo(doc);
  expect(doc.layout.pieces).toEqual(track);
});

const curveMid = (c: Piece): Vec2 => {
  const path = worldRoutePath(c, 0);
  return samplePath(path, path.length / 2).pos;
};

test('starting on a curve with no straight nearby is refused', () => {
  const c = piece('c', 'curve-l-45', { x: 0, y: 0, rot: 0 });
  const doc = docOf([c]);
  const mid = curveMid(c);
  expect(beginStroke(doc, mid, 0, R, { x: 0, y: -1 })).toBe('refused');
  expect(beginStroke(doc, mid, 0, R)).toBe('refused');
});

test('on a straight before the drag direction is known: a provisional start to retry with the direction', () => {
  const doc = docOf(run('s', 'straight-2', { x: 0, y: 0, rot: 0 }, 3));
  const s = beginStroke(doc, { x: 3, y: 0.1 }, 0, R) as StrokeStart;
  expect(s).not.toBe('refused');
  expect(s.heading).toBeNull();
  expect(s.empty).toBe(false);
  expect(s.startSplice).toBeUndefined();
  const t = beginStroke(doc, { x: 3, y: 0.1 }, 0, R, { x: 1, y: -1 }) as StrokeStart;
  expect(t.startSplice).toBeDefined();
  expect(t.heading).toBeCloseTo(-45);
});

test('ending on a curve with no straight nearby ends in a buffer and keeps the stroke', () => {
  // a curve running roughly north-south across the stroke's end
  const c = piece('c', 'curve-l-45', { x: 6.5, y: 1.5, rot: -90 + 22.5 });
  const doc = docOf([c]);
  const mid = curveMid(c);
  const { cmd } = sketch(doc, [{ x: mid.x - 6, y: mid.y }, { x: mid.x - 0.25, y: mid.y }]);
  expect(cmd).not.toBeNull();
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('c')).toEqual(c);
  expect(ofType(doc, 'switch')).toEqual([]);
  expect(ofType(doc, 'buffer')).toHaveLength(2);
  const laid = doc.layout.pieces.filter((p) => p.type !== 'buffer' && p.id !== 'c');
  const total = laid.reduce((t, p) => t + pieceGeometry(p).routes[0].path.length, 0);
  expect(total).toBeGreaterThan(4);
  expect(openKeys(doc)).toEqual(['c:0', 'c:1']);
});

test('a 0.3U stroke returns null', () => {
  const doc = docOf([]);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 0.3, y: 0 }]);
  expect(cmd).toBeNull();
});

test('crossing a straight inserts a crossover in the one command; undo restores the run', () => {
  const track = run('v', 'straight-2', { x: 3, y: -3, rot: 90 }, 3);
  const doc = docOf(track);
  const { fitter, cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 7, y: 0 }]);
  expect(fitter.crossings).toHaveLength(1);
  const h = new History();
  h.exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(ofType(doc, 'crossover-90')).toHaveLength(1);
  expect(ofType(doc, 'buffer')).toHaveLength(2);
  expect(doc.graph.open).toHaveLength(2); // the vertical run's outer ends
  expect(doc.graph.overlaps).toEqual([]);
  h.undo(doc);
  expect(doc.layout.pieces).toEqual(track);
});

test('a stroke starting on a straight a running train occupies lifts the train; undo restores both', () => {
  const track = run('s', 'straight-2', { x: 0, y: 0, rot: 0 }, 3);
  const head = { pieceId: 's1', route: 0, dist: 1.5, dir: 1 as const };
  const train: Train = {
    id: 't1', cars: 0, color: '#c00', speed: 1, running: true, head: { ...head }, lifted: null,
    currentSpeed: 0.5, crashed: false, crashAt: null,
  };
  const doc = docOf(track, [train]);
  const sim = new Simulation(doc);
  sim.step(0.05);
  const before = structuredClone(doc.layout.trains[0].head);
  const pt = { x: 3, y: 0 };
  const dir = { x: 1, y: -1 };
  const start = beginStroke(doc, pt, 0, R, dir) as StrokeStart;
  expect(start.startSplice?.remove).toContain('s1');
  const fitter = new StrokeFitter(strokeDoc(doc, start), start);
  const from = start.pos;
  for (const p of polyline([from, { x: from.x + 3, y: from.y - 3 }])) fitter.addPoint(p, false);
  const cmd = finishStroke(doc, start, fitter, { x: from.x + 3, y: from.y - 3 }, R);
  expect(cmd).not.toBeNull();
  const h = new History();
  h.exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  const t = doc.train('t1')!;
  expect(t.head).toBeNull();
  expect(t.lifted).not.toBeNull();
  expect(t.running).toBe(false);
  expect(ofType(doc, 'switch')).toHaveLength(1);
  expect(() => sim.step(0.1)).not.toThrow();
  h.undo(doc);
  expect(doc.layout.pieces).toEqual(track);
  expect(doc.train('t1')!.head).toEqual(before);
  expect(doc.train('t1')!.lifted).toBeNull();
  expect(() => sim.step(0.1)).not.toThrow();
});

test('a raised straight over level-0 track becomes a bridge piece; elsewhere plain', () => {
  const track = run('v', 'straight-2', { x: 3, y: -2, rot: 90 }, 2);
  const doc = docOf(track);
  const { cmd } = sketch(doc, [{ x: -2, y: 0 }, { x: 8, y: 0 }], 1);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  const raised = doc.layout.pieces.filter((p) => p.level === 1);
  const bridges = raised.filter((p) => p.type.startsWith('bridge-'));
  expect(bridges.length).toBeGreaterThanOrEqual(1);
  for (const b of bridges) {
    const [a, c] = [outPose(b, 0), outPose(b, 1)];
    expect(Math.min(a.x, c.x)).toBeLessThan(3.3);
    expect(Math.max(a.x, c.x)).toBeGreaterThan(2.7);
  }
  expect(raised.some((p) => p.type.startsWith('straight-'))).toBe(true);
  expect(doc.graph.open.filter((c) => c.level === 1)).toEqual([]);
  expect(doc.piece('v0')).toEqual(track[0]);
});

test('release trims the last ghost piece when the stroke never got halfway past it', () => {
  const doc = docOf([]);
  const s0 = attachSpec('straight-1', false, undefined, { x: 0, y: 0, rot: 0 }, 0);
  const s1 = attachSpec('straight-1', false, undefined, outPose(s0, 1), 0);
  const fake = (endX: number) => ({
    points: polyline([{ x: 0, y: 0 }, { x: endX, y: 0 }]), pieces: [s0, s1],
    anchors: [{ x: 0, y: 0, rot: 0 }, outPose(s0, 1)], lead: { pose: outPose(s1, 1), level: 0 },
    crossings: [], redFrom: null, frozen: 0, length: endX, pendingRamp: 0,
  }) as unknown as StrokeFitter;
  const start = beginStroke(doc, { x: 0, y: 0 }, 0, R) as StrokeStart;
  const laidLength = (endX: number) => {
    const d = docOf([]);
    finishStroke(d, start, fake(endX), { x: endX, y: 0 }, R)!.do(d);
    expect(d.graph.overlaps).toEqual([]);
    expect(ofType(d, 'buffer')).toHaveLength(2);
    expect(d.graph.open).toEqual([]);
    return d.layout.pieces.filter((p) => p.type !== 'buffer').reduce((t, p) => t + pieceGeometry(p).routes[0].path.length, 0);
  };
  expect(laidLength(1.4)).toBeCloseTo(1); // never past 1.5: the second straight is dropped
  expect(laidLength(1.6)).toBeCloseTo(2);
});

test('a stroke carried past a curve ends short of it without overlapping it', () => {
  const c = piece('c', 'curve-l-45', { x: 6.5, y: 1.5, rot: -90 + 22.5 });
  const doc = docOf([c]);
  const mid = curveMid(c);
  const { fitter, cmd } = sketch(doc, [{ x: mid.x - 6, y: mid.y }, { x: mid.x + 1, y: mid.y }]);
  expect(fitter.redFrom).not.toBeNull();
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('c')).toEqual(c);
  const laid = doc.layout.pieces.filter((p) => p.type !== 'buffer' && p.id !== 'c');
  expect(laid.reduce((t, p) => t + pieceGeometry(p).routes[0].path.length, 0)).toBeGreaterThan(3);
});

test('a stroke stopped red by a curve across it commits no overlap', () => {
  const c = specToPiece({ type: 'curve-l-45', x: 3, y: -1, rot: 70, level: 0, flipped: false }, 'c');
  const doc = docOf([c]);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 7, y: 0 }]);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('c')).toEqual(c);
});

test('a stroke ending at the back of a lone buffer commits no overlap', () => {
  // lone buffer: body from x = 5.5 to 6, its connector at x = 6 facing east (away from the stroke)
  const b = piece('b', 'buffer', { x: 6, y: 0, rot: 180 });
  const doc = docOf([b]);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 5.6, y: 0 }]);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.piece('b')).toEqual(b);
});

test('an empty-start buffer that would overlap track is left out (open start)', () => {
  // a vertical run just behind the start, beyond the snap radius
  const track = run('v', 'straight-2', { x: -0.6, y: -2, rot: 90 }, 2);
  const doc = docOf(track);
  const { start, cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  expect(start.empty).toBe(true);
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
  expect(doc.graph.open.some((c) => dist(c.pos, { x: 0, y: 0 }) < 1e-6)).toBe(true);
  expect(ofType(doc, 'buffer')).toHaveLength(1);
});

test('a diverging start looping back toward its own run commits no overlap', () => {
  const track = run('s', 'straight-2', { x: 0, y: 0, rot: 0 }, 4);
  const doc = docOf(track);
  const start = beginStroke(doc, { x: 3, y: 0 }, 0, R, { x: 1, y: -1 }) as StrokeStart;
  const fitter = new StrokeFitter(strokeDoc(doc, start), start);
  const end = { x: 6.2, y: 0.05 };
  for (const p of polyline([start.pos, { x: 5, y: -2 }, { x: 6.5, y: -1.5 }, end])) fitter.addPoint(p, false);
  const cmd = finishStroke(doc, start, fitter, end, R);
  expect(cmd).not.toBeNull();
  new History().exec(cmd!, doc);
  expect(doc.graph.overlaps).toEqual([]);
});

test('a stroke across a double track commits no overlap (the crossover would reach the second track)', () => {
  const near = run('a', 'straight-2', { x: -1, y: 0, rot: 0 }, 4);
  const far = run('b', 'straight-2', { x: -1, y: D, rot: 0 }, 4);
  const doc = docOf([...near, ...far]);
  const { cmd } = sketch(doc, [{ x: 3.1, y: -4 }, { x: 3.1, y: 5 }]);
  if (cmd) new History().exec(cmd, doc);
  expect(doc.graph.overlaps).toEqual([]);
});

test('a stroke crossing a straight 0.8U from its open end commits no overlap', () => {
  const track = run('v', 'straight-2', { x: 3, y: -3.2, rot: 90 }, 2); // open ends at y = -3.2 and 0.8
  const doc = docOf(track);
  const { cmd } = sketch(doc, [{ x: 0, y: 0 }, { x: 7, y: 0 }]);
  if (cmd) new History().exec(cmd, doc);
  expect(doc.graph.overlaps).toEqual([]);
});
