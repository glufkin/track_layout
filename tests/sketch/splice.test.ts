import { test, expect } from 'vitest';
import { type Pose, type Vec2, angleDiff, normDeg } from '../../src/geom/vec';
import { Doc } from '../../src/model/doc';
import { type Piece, emptyLayout } from '../../src/model/types';
import { pieceGeometry, validFlex } from '../../src/track/catalog';
import { connKey } from '../../src/track/graph';
import { type PieceSpec, attachSpec, outPose, specToPiece, chainEnd } from '../../src/sketch/spec';
import { type Splice, crossingSplice, isPlainStraight, mergeStraights, switchSplice } from '../../src/sketch/splice';

/** Lay pieces end to end from `start`, each entered at connector 0; ids as given. */
function chain(start: Pose, parts: Array<[string, string, Partial<PieceSpec>?]>): Piece[] {
  const out: Piece[] = [];
  let at = start;
  for (const [id, type, extra] of parts) {
    const spec = { ...attachSpec(type, extra?.flipped ?? false, extra?.flex, at, extra?.level ?? 0), ...extra };
    const p = specToPiece(spec, id);
    out.push(p);
    at = outPose(p, 1);
  }
  return out;
}

/** a1 (straight-1) | b (straight-2) | c (straight-1), heading +x from the origin. */
const basic = () => new Doc({ ...emptyLayout(), pieces: chain({ x: 0, y: 0, rot: 0 }, [['a1', 'straight-1'], ['b', 'straight-2'], ['c', 'straight-1']]) });

/** Apply a splice to a copy of the doc: remove, add with fresh ids n1.., rebuild. */
function apply(doc: Doc, s: Splice): { doc: Doc; ids: string[] } {
  for (const spec of s.add) if (spec.type.startsWith('flex-')) expect(validFlex(spec.type, spec.flex)).toBe(true);
  const ids = s.add.map((_, i) => 'n' + (i + 1));
  const pieces = doc.layout.pieces.filter((p) => !s.remove.includes(p.id)).map((p) => ({ ...p }));
  pieces.push(...s.add.map((spec, i) => specToPiece(spec, ids[i])));
  return { doc: new Doc({ ...emptyLayout(), pieces }), ids };
}

const openKeys = (doc: Doc) => doc.graph.open.map((c) => connKey(c.pieceId, c.index)).sort();
const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
const findType = (doc: Doc, ids: string[], type: string) => doc.layout.pieces.filter((p) => ids.includes(p.id) && p.type === type);

test('isPlainStraight: catalogue and flex straights only', () => {
  for (const t of ['straight-1-4', 'straight-1-2', 'straight-1', 'straight-2', 'straight-d1', 'flex-straight']) expect(isPlainStraight(t)).toBe(true);
  for (const t of ['curve-m-45', 'flex-curve', 'switch', 'crossover-90', 'ramp-2', 'bridge-1', 'bridge-2', 'tunnel-1', 'buffer']) expect(isPlainStraight(t)).toBe(false);
});

test('diverging switch on a straight-2 at 0.7 along: neighbours stay joined, branch 45° toward the stroke', () => {
  const doc = basic();
  // b runs x = 1..3; 0.7 along is x = 1.7; stroke heads up and right (y down)
  const r = switchSplice(doc, { x: 1.7, y: 0.05 }, 0, { x: 1, y: -1 }, 'diverge', 0.5)!;
  expect(r).not.toBeNull();
  expect(r.splice.remove).toEqual(['b']);
  const sw = r.splice.add.filter((s) => s.type === 'switch');
  expect(sw).toHaveLength(1);
  expect(sw[0].switch).toEqual({ mode: 'manual', state: 0 });
  for (const s of r.splice.add) expect(isPlainStraight(s.type) || s.type === 'switch').toBe(true);
  // centred on x = 1.7: entry at 1.2 facing back, exit at 2.2
  expect(near(outPose(sw[0], 0), { x: 1.2, y: 0 })).toBe(true);
  expect(outPose(sw[0], 0).rot).toBeCloseTo(180);
  const { doc: after, ids } = apply(doc, r.splice);
  const swId = findType(after, ids, 'switch')[0].id;
  expect(openKeys(after)).toEqual(['a1:0', 'c:1', connKey(swId, 2)].sort());
  expect(after.graph.overlaps).toEqual([]);
  expect(r.branch.rot).toBeCloseTo(-45);
  const b = outPose(sw[0], 2);
  expect(near(r.branch, b)).toBe(true);
  expect(b.y).toBeLessThan(0);
});

test('a stroke heading left diverges the other way, branch on the stroke side', () => {
  const doc = basic();
  const r = switchSplice(doc, { x: 2, y: -0.1 }, 0, { x: -1, y: 1 }, 'diverge', 0.5)!;
  expect(r.branch.rot).toBeCloseTo(135);
  expect(r.branch.y).toBeGreaterThan(0);
  const { doc: after, ids } = apply(doc, r.splice);
  const swId = findType(after, ids, 'switch')[0].id;
  expect(openKeys(after)).toEqual(['a1:0', 'c:1', connKey(swId, 2)].sort());
});

test('merging switch: the branch faces the incoming stroke', () => {
  const doc = basic();
  // stroke arrives heading down and right, from above the track
  const r = switchSplice(doc, { x: 2, y: 0 }, 0, { x: 1, y: 1 }, 'merge', 0.5)!;
  expect(r).not.toBeNull();
  expect(angleDiff(r.branch.rot, 45 + 180)).toBeLessThan(1e-6);
  expect(r.branch.y).toBeLessThan(0);
  expect(r.branch.x).toBeLessThan(2);
  const { doc: after, ids } = apply(doc, r.splice);
  const swId = findType(after, ids, 'switch')[0].id;
  expect(openKeys(after)).toEqual(['a1:0', 'c:1', connKey(swId, 2)].sort());
});

test('switch across a joint removes both pieces and refills with straights plus flex', () => {
  const doc = new Doc({ ...emptyLayout(), pieces: chain({ x: 0, y: 0, rot: 0 }, [['p1', 'straight-1'], ['p2', 'straight-1'], ['p3', 'straight-1'], ['p4', 'straight-1']]) });
  const r = switchSplice(doc, { x: 2.1, y: 0 }, 0, { x: 1, y: 1 }, 'diverge', 0.5)!;
  expect(r.splice.remove.sort()).toEqual(['p2', 'p3']);
  const flex = r.splice.add.filter((s) => s.type === 'flex-straight');
  for (const f of flex) expect((f.flex as { length: number }).length).toBeGreaterThanOrEqual(0.05);
  const { doc: after, ids } = apply(doc, r.splice);
  const swId = findType(after, ids, 'switch')[0].id;
  expect(openKeys(after)).toEqual(['p1:0', 'p4:1', connKey(swId, 2)].sort());
});

test('the switch shifts along the run to fit, and a diagonal run works too', () => {
  // lone straight-2 between curves: a point near its start pushes the switch flush to it
  const doc = new Doc({ ...emptyLayout(), pieces: chain({ x: 0, y: 0, rot: 30 }, [['k1', 'curve-m-45'], ['s', 'straight-2'], ['k2', 'curve-m-45']]) });
  const s = doc.piece('s')!;
  const start = outPose(s, 0);
  const r = switchSplice(doc, { x: start.x, y: start.y }, 0, { x: 0, y: -1 }, 'diverge', 0.5)!;
  expect(r.splice.remove).toEqual(['s']);
  const { doc: after, ids } = apply(doc, r.splice);
  const swId = findType(after, ids, 'switch')[0].id;
  expect(openKeys(after)).toEqual(['k1:0', 'k2:1', connKey(swId, 2)].sort());
  expect(r.splice.add.map((a) => a.type).sort()).toEqual(['straight-1', 'switch']);
});

test('switchSplice refuses non-plain track and too-short runs', () => {
  const doc = new Doc({
    ...emptyLayout(),
    pieces: [
      ...chain({ x: 0, y: 0, rot: 0 }, [['k', 'curve-m-45']]),
      ...chain({ x: 0, y: 5, rot: 0 }, [['br', 'bridge-2', { level: 1 }]]),
      ...chain({ x: 0, y: 10, rot: 0 }, [['tu', 'tunnel-2']]),
      ...chain({ x: 0, y: 15, rot: 0 }, [['sh', 'straight-1-2']]),
      ...chain({ x: 10, y: 0, rot: 0 }, [['far', 'straight-2']]),
    ],
  });
  const k = outPose(doc.piece('k')!, 1);
  expect(switchSplice(doc, { x: k.x, y: k.y }, 0, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
  expect(switchSplice(doc, { x: 1, y: 5 }, 1, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
  expect(switchSplice(doc, { x: 1, y: 10 }, 0, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
  expect(switchSplice(doc, { x: 0.25, y: 15 }, 0, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
  // the straight at x = 10..12 is beyond the snap radius
  expect(switchSplice(doc, { x: 9, y: 0 }, 0, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
  // and wrong level
  expect(switchSplice(doc, { x: 11, y: 0 }, 1, { x: 1, y: 1 }, 'diverge', 0.5)).toBeNull();
});

test('a point on a curve snaps to the nearest straight within the radius', () => {
  const doc = new Doc({ ...emptyLayout(), pieces: chain({ x: 0, y: 0, rot: 0 }, [['s', 'straight-2'], ['k', 'curve-m-45']]) });
  const r = switchSplice(doc, { x: 2.2, y: 0.05 }, 0, { x: 1, y: -1 }, 'diverge', 0.5)!;
  expect(r).not.toBeNull();
  expect(r.splice.remove).toEqual(['s']);
});

/** Which side of the x-axis a point is on. */
const side = (p: Vec2) => Math.sign(p.y);

function crossingCase(heading: number, type: 'crossover-90' | 'crossover-45') {
  const doc = basic();
  const r = crossingSplice(doc, 'b', { x: 2, y: 0 }, heading)!;
  expect(r).not.toBeNull();
  expect(r.type).toBe(type);
  expect(r.splice.remove).toEqual(['b']);
  // entry faces back along the stroke, exit along it, on opposite sides of the track
  expect(angleDiff(r.entry.rot, heading + 180)).toBeLessThanOrEqual(45);
  expect(angleDiff(r.exit.rot, heading)).toBeLessThanOrEqual(45);
  expect(side(r.entry) * side(r.exit)).toBe(-1);
  const { doc: after, ids } = apply(doc, r.splice);
  const x = findType(after, ids, type)[0];
  // centred on x = 2 along the old track
  const conns = pieceGeometry(x).connectors.map((_, i) => outPose(x, i));
  const mid = conns.reduce((m, c) => ({ x: m.x + c.x / 4, y: m.y + c.y / 4 }), { x: 0, y: 0 });
  expect(near(mid, { x: 2, y: 0 })).toBe(true);
  // the old track is continuous: only the outer ends and the crossing route are open
  const entryIdx = conns.findIndex((c) => near(c, r.entry));
  const exitIdx = conns.findIndex((c) => near(c, r.exit));
  expect(openKeys(after)).toEqual(['a1:0', 'c:1', connKey(x.id, entryIdx), connKey(x.id, exitIdx)].sort());
}

test('a stroke crossing at 80° gets a crossover-90', () => crossingCase(80, 'crossover-90'));
test('a stroke crossing at 40° gets a crossover-45', () => crossingCase(40, 'crossover-45'));
test('a stroke crossing at -40° (140° mod 180) gets a crossover-45 too', () => crossingCase(-40, 'crossover-45'));
test('a stroke crossing at 200° gets a crossover-45 aligned with it', () => crossingCase(200, 'crossover-45'));
test('a stroke crossing at -95° gets a crossover-90', () => crossingCase(-95, 'crossover-90'));

test('crossingSplice refuses curves, bridges and tunnels', () => {
  const doc = new Doc({
    ...emptyLayout(),
    pieces: [
      ...chain({ x: 0, y: 0, rot: 0 }, [['k', 'curve-m-45']]),
      ...chain({ x: 0, y: 5, rot: 0 }, [['br', 'bridge-2', { level: 1 }]]),
      ...chain({ x: 0, y: 10, rot: 0 }, [['tu', 'tunnel-2']]),
    ],
  });
  expect(crossingSplice(doc, 'k', { x: 0.5, y: 0.1 }, 90)).toBeNull();
  expect(crossingSplice(doc, 'br', { x: 1, y: 5 }, 90)).toBeNull();
  expect(crossingSplice(doc, 'tu', { x: 1, y: 10 }, 90)).toBeNull();
});

const lengthOf = (s: PieceSpec) => (s.flex && 'length' in s.flex ? s.flex.length : pieceGeometry(s).connectors[1].pos.x);

test('mergeStraights: [s1, s1, s½, flex 0.3] becomes [straight-2, straight-1-2, flex 0.3]', () => {
  const pieces = chain({ x: 1, y: 2, rot: 22.5 }, [['1', 'straight-1'], ['2', 'straight-1'], ['3', 'straight-1-2'], ['4', 'flex-straight', { flex: { length: 0.3 } }]]);
  const specs: PieceSpec[] = pieces.map(({ id: _id, ...s }) => s);
  const merged = mergeStraights(specs);
  expect(merged.map((s) => s.type)).toEqual(['straight-2', 'straight-1-2', 'flex-straight']);
  expect(lengthOf(merged[2])).toBeCloseTo(0.3);
  const a = outPose(merged[0], 0), b = chainEnd(merged);
  expect(near(a, outPose(specs[0], 0))).toBe(true);
  expect(near(b, chainEnd(specs))).toBe(true);
  expect(b.rot).toBeCloseTo(chainEnd(specs).rot);
});

test('mergeStraights: a curve breaks a run; a remainder under 0.05 folds into flex', () => {
  const pieces = chain({ x: 0, y: 0, rot: 0 }, [
    ['1', 'straight-1'], ['2', 'straight-1-2'], ['k', 'curve-m-45'],
    ['3', 'straight-d1-2'], ['4', 'straight-d1-2'], ['5', 'straight-d1-2'], ['6', 'straight-d1-2'], ['7', 'straight-d1-2'],
  ]);
  const specs: PieceSpec[] = pieces.map(({ id: _id, ...s }) => s);
  const merged = mergeStraights(specs);
  // 1.5 stays [s1, s½]; the curve is kept; 5 × √2/2 = 3.5355 = 2 + 1 + ½ + 0.0355, the 0.0355 folds into the ½
  expect(merged.map((s) => s.type)).toEqual(['straight-1', 'straight-1-2', 'curve-m-45', 'straight-2', 'straight-1', 'flex-straight']);
  expect(lengthOf(merged[5])).toBeCloseTo(2.5 * Math.SQRT2 - 3);
  expect(near(chainEnd(merged), chainEnd(specs))).toBe(true);
  expect(normDeg(chainEnd(merged).rot - chainEnd(specs).rot)).toBeCloseTo(0);
});

test('mergeStraights leaves a lone straight, runs it cannot shorten and other pieces untouched', () => {
  const pieces = chain({ x: 0, y: 0, rot: 0 }, [['1', 'straight-d1'], ['k', 'curve-m-45'], ['2', 'straight-d1'], ['3', 'straight-d1']]);
  const specs: PieceSpec[] = [attachSpec('buffer', false, undefined, { x: 0, y: 0, rot: 180 }, 0), ...pieces.map(({ id: _id, ...s }) => s)];
  // two diagonals (2√2) would need four pieces, so they stay
  expect(mergeStraights(specs)).toEqual(specs);
});
