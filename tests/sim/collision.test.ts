import { test, expect } from 'vitest';
import { applyPose } from '../../src/geom/vec';
import { pieceConnectors } from '../../src/track/catalog';
import { Doc } from '../../src/model/doc';
import { emptyLayout, MAX_CARS, type Piece, type Train, type TrackPos } from '../../src/model/types';
import { carPoses, CAR_WIDTH, type CarPose } from '../../src/sim/motion';
import { carsOverlap, findCollisions, checkCollisions } from '../../src/sim/collision';
import { Simulation, STEP } from '../../src/sim/simulation';

const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece =>
  ({ id, type, x, y, rot, level, flipped: false });
const T = (pieceId: string, dist: number, dir: 1 | -1 = 1, route = 0): TrackPos => ({ pieceId, route, dist, dir });
const train = (id: string, head: TrackPos | null, o: Partial<Train> = {}): Train => ({
  id, cars: 0, color: '#c00', speed: 1, running: true, head, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null, ...o,
});
const doc = (pieces: Piece[], trains: Train[], collisions = true): Doc => {
  const l = emptyLayout();
  l.settings.collisions = collisions;
  return new Doc({ ...l, pieces, trains });
};
function off(id: string, type: string, p: Piece, c: number): Piece {
  const k = pieceConnectors(p.type, p.flipped)[c];
  const pos = applyPose(p, k.pos);
  return P(id, type, pos.x, pos.y, k.heading + p.rot, p.level);
}
const line = (): Piece[] => [0, 1, 2, 3, 4].map((i) => P('s' + i, 'straight-2', 2 * i, 0));
function run(sim: Simulation, seconds: number): void {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) sim.step(STEP);
}
const headOn = (collisions = true): { d: Doc; a: Train; b: Train } => {
  const a = train('a', T('s1', 2));
  const b = train('b', T('s3', 0, -1));
  return { d: doc(line(), [a, b], collisions), a, b };
};
const rect = (x: number, y: number, heading: number, level = 0, length = 1): CarPose =>
  ({ center: { x, y }, heading, length, level, isLoco: true, pieceIds: [] });

test('carsOverlap: SAT on oriented rectangles', () => {
  expect(carsOverlap(rect(0, 0, 0), rect(0.9, 0, 0))).toBe(true);
  expect(carsOverlap(rect(0, 0, 0), rect(1.1, 0, 0))).toBe(false);
  expect(carsOverlap(rect(0, 0, 0), rect(0, CAR_WIDTH - 0.05, 0))).toBe(true);
  expect(carsOverlap(rect(0, 0, 0), rect(0, CAR_WIDTH + 0.05, 0))).toBe(false);
  // Perpendicular cross overlaps; a rotated rect whose bounding circles touch but shapes do not, does not.
  expect(carsOverlap(rect(0, 0, 0), rect(0, 0, 90))).toBe(true);
  expect(carsOverlap(rect(0, 0, 0), rect(0, 0.7, 0))).toBe(false);
  expect(carsOverlap(rect(0, 0, 0, 0), rect(0, 0, 0, 1))).toBe(false);
});

test('findCollisions skips lifted trains and never pairs a train with itself', () => {
  const a = train('a', T('s1', 2));
  const b = train('b', T('s1', 2), { head: null, lifted: { x: 0, y: 0, rot: 0 } });
  const d = doc(line(), [a, b]);
  expect(findCollisions(d)).toEqual([]);
  const c = train('c', T('s1', 1.5));
  const hits = findCollisions(doc(line(), [a, c]));
  expect(hits).toHaveLength(1);
  expect([hits[0].a, hits[0].b].sort()).toEqual(['a', 'c']);
});

test('head-on trains on one straight crash and stop', () => {
  const { d, a, b } = headOn();
  const sim = new Simulation(d);
  run(sim, 5);
  for (const t of [a, b]) {
    expect(t.crashed).toBe(true);
    expect(t.running).toBe(false);
    expect(t.currentSpeed).toBe(0);
    expect(t.crashAt).not.toBeNull();
  }
  expect(a.crashAt).toEqual(b.crashAt);
  expect(a.crashAt!.x).toBeGreaterThan(4);
  expect(a.crashAt!.x).toBeLessThan(6.5);
  expect(a.crashAt!.y).toBeCloseTo(0, 6);
});

test('collisions off: trains pass through', () => {
  const { d, a, b } = headOn(false);
  run(new Simulation(d), 5);
  expect(a.crashed).toBe(false);
  expect(b.crashed).toBe(false);
  expect(a.running && b.running).toBe(true);
});

test('train on a bridge (level 1) does not collide with one below', () => {
  const mk = (bridgeLevel: number): [Doc, Train, Train] => {
    const under = P('u', 'straight-2', 0, 0);
    const br = P('br', 'bridge-2', 1, -1, 90, bridgeLevel);
    const a = train('a', T('u', 1), { running: false });
    const b = train('b', T('br', 1), { running: false });
    return [doc([under, br], [a, b]), a, b];
  };
  const [d1, a1, b1] = mk(1);
  expect(carPoses(d1, b1)[0].level).toBe(1);
  checkCollisions(d1);
  expect([a1.crashed, b1.crashed]).toEqual([false, false]);
  const [d0, a0, b0] = mk(0);
  checkCollisions(d0);
  expect([a0.crashed, b0.crashed]).toEqual([true, true]);
});

test('trains on a 90° crossover collide when both are on it', () => {
  const x = P('x', 'crossover-90', 0, 0);
  const a = train('a', T('x', 0.5, 1, 0), { running: false });
  const b = train('b', T('x', 0.5, 1, 1), { running: false });
  const d = doc([x], [a, b]);
  checkCollisions(d);
  expect([a.crashed, b.crashed]).toEqual([true, true]);
});

test('a train longer than its loop never collides with itself', () => {
  const ring: Piece[] = [P('c0', 'curve-m-45', 0, 0)];
  for (let i = 1; i < 8; i++) ring.push(off('c' + i, 'curve-m-45', ring[i - 1], 1));
  const t = train('t', T('c0', 0.1), { cars: MAX_CARS, speed: 2 });
  const d = doc(ring, [t]);
  const sim = new Simulation(d);
  run(sim, 10);
  expect(t.crashed).toBe(false);
  expect(t.currentSpeed).toBeGreaterThan(1);
});

test('a crashed train restarted forward stays crashed; reversed it moves away', () => {
  const { d, a, b } = headOn();
  const sim = new Simulation(d);
  run(sim, 5);
  expect(a.crashed && b.crashed).toBe(true);
  const crashAt = { ...a.crashAt! };
  a.running = true;
  run(sim, 2);
  expect(a.crashed).toBe(true);
  expect(a.currentSpeed).toBe(0);
  expect(a.crashAt).toEqual(crashAt);

  sim.reverse('a');
  a.running = true;
  run(sim, 3);
  expect(a.crashed).toBe(false);
  expect(b.crashed).toBe(false);
  expect(b.crashAt).toBeNull();
  expect(b.running).toBe(false);
  expect(a.currentSpeed).toBeGreaterThan(0.5);
});

test('deleting one crashed train releases the other', () => {
  const { d, a, b } = headOn();
  const sim = new Simulation(d);
  run(sim, 5);
  d.layout.trains = d.layout.trains.filter((t) => t !== a);
  run(sim, 0.1);
  expect(b.crashed).toBe(false);
  expect(b.crashAt).toBeNull();
  expect(b.running).toBe(false);
});

test('turning collisions off releases crashed trains once apart, not while overlapping', () => {
  const { d, a, b } = headOn();
  const sim = new Simulation(d);
  run(sim, 5);
  d.layout.settings.collisions = false;
  run(sim, 0.1);
  expect(a.crashed && b.crashed).toBe(true);
  b.head = T('s4', 1.9); // moved clear
  run(sim, 0.1);
  expect(a.crashed || b.crashed).toBe(false);
});
