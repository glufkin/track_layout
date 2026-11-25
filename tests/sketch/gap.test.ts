import { test, expect } from 'vitest';
import { type Pose, applyPose, rotate } from '../../src/geom/vec';
import { Doc } from '../../src/model/doc';
import { type Piece, type Train, emptyLayout } from '../../src/model/types';
import { pieceGeometry, validFlex } from '../../src/track/catalog';
import { connKey } from '../../src/track/graph';
import { closeGap, isPlainTrack } from '../../src/sketch/gap';

/** A piece placed so its connector `enter` mates with the outward pose `at`. */
function attach(id: string, type: string, at: Pose, enter = 0, extra: Partial<Piece> = {}): Piece {
  const c = pieceGeometry({ type, flipped: false }).connectors[enter];
  const rot = at.rot + 180 - c.heading;
  const off = rotate(c.pos, rot);
  return { id, type, x: at.x - off.x, y: at.y - off.y, rot, level: 0, flipped: false, ...extra };
}

/** Outward pose of a piece's connector. */
function out(p: Piece, i: number): Pose {
  const c = pieceGeometry(p).connectors[i];
  const pos = applyPose(p, c.pos);
  return { x: pos.x, y: pos.y, rot: c.heading + p.rot };
}

/** Three straight-1s heading +x from the origin, then three more whose first connector sits on `start2` (travel heading `rot`). */
function line(start2: Pose): Piece[] {
  const left: Piece[] = [];
  let at: Pose = { x: 0, y: 0, rot: 0 };
  for (const id of ['a1', 'a2', 'a3']) { const p = attach(id, 'straight-1', at); left.push(p); at = out(p, 1); }
  const right: Piece[] = [];
  at = start2;
  for (const id of ['b1', 'b2', 'b3']) { const p = attach(id, 'straight-1', at); right.push(p); at = out(p, 1); }
  return [...left, ...right];
}

const openAt = (doc: Doc, ids: string[]) => doc.graph.open.filter((c) => ids.includes(c.pieceId));

test('isPlainTrack: straights, curves and flex only', () => {
  for (const t of ['straight-1', 'straight-d1', 'curve-s-45', 'curve-l-22', 'flex-straight', 'flex-curve']) expect(isPlainTrack(t)).toBe(true);
  for (const t of ['switch', 'switch-y', 'crossover-90', 'ramp-2', 'bridge-1', 'tunnel-1', 'tunnel-m-45', 'buffer']) expect(isPlainTrack(t)).toBe(false);
});

test('a 0.2U gap on a straight line closes with one flex straight', () => {
  // b1 starts at x = 3.2, carrying on in +x
  const doc = new Doc({ ...emptyLayout(), pieces: line({ x: 3.2, y: 0, rot: 0 }) });
  // the 0.2U gap is a near miss
  expect(doc.graph.nearMisses).toHaveLength(1);
  const [a, b] = doc.graph.nearMisses[0];
  const cmd = closeGap(doc, a, b)!;
  expect(cmd).not.toBeNull();
  cmd.do(doc);
  const added = doc.layout.pieces.filter((p) => !/^[ab]\d$/.test(p.id));
  expect(added).toHaveLength(1);
  expect(added[0].type).toBe('flex-straight');
  expect((added[0].flex as { length: number }).length).toBeCloseTo(0.2);
  expect(doc.layout.pieces).toHaveLength(7);
  expect(doc.graph.nearMisses).toEqual([]);
  expect(doc.graph.open.map((c) => connKey(c.pieceId, c.index)).sort()).toEqual(['a1:0', 'b3:1']);
});

test('a tiny offset closes by consuming neighbours; undo restores the pieces exactly', () => {
  // 0.03 sideways and 1° off: no flex piece fits in the gap itself
  const doc = new Doc({ ...emptyLayout(), pieces: line({ x: 3, y: 0.03, rot: 1 }) });
  expect(doc.graph.nearMisses).toHaveLength(1);
  const before = structuredClone(doc.layout.pieces);
  const [a, b] = doc.graph.nearMisses[0];
  const cmd = closeGap(doc, a, b)!;
  expect(cmd).not.toBeNull();
  cmd.do(doc);
  expect(doc.graph.nearMisses).toEqual([]);
  // only the far ends stay open
  expect(doc.graph.open.map((c) => connKey(c.pieceId, c.index)).sort()).toEqual(['a1:0', 'b3:1']);
  const ids = doc.layout.pieces.map((p) => p.id);
  expect(ids).toContain('a1'); expect(ids).toContain('b3');
  expect(ids.includes('a3') && ids.includes('b1')).toBe(false); // a neighbour at the gap was consumed
  for (const p of doc.layout.pieces) if (p.flex) expect(validFlex(p.type, p.flex)).toBe(true);
  expect(doc.layout.pieces.some((p) => p.type.startsWith('flex-'))).toBe(true);
  cmd.undo(doc);
  expect(doc.layout.pieces).toEqual(before);
  expect(doc.graph.nearMisses).toHaveLength(1);
});

test('a gap whose only neighbours are switches is left alone (null)', () => {
  const s1 = attach('s1', 'switch', { x: 0, y: 0, rot: 180 });
  const at = out(s1, 1);
  // s2's straight exit lies 0.03 sideways and 1° off s1's straight exit
  const s2 = attach('s2', 'switch', { x: at.x, y: at.y + 0.03, rot: at.rot + 1 }, 1);
  const doc = new Doc({ ...emptyLayout(), pieces: [s1, s2] });
  expect(doc.graph.nearMisses).toHaveLength(1);
  const [a, b] = doc.graph.nearMisses[0];
  expect(closeGap(doc, a, b)).toBeNull();
});

test('a train on a consumed piece is lifted', () => {
  const doc = new Doc({ ...emptyLayout(), pieces: line({ x: 3, y: 0.03, rot: 1 }) });
  const train: Train = {
    id: 't1', cars: 0, color: '#c0392b', speed: 1, running: true, head: { pieceId: 'a3', route: 0, dist: 0.8, dir: 1 },
    lifted: null, currentSpeed: 1, crashed: false, crashAt: null,
  };
  doc.layout.trains.push(train);
  const [a, b] = doc.graph.nearMisses[0];
  const cmd = closeGap(doc, a, b)!;
  cmd.do(doc);
  expect(doc.piece('a3')).toBeUndefined();
  expect(doc.train('t1')).toMatchObject({ head: null, running: false });
  expect(doc.train('t1')!.lifted).not.toBeNull();
});

test('a close whose new chain would overlap other track is skipped for one that fits, else null', () => {
  // As above, with a loose straight standing across a3 (an existing overlap with a3 only).
  const post = attach('o', 'straight-1', { x: 2.5, y: 0.1, rot: 90 });
  const doc = new Doc({ ...emptyLayout(), pieces: [...line({ x: 3, y: 0.03, rot: 1 }), post] });
  const [a, b] = doc.graph.nearMisses[0];
  const cmd = closeGap(doc, a, b)!;
  expect(cmd).not.toBeNull();
  cmd.do(doc);
  expect(doc.graph.nearMisses).toEqual([]);
  const fresh = new Set(doc.layout.pieces.filter((p) => !/^([ab]\d|o)$/.test(p.id)).map((p) => p.id));
  expect(doc.graph.overlaps.filter(([x, y]) => fresh.has(x) || fresh.has(y))).toEqual([]);
  expect(doc.piece('a3')).toBeDefined(); // consuming a3 would run the chain past the post

  // With posts across both a3 and b1, nothing fits.
  const post2 = attach('q', 'straight-1', { x: 3.5, y: 0.13, rot: 90 });
  const doc2 = new Doc({ ...emptyLayout(), pieces: [...line({ x: 3, y: 0.03, rot: 1 }), post, post2] });
  const [a2, b2] = doc2.graph.nearMisses[0];
  expect(closeGap(doc2, a2, b2)).toBeNull();
});
