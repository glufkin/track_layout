import { test, expect } from 'vitest';
import { computeGhost, snapGroup, posesAfterGroup, GRID, ROT_STEP, type GhostRequest } from '../../src/editor/snapping';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece } from '../../src/model/types';

const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece =>
  ({ id, type, x, y, rot, level, flipped: false });
const docOf = (...ps: Piece[]) => { const l = emptyLayout(); l.pieces = ps; return new Doc(l); };
const req = (o: Partial<GhostRequest>): GhostRequest =>
  ({ type: 'straight-1', flipped: false, attachIndex: 0, cursor: { x: 0, y: 0 }, freeRot: 0, level: 0, alt: false, snapRadius: 0.25, ...o });

test('constants', () => { expect(GRID).toBe(0.5); expect(ROT_STEP).toBe(22.5); });

test('snaps curve to an open straight end', () => {
  const d = docOf(P('a', 'straight-1', 0, 0));
  const r = computeGhost(d, req({ type: 'curve-m-45', cursor: { x: 1.05, y: 0.02 } }));
  expect(r.mode).toBe('connector');
  expect(r.pose.x).toBeCloseTo(1); expect(r.pose.y).toBeCloseTo(0); expect(r.pose.rot).toBeCloseTo(0);
  expect(r.target?.pieceId).toBe('a'); expect(r.target?.index).toBe(1);
});

test('Tab cycles attachIndex modulo connector count', () => {
  const d = docOf();
  expect(computeGhost(d, req({ type: 'switch', attachIndex: 4 })).attachIndex).toBe(1);
  expect(computeGhost(d, req({ type: 'switch', attachIndex: 3 })).attachIndex).toBe(0);
});

test('attachIndex 1 attaches the other connector', () => {
  const d = docOf(P('a', 'straight-1', 0, 0));
  const r = computeGhost(d, req({ attachIndex: 1, cursor: { x: -0.05, y: 0 } }));
  expect(r.mode).toBe('connector');
  // ghost connector 1 (at local (1,0), heading 0) must land on a's connector 0 at (0,0) heading 180
  expect(r.pose.x).toBeCloseTo(-1); expect(r.pose.y).toBeCloseTo(0); expect(r.pose.rot).toBeCloseTo(0);
});

test('falls back to grid: origin multiple of 0.5, rot multiple of 22.5', () => {
  const r = computeGhost(docOf(), req({ cursor: { x: 3.3, y: 1.8 }, freeRot: 50, level: 2 }));
  expect(r.mode).toBe('grid');
  expect(r.pose).toEqual({ x: 3.5, y: 2, rot: 45 });
  expect(r.level).toBe(2);
});

test('alt gives free placement exactly at cursor', () => {
  const d = docOf(P('a', 'straight-1', 0, 0));
  const r = computeGhost(d, req({ cursor: { x: 1.05, y: 0.02 }, freeRot: 13, alt: true, level: 1 }));
  expect(r.mode).toBe('free');
  expect(r.pose).toEqual({ x: 1.05, y: 0.02, rot: 13 });
  expect(r.level).toBe(1);
});

test('attaching to a ramp high end puts the ghost at level+1', () => {
  const d = docOf(P('r', 'ramp-2', 0, 0));
  const r = computeGhost(d, req({ cursor: { x: 2.02, y: 0 } }));
  expect(r.mode).toBe('connector');
  expect(r.pose.x).toBeCloseTo(2);
  expect(r.level).toBe(1);
});

test('attaching the ghost low end to a high target lowers the ghost level', () => {
  const d = docOf(P('r', 'ramp-2', 0, 0));
  // ghost ramp connector 1 (high end, offset 1) attached to the ramp's open high end? use ghost conn 0 at level-1 target
  const r = computeGhost(d, req({ type: 'ramp-2', attachIndex: 1, cursor: { x: 0, y: 0 } }));
  // target is r conn 0 (level 0); ghost conn 1 has offset 1 → ghost level -1 is rejected → grid
  expect(r.mode).toBe('grid');
});

test('prefer wins within 3x radius even if another connector is nearer', () => {
  const d = docOf(P('a', 'straight-1', 0, 0), P('b', 'straight-1', 3, 0, 0));
  const open = d.graph.open;
  const near = open.find((c) => c.pieceId === 'a' && c.index === 1)!;   // (1,0)
  const pref = open.find((c) => c.pieceId === 'b' && c.index === 0)!;   // (3,0)
  const cursor = { x: 1.9, y: 0 };
  // with a larger radius, prefer (3,0) is 1.1 away <= 3*0.4; near is 0.9 away
  const r = computeGhost(d, req({ cursor, snapRadius: 0.4, prefer: pref }));
  expect(r.target?.pieceId).toBe('b');
  const r2 = computeGhost(d, req({ cursor: { x: 1.2, y: 0 }, snapRadius: 0.4 }));
  expect(r2.target).toEqual(near);
  const r3 = computeGhost(d, req({ cursor: { x: 1.2, y: 0 }, snapRadius: 0.1, prefer: pref }));
  expect(r3.mode).toBe('grid');
});

test('snapGroup aligns a dragged straight to a neighbour within radius', () => {
  const d = docOf(P('a', 'straight-1', 0, 0), P('b', 'straight-1', 3, 0.1));
  const g = snapGroup(d, ['b'], { delta: { x: -1.95, y: -0.05 }, rot: 3, pivot: { x: 3, y: 0.1 } }, 0.25, false);
  const poses = posesAfterGroup(d, ['b'], g);
  const b = poses.get('b')!;
  expect(b.x).toBeCloseTo(1); expect(b.y).toBeCloseTo(0); expect(b.rot).toBeCloseTo(0);
});

test('snapGroup returns proposal when alt, or when nothing in range', () => {
  const d = docOf(P('a', 'straight-1', 0, 0), P('b', 'straight-1', 3, 0.1));
  const prop = { delta: { x: -1.95, y: -0.05 }, rot: 3, pivot: { x: 3, y: 0.1 } };
  expect(snapGroup(d, ['b'], prop, 0.25, true)).toEqual(prop);
  const far = { delta: { x: 5, y: 5 }, rot: 0, pivot: { x: 3, y: 0.1 } };
  expect(snapGroup(d, ['b'], far, 0.25, false)).toEqual(far);
});

test('snapGroup ignores connectors joined within the selection', () => {
  const d = docOf(P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0), P('c', 'straight-1', 6, 0));
  const prop = { delta: { x: 0, y: 0.05 }, rot: 0, pivot: { x: 0, y: 0 } };
  // a+b selected: joined connector a1/b0 must not snap to anything; c is far.
  expect(snapGroup(d, ['a', 'b'], prop, 0.25, false)).toEqual(prop);
});

test('posesAfterGroup rotates about the pivot then translates', () => {
  const d = docOf(P('a', 'straight-1', 1, 0, 10));
  const m = posesAfterGroup(d, ['a'], { delta: { x: 5, y: 0 }, rot: 90, pivot: { x: 0, y: 0 } });
  const a = m.get('a')!;
  expect(a.x).toBeCloseTo(5); expect(a.y).toBeCloseTo(1); expect(a.rot).toBeCloseTo(100);
});
