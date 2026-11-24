import { test, expect } from 'vitest';
import { applyPose, type Pose } from '../../src/geom/vec';
import { pieceConnectors, R_M } from '../../src/track/catalog';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece, type Train, type TrackPos } from '../../src/model/types';
import {
  LOCO_LEN, CAR_LEN, COUPLING, CAR_WIDTH, trainLength, advance, walkBack, poseAt, carPoses,
  occupiedPieces, distanceAhead, reverseHead, routeEntering,
} from '../../src/sim/motion';

const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece =>
  ({ id, type, x, y, rot, level, flipped: false });
const doc = (pieces: Piece[], trains: Train[] = []): Doc => new Doc({ ...emptyLayout(), pieces, trains });
const sw = (id: string, x: number, y: number, state: 0 | 1, rot = 0): Piece =>
  ({ ...P(id, 'switch', x, y, rot), switch: { mode: 'manual', state } });
const train = (head: TrackPos | null, cars: number): Train => ({
  id: 't1', cars, color: '#c00', speed: 1, running: false, head, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null,
});
const T = (pieceId: string, dist: number, dir: 1 | -1 = 1, route = 0): TrackPos => ({ pieceId, route, dist, dir });

/** A straight-1 whose connector 0 mates with connector `c` of piece `p` (extends outwards). */
function straightOff(id: string, p: Piece, c: number): Piece {
  const k = pieceConnectors(p.type, p.flipped)[c];
  const pos = applyPose(p, k.pos);
  return P(id, 'straight-1', pos.x, pos.y, k.heading + p.rot);
}

function circle(): Piece[] {
  const pieces: Piece[] = [];
  let cur: Pose = { x: 0, y: 0, rot: 180 };
  for (let i = 0; i < 8; i++) {
    const [enter, exit] = pieceConnectors('curve-m-45', false);
    const rot = cur.rot + 180 - enter.heading;
    const off = applyPose({ x: 0, y: 0, rot }, enter.pos);
    const piece = { x: cur.x - off.x, y: cur.y - off.y, rot };
    pieces.push(P('c' + i, 'curve-m-45', piece.x, piece.y, piece.rot));
    const e = applyPose(piece, exit.pos);
    cur = { x: e.x, y: e.y, rot: rot + exit.heading };
  }
  return pieces;
}

/** Five straight-2 pieces s0..s4 along +x from 0 to 10. */
const longLine = (): Piece[] => [0, 1, 2, 3, 4].map((i) => P('s' + i, 'straight-2', 2 * i, 0));

test('constants and trainLength', () => {
  expect([LOCO_LEN, CAR_LEN, COUPLING, CAR_WIDTH]).toEqual([1.0, 0.8, 0.1, 0.45]);
  expect(trainLength(0)).toBe(1);
  expect(trainLength(3)).toBeCloseTo(1 + 3 * 0.9, 12);
});

test('advance crosses from one straight into the next', () => {
  const d = doc([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0)]);
  const r = advance(d, T('a', 0.5), 1, { alignTrailing: false });
  expect(r.pos.pieceId).toBe('b');
  expect(r.pos.route).toBe(0);
  expect(r.pos.dist).toBeCloseTo(0.5, 9);
  expect(r.pos.dir).toBe(1);
  expect(r.moved).toBeCloseTo(1, 9);
  expect(r.hitEnd).toBe(false);
  expect(r.entered).toEqual([{ pieceId: 'b', viaConnector: 0, facing: false }]);
});

test('advance in dir -1 crosses back into the previous piece', () => {
  const d = doc([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0)]);
  const r = advance(d, T('b', 0.5, -1), 1, { alignTrailing: false });
  expect(r.pos).toMatchObject({ pieceId: 'a', route: 0, dir: -1 });
  expect(r.pos.dist).toBeCloseTo(0.5, 9);
  expect(r.entered).toEqual([{ pieceId: 'a', viaConnector: 1, facing: false }]);
});

test('advance stops at an open end with hitEnd', () => {
  const d = doc([P('a', 'straight-1', 0, 0)]);
  const r = advance(d, T('a', 0.5), 5, { alignTrailing: false });
  expect(r.pos.dist).toBeCloseTo(1, 9);
  expect(r.hitEnd).toBe(true);
  expect(r.moved).toBeCloseTo(0.5, 9);
  const back = advance(d, T('a', 0.5, -1), 5, { alignTrailing: false });
  expect(back.pos.dist).toBeCloseTo(0, 9);
  expect(back.hitEnd).toBe(true);
});

test('advance clamps an out-of-range dist', () => {
  const d = doc([P('a', 'straight-1', 0, 0)]);
  const r = advance(d, T('a', 7), 0.25, { alignTrailing: false });
  expect(r.pos.dist).toBeCloseTo(1, 9);
  expect(r.hitEnd).toBe(true);
  const r2 = advance(d, T('a', -3), 0.25, { alignTrailing: false });
  expect(r2.pos.dist).toBeCloseTo(0.25, 9);
});

test('facing switch follows its state', () => {
  for (const state of [0, 1] as const) {
    const d = doc([P('a', 'straight-1', -1, 0), sw('s', 0, 0, state)]);
    const r = advance(d, T('a', 0.5), 1, { alignTrailing: true });
    expect(r.pos).toMatchObject({ pieceId: 's', route: state, dir: 1 });
    expect(r.pos.dist).toBeCloseTo(0.5, 9);
    expect(r.entered).toEqual([{ pieceId: 's', viaConnector: 0, facing: true }]);
    expect(d.piece('s')!.switch!.state).toBe(state);
  }
});

test('trailing switch aligns itself when alignTrailing', () => {
  for (const align of [true, false]) {
    const s = sw('s', 0, 0, 0);
    const b = straightOff('b', s, 2);
    const d = doc([s, b]);
    // On b travelling towards its connector 0, which mates with the switch branch (connector 2).
    const r = advance(d, T('b', 0.5, -1), 1, { alignTrailing: align });
    expect(r.pos).toMatchObject({ pieceId: 's', route: 1, dir: -1 });
    expect(r.pos.dist).toBeCloseTo(R_M * Math.PI / 4 - 0.5, 9);
    expect(r.entered).toEqual([{ pieceId: 's', viaConnector: 2, facing: false }]);
    expect(d.piece('s')!.switch!.state).toBe(align ? 1 : 0);
  }
});

test('routeEntering: facing, trailing and plain pieces', () => {
  const d = doc([sw('s', 0, 0, 1), P('x', 'crossover-90', 5, 5), P('a', 'straight-1', 9, 9)]);
  expect(routeEntering(d, 's', 0)).toEqual({ route: 1, dir: 1, facing: true });
  expect(routeEntering(d, 's', 1)).toEqual({ route: 0, dir: -1, facing: false });
  expect(routeEntering(d, 's', 2)).toEqual({ route: 1, dir: -1, facing: false });
  expect(routeEntering(d, 'x', 2)).toEqual({ route: 1, dir: 1, facing: false });
  expect(routeEntering(d, 'x', 3)).toEqual({ route: 1, dir: -1, facing: false });
  expect(routeEntering(d, 'a', 1)).toEqual({ route: 0, dir: -1, facing: false });
});

test('buffer stop: reaching route end is hitEnd', () => {
  const d = doc([P('a', 'straight-1', 0, 0), P('b', 'buffer', 1, 0)]);
  const r = advance(d, T('a', 0), 10, { alignTrailing: false });
  expect(r.pos.pieceId).toBe('b');
  expect(r.pos.dist).toBeCloseTo(0.5, 9);
  expect(r.moved).toBeCloseTo(1.5, 9);
  expect(r.hitEnd).toBe(true);
});

test('circle of 8 curves: advancing one full circumference returns to start', () => {
  const d = doc(circle());
  const C = 8 * (Math.PI * R_M / 4);
  const r = advance(d, T('c0', 0.3), C, { alignTrailing: false });
  expect(r.pos.pieceId).toBe('c0');
  expect(r.pos.dist).toBeCloseTo(0.3, 6);
  expect(r.hitEnd).toBe(false);
  expect(r.entered).toHaveLength(8);
  // many laps in one call
  const r10 = advance(d, T('c0', 0.3), 10 * C, { alignTrailing: false });
  expect(r10.pos.pieceId).toBe('c0');
  expect(r10.pos.dist).toBeCloseTo(0.3, 6);
  expect(r10.moved).toBeCloseTo(10 * C, 6);
});

test('poseAt: heading is direction of travel; ramp level switches at half way', () => {
  const d = doc([P('a', 'straight-1', 0, 0, 90), P('r', 'ramp-2', 5, 0, 0, 1)]);
  const f = poseAt(d, T('a', 0.25));
  expect(f.pos.x).toBeCloseTo(0, 9);
  expect(f.pos.y).toBeCloseTo(0.25, 9);
  expect(f.heading).toBeCloseTo(90, 9);
  expect(f.level).toBe(0);
  expect(poseAt(d, T('a', 0.25, -1)).heading).toBeCloseTo(-90, 9);
  expect(poseAt(d, T('r', 0.9)).level).toBe(1);
  expect(poseAt(d, T('r', 1.1)).level).toBe(2);
});

test('carPoses for 3 cars returns 4 poses spaced by trainLength pieces', () => {
  const d = doc(longLine());
  const poses = carPoses(d, train(T('s4', 1.5), 3));
  expect(poses).toHaveLength(4);
  expect(poses.map((p) => p.isLoco)).toEqual([true, false, false, false]);
  expect(poses.map((p) => p.length)).toEqual([LOCO_LEN, CAR_LEN, CAR_LEN, CAR_LEN]);
  const xs = [9.0, 8.0, 7.1, 6.2];
  poses.forEach((p, i) => {
    expect(p.center.x).toBeCloseTo(xs[i], 9);
    expect(p.center.y).toBeCloseTo(0, 9);
    expect(p.heading).toBeCloseTo(0, 9);
    expect(p.level).toBe(0);
  });
  expect(poses[0].center.x - poses[1].center.x).toBeCloseTo(LOCO_LEN / 2 + COUPLING + CAR_LEN / 2, 9);
  expect(poses[0].pieceIds).toEqual(['s4']);
  expect(poses[1].pieceIds).toEqual(['s4', 's3']);
  expect(poses[3].pieceIds).toEqual(['s3', 's2']);
});

test('carPoses: lifted train has no poses; cars pile at a dead end', () => {
  const d = doc([P('a', 'straight-1', 0, 0)]);
  expect(carPoses(d, train(null, 2))).toEqual([]);
  const poses = carPoses(d, train(T('a', 0.9), 2));
  expect(poses).toHaveLength(3);
  expect(poses[0].center.x).toBeCloseTo(0.4, 9);
  expect(poses[1].center.x).toBeCloseTo(0, 9);
  expect(poses[2].center.x).toBeCloseTo(0, 9);
});

test('walkBack moves against dir and keeps dir', () => {
  const d = doc(longLine());
  const p = walkBack(d, T('s4', 1.5), 3);
  expect(p).toMatchObject({ pieceId: 's3', dir: 1 });
  expect(p.dist).toBeCloseTo(0.5, 9);
  const q = walkBack(d, T('s0', 1.5), 3);
  expect(q).toMatchObject({ pieceId: 's0', dir: 1, dist: 0 });
});

test('walkBack does not change switches', () => {
  const s = sw('s', 0, 0, 0);
  const b = straightOff('b', s, 2);
  const d = doc([s, b]);
  // Train on b heading away from the switch; walking back crosses the switch trailing.
  const p = walkBack(d, T('b', 0.5, 1), 1);
  expect(p).toMatchObject({ pieceId: 's', route: 1, dir: 1 });
  expect(d.piece('s')!.switch!.state).toBe(0);
});

test('reverseHead puts head at former tail, dir flipped', () => {
  const d = doc(longLine());
  const h = reverseHead(d, train(T('s4', 1.5), 3));
  expect(h).toMatchObject({ pieceId: 's2', route: 0, dir: -1 });
  expect(h.dist).toBeCloseTo(9.5 - trainLength(3) - 4, 9);
  // reversing twice returns to the original head
  const h2 = reverseHead(d, train(h, 3));
  expect(h2).toMatchObject({ pieceId: 's4', dir: 1 });
  expect(h2.dist).toBeCloseTo(1.5, 9);
});

test('occupiedPieces lists every piece a car overlaps', () => {
  const d = doc(longLine());
  expect([...occupiedPieces(d, train(T('s4', 1.5), 3))].sort()).toEqual(['s2', 's3', 's4']);
  expect(occupiedPieces(d, train(null, 3)).size).toBe(0);
});

test('distanceAhead stops at a buffer', () => {
  const d = doc([P('a', 'straight-1', 0, 0), P('b', 'buffer', 1, 0)]);
  expect(distanceAhead(d, T('a', 0), 10)).toBeCloseTo(1.5, 9);
  expect(distanceAhead(d, T('a', 0), 1)).toBeCloseTo(1, 9);
});

test('distanceAhead follows switch state without changing it', () => {
  const s = sw('s', 0, 0, 1);
  const d = doc([P('a', 'straight-1', -1, 0), s, straightOff('b', s, 2)]);
  expect(distanceAhead(d, T('a', 0), 100)).toBeCloseTo(1 + R_M * Math.PI / 4 + 1, 9);
  s.switch!.state = 0;
  expect(distanceAhead(d, T('a', 0), 100)).toBeCloseTo(2, 9);
});
