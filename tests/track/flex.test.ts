import { test, expect } from 'vitest';
import { dist, angleDiff, applyPose } from '../../src/geom/vec';
import {
  CATALOG, FLEX_DEFAULTS, FLEX_LIMITS, R_M, R_S, pieceGeometry, validFlex, type FlexParams,
} from '../../src/track/catalog';
import { buildGraph, worldConnectors } from '../../src/track/graph';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece } from '../../src/model/types';
import { advance, poseAt } from '../../src/sim/motion';

const P = (id: string, type: string, x: number, y: number, rot = 0, extra: Partial<Piece> = {}): Piece =>
  ({ id, type, x, y, rot, level: 0, flipped: false, ...extra });

test('flex straight of 1.3 has connectors 1.3 apart, opposite headings', () => {
  const g = pieceGeometry({ type: 'flex-straight', flipped: false, flex: { length: 1.3 } });
  expect(dist(g.connectors[0].pos, g.connectors[1].pos)).toBeCloseTo(1.3);
  expect(angleDiff(g.connectors[0].heading, g.connectors[1].heading + 180)).toBeLessThan(1e-9);
  expect(g.routes).toHaveLength(1);
  expect(g.routes[0].path.length).toBeCloseTo(1.3);
  expect(g.footprint).toHaveLength(1);
});
test('flex curve R_M/45 equals curve-m-45 geometry; flipped turns left', () => {
  const f = pieceGeometry({ type: 'flex-curve', flipped: false, flex: { radius: R_M, sweep: 45 } });
  const c = pieceGeometry({ type: 'curve-m-45', flipped: false });
  expect(f.connectors[1].pos.x).toBeCloseTo(c.connectors[1].pos.x); expect(f.connectors[1].pos.y).toBeCloseTo(c.connectors[1].pos.y);
  expect(f.connectors[1].heading).toBeCloseTo(c.connectors[1].heading);
  expect(f.footprint).toEqual(c.footprint);
  const fl = pieceGeometry({ type: 'flex-curve', flipped: true, flex: { radius: R_M, sweep: 45 } });
  expect(fl.connectors[1].pos.y).toBeLessThan(0);
  expect(fl.connectors[1].pos.y).toBeCloseTo(pieceGeometry({ type: 'curve-m-45', flipped: true }).connectors[1].pos.y);
});
test('catalogue piece geometry from pieceGeometry matches the catalogue', () => {
  const g = pieceGeometry({ type: 'switch', flipped: true });
  expect(g.connectors[2].pos.y).toBeLessThan(0);
  expect(g.connectors).toHaveLength(3);
});
test('a flex piece without params uses the defaults; the catalogue entries are labelled', () => {
  expect(FLEX_DEFAULTS).toEqual({ 'flex-straight': { length: 1 }, 'flex-curve': { radius: R_M, sweep: 22.5 } });
  expect(FLEX_LIMITS).toEqual({ minLength: 0.05, maxLength: 4, minRadius: R_S, maxRadius: 8, maxSweep: 45 });
  expect(pieceGeometry({ type: 'flex-straight', flipped: false }).routes[0].path.length).toBeCloseTo(1);
  const c = pieceGeometry({ type: 'flex-curve', flipped: false });
  expect(c.routes[0].path.length).toBeCloseTo(R_M * Math.PI / 8);
  expect(CATALOG['flex-straight']).toMatchObject({ family: 'flex', label: 'Flex straight', flex: 'straight', flippable: false });
  expect(CATALOG['flex-curve']).toMatchObject({ family: 'flex', label: 'Flex curve', flex: 'curve', flippable: true });
});
test('pieceGeometry is cached per parameter set', () => {
  const a = pieceGeometry({ type: 'flex-straight', flipped: false, flex: { length: 2.5 } });
  expect(pieceGeometry({ type: 'flex-straight', flipped: false, flex: { length: 2.5 } })).toBe(a);
  expect(pieceGeometry({ type: 'flex-straight', flipped: false, flex: { length: 2.6 } })).not.toBe(a);
});
test('validFlex enforces limits and shape', () => {
  expect(validFlex('flex-straight', { length: 0.05 })).toBe(true);
  expect(validFlex('flex-straight', { length: 4 })).toBe(true);
  expect(validFlex('flex-straight', { length: 0.04 })).toBe(false);
  expect(validFlex('flex-straight', { length: 4.01 })).toBe(false);
  expect(validFlex('flex-straight', undefined)).toBe(false);
  expect(validFlex('flex-curve', { radius: R_S, sweep: 45 })).toBe(true);
  expect(validFlex('flex-curve', { radius: 0.3, sweep: 10 })).toBe(false);
  expect(validFlex('flex-curve', { radius: 2, sweep: 46 })).toBe(false);
  expect(validFlex('flex-curve', { radius: 2, sweep: 0 })).toBe(false);
  expect(validFlex('flex-curve', { radius: 8.1, sweep: 10 })).toBe(false);
  expect(validFlex('flex-curve', { length: 1 } as FlexParams)).toBe(false);
  expect(validFlex('flex-straight', { radius: 2, sweep: 10 } as FlexParams)).toBe(false);
  expect(validFlex('straight-1', { length: 1 })).toBe(false);
});
test('two flex straights end to end join in the graph', () => {
  const g = buildGraph([
    P('a', 'flex-straight', 0, 0, 0, { flex: { length: 1.3 } }),
    P('b', 'flex-straight', 1.3, 0, 0, { flex: { length: 0.7 } }),
  ]);
  expect(g.joins.size).toBe(2);
  expect(g.open).toHaveLength(2);
});
test('a train runs across a flex curve', () => {
  const curve = P('c', 'flex-curve', 1, 0, 0, { flex: { radius: 2, sweep: 30 } });
  const end = worldConnectors(curve)[1];
  const pieces = [
    P('a', 'straight-1', 0, 0),
    curve,
    P('b', 'straight-1', end.pos.x, end.pos.y, end.heading),
  ];
  const d = new Doc({ ...emptyLayout(), pieces });
  expect(d.graph.joins.size).toBe(4);
  const r = advance(d, { pieceId: 'a', route: 0, dist: 0.5, dir: 1 }, 0.5 + 2 * Math.PI * 2 * 30 / 360 + 0.5, { alignTrailing: false });
  expect(r.pos.pieceId).toBe('b');
  expect(r.pos.dist).toBeCloseTo(0.5, 6);
  const before = poseAt(d, { pieceId: 'a', route: 0, dist: 0.5, dir: 1 });
  const after = poseAt(d, r.pos);
  expect(angleDiff(after.heading - before.heading, 30)).toBeLessThan(1e-6);
  expect(dist(after.pos, applyPose(pieces[2], { x: 0.5, y: 0 }))).toBeLessThan(1e-6);
});
