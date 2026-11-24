import { test, expect } from 'vitest';
import { applyPose, type Pose } from '../../src/geom/vec';
import { pieceConnectors } from '../../src/track/catalog';
import { buildGraph, connKey } from '../../src/track/graph';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece } from '../../src/model/types';

const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece =>
  ({ id, type, x, y, rot, level, flipped: false });

test('two straights end to end join', () => {
  const g = buildGraph([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0)]);
  expect(g.joins.get(connKey('a', 1))?.pieceId).toBe('b');
  expect(g.joins.get(connKey('b', 0))?.pieceId).toBe('a');
  expect(g.open).toHaveLength(2);
  expect(g.overlaps).toHaveLength(0);
});
test('different levels never join', () => {
  expect(buildGraph([P('a', 'straight-1', 0, 0, 0, 0), P('b', 'straight-1', 1, 0, 0, 1)]).joins.size).toBe(0);
});
test('a ramp high end joins level+1', () => {
  expect(buildGraph([P('r', 'ramp-2', 0, 0, 0, 0), P('b', 'straight-1', 2, 0, 0, 1)]).joins.size).toBe(2);
});
test('0.1U gap is a near miss, not a join', () => {
  const g = buildGraph([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1.1, 0)]);
  expect(g.joins.size).toBe(0);
  expect(g.nearMisses).toHaveLength(1);
});
test('a closed circle of 8 curves has no open connectors and no overlaps', () => {
  const pieces: Piece[] = [];
  let cur: Pose = { x: 0, y: 0, rot: 180 }; // pose a connector must mate with
  for (let i = 0; i < 8; i++) {
    const [enter, exit] = pieceConnectors('curve-m-45', false);
    const rot = cur.rot + 180 - enter.heading;
    const off = applyPose({ x: 0, y: 0, rot }, enter.pos);
    const piece = { x: cur.x - off.x, y: cur.y - off.y, rot };
    pieces.push(P('c' + i, 'curve-m-45', piece.x, piece.y, piece.rot));
    const e = applyPose(piece, exit.pos);
    cur = { x: e.x, y: e.y, rot: rot + exit.heading };
  }
  const g = buildGraph(pieces);
  expect(g.open).toHaveLength(0);
  expect(g.joins.size).toBe(16);
  expect(g.overlaps).toHaveLength(0);
});
test('three connectors at one point: exactly one pair joins, deterministically', () => {
  const ps = [P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0), P('c', 'straight-1', 1, 0)];
  const g1 = buildGraph(ps), g2 = buildGraph([...ps].reverse());
  expect(g1.joins.size).toBe(2);
  expect([...g1.joins.keys()].sort()).toEqual([...g2.joins.keys()].sort());
});
test('crossing straights at same level overlap; at different levels they do not', () => {
  expect(buildGraph([P('a', 'straight-2', 0, 0), P('b', 'straight-2', 1, -1, 90)]).overlaps).toEqual([['a', 'b']]);
  expect(buildGraph([P('a', 'straight-2', 0, 0), P('b', 'straight-2', 1, -1, 90, 1)]).overlaps).toHaveLength(0);
});
test('stacked identical pieces overlap; a crossover does not overlap itself', () => {
  expect(buildGraph([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 0, 0)]).overlaps).toHaveLength(1);
  expect(buildGraph([P('x', 'crossover-90', 0, 0)]).overlaps).toHaveLength(0);
});
test('1000 pieces rebuild quickly', () => {
  const ps: Piece[] = [];
  for (let i = 0; i < 1000; i++) ps.push(P('s' + i, 'straight-1', (i % 40) * 1, Math.floor(i / 40) * 2));
  buildGraph(ps);
  const t = performance.now();
  buildGraph(ps);
  expect(performance.now() - t).toBeLessThan(50);
});
test('Doc.newId never collides', () => {
  const d = new Doc({ ...emptyLayout(), pieces: [P('p1', 'straight-1', 0, 0)] });
  expect(d.newId('p')).not.toBe('p1');
  expect(d.graph.open).toHaveLength(2);
});
