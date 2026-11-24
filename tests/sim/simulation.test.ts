import { test, expect } from 'vitest';
import { applyPose } from '../../src/geom/vec';
import { pieceConnectors } from '../../src/track/catalog';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece, type Train, type TrackPos } from '../../src/model/types';
import { occupiedPieces, reverseHead } from '../../src/sim/motion';
import { Simulation, ACCEL, STEP, MAX_DT, HILL_FACTOR } from '../../src/sim/simulation';

const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece =>
  ({ id, type, x, y, rot, level, flipped: false });
const doc = (pieces: Piece[], trains: Train[] = []): Doc => new Doc({ ...emptyLayout(), pieces, trains });
const T = (pieceId: string, dist: number, dir: 1 | -1 = 1, route = 0): TrackPos => ({ pieceId, route, dist, dir });
const train = (id: string, head: TrackPos | null, o: Partial<Train> = {}): Train => ({
  id, cars: 0, color: '#c00', speed: 1, running: true, head, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null, ...o,
});

/** A piece whose connector 0 mates with connector `c` of piece `p` (extends outwards). */
function off(id: string, type: string, p: Piece, c: number): Piece {
  const k = pieceConnectors(p.type, p.flipped)[c];
  const pos = applyPose(p, k.pos);
  return P(id, type, pos.x, pos.y, k.heading + p.rot, p.level);
}

/** Five straight-2 pieces s0..s4 along +x from 0 to 10. */
const longLine = (): Piece[] => [0, 1, 2, 3, 4].map((i) => P('s' + i, 'straight-2', 2 * i, 0));

/** Run `seconds` of simulated time in small steps, calling `each` after every step. */
function run(sim: Simulation, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) { sim.step(STEP); each?.(); }
}

/** a (straight-2, x -2..0) -> auto switch s at 0 -> b, b2 off the straight exit; c, c2 off the branch. */
function switchLayout(mode: 'auto' | 'manual' = 'auto'): Piece[] {
  const a = P('a', 'straight-2', -2, 0);
  const s: Piece = { ...P('s', 'switch', 0, 0), switch: { mode, state: 0 } };
  const b = off('b', 'straight-2', s, 1);
  const b2 = off('b2', 'straight-2', b, 1);
  const c = off('c', 'straight-2', s, 2);
  const c2 = off('c2', 'straight-2', c, 1);
  return [a, s, b, b2, c, c2];
}

test('constants', () => {
  expect([ACCEL, STEP, MAX_DT, HILL_FACTOR]).toEqual([1.5, 1 / 120, 0.25, 0.35]);
});

test('train accelerates at ACCEL up to set speed', () => {
  const t = train('t1', T('s0', 0), { speed: 2 });
  const d = doc(longLine(), [t]);
  const sim = new Simulation(d);
  sim.step(0.25); sim.step(0.25);
  expect(t.currentSpeed).toBeCloseTo(0.75, 6);
  sim.step(0.25); sim.step(0.25); sim.step(0.25); sim.step(0.25);
  expect(t.currentSpeed).toBeCloseTo(2, 9);
  // 4/3 s accelerating (4/3 U) then 1/6 s at 2 U/s: about 5/3 U.
  expect(t.head!.pieceId).toBe('s0');
  expect(t.head!.dist).toBeGreaterThan(1.6);
  expect(t.head!.dist).toBeLessThan(1.7);
});

test('stopped or crashed train decelerates to 0', () => {
  const a = train('a', T('s0', 0), { currentSpeed: 1, running: false });
  const b = train('b', T('s2', 0), { currentSpeed: 1, crashed: true });
  const d = doc(longLine(), [a, b]);
  const sim = new Simulation(d);
  sim.step(0.25);
  expect(a.currentSpeed).toBeCloseTo(1 - ACCEL * 0.25, 9);
  expect(b.currentSpeed).toBeCloseTo(1 - ACCEL * 0.25, 9);
  run(sim, 1);
  expect(a.currentSpeed).toBe(0);
  expect(b.currentSpeed).toBe(0);
});

test('train brakes and stops exactly at a buffer without passing it', () => {
  const s0 = P('s0', 'straight-2', 0, 0);
  const s1 = P('s1', 'straight-2', 2, 0);
  const buf = off('buf', 'buffer', s1, 1);
  const t = train('t1', T('s0', 0.5), { speed: 2, currentSpeed: 2, cars: 1 });
  const d = doc([s0, s1, buf], [t]);
  const sim = new Simulation(d);
  let maxSeen = 0;
  run(sim, 6, () => {
    if (t.head!.pieceId === 'buf') {
      expect(t.head!.dist).toBeLessThanOrEqual(0.5 + 1e-12);
      maxSeen = Math.max(maxSeen, t.head!.dist);
    }
  });
  expect(t.head!.pieceId).toBe('buf');
  expect(t.head!.dist).toBeGreaterThan(0.5 - 0.02);
  expect(t.currentSpeed).toBe(0);
  expect(t.running).toBe(true);
  // It actually braked: never at full speed in the last braking distance.
  expect(maxSeen).toBeLessThanOrEqual(0.5 + 1e-12);
});

test('train at speed brakes before an open end: never passes it, ends at speed 0', () => {
  // Landing exactly on the end with a step size that divides the remaining distance.
  const t = train('t1', T('s3', 0), { speed: 1.5, currentSpeed: 1.5 });
  const d = doc(longLine(), [t]);
  const sim = new Simulation(d);
  let hitFullSpeedAtEnd = false;
  run(sim, 8, () => {
    if (t.head!.pieceId === 's4' && t.head!.dist >= 2 - 1e-9 && t.currentSpeed > 0.5) hitFullSpeedAtEnd = true;
    expect(t.head!.pieceId === 's4' ? t.head!.dist : 0).toBeLessThanOrEqual(2 + 1e-12);
  });
  expect(hitFullSpeedAtEnd).toBe(false);
  expect(t.head!.pieceId).toBe('s4');
  expect(t.head!.dist).toBeGreaterThan(2 - 0.02);
  expect(t.currentSpeed).toBe(0);
});

test('huge dt is clamped: one step(600) moves at most speed·MAX_DT', () => {
  const t = train('t1', T('s0', 0), { speed: 2, currentSpeed: 2 });
  const d = doc(longLine(), [t]);
  new Simulation(d).step(600);
  expect(t.head!.pieceId).toBe('s0');
  expect(t.head!.dist).toBeCloseTo(2 * MAX_DT, 9);
});

test('paused simulation does not move trains', () => {
  const t = train('t1', T('s0', 0), { speed: 2, currentSpeed: 2 });
  const d = doc(longLine(), [t]);
  const sim = new Simulation(d);
  sim.paused = true;
  sim.step(0.25);
  expect(t.head).toEqual(T('s0', 0));
  expect(t.currentSpeed).toBe(2);
});

test('lifted trains are skipped', () => {
  const t = train('t1', null, { speed: 2, currentSpeed: 2 });
  const d = doc(longLine(), [t]);
  new Simulation(d).step(0.25);
  expect(t.head).toBeNull();
});

test('auto switch flips only after the tail clears', () => {
  const t = train('t1', T('a', 1.95), { cars: 1, currentSpeed: 1 });
  const d = doc(switchLayout(), [t]);
  const sim = new Simulation(d);
  const sw = d.piece('s')!;
  let wasOn = false;
  let flipped = false;
  run(sim, 5, () => {
    const on = occupiedPieces(d, t).has('s');
    if (on) { wasOn = true; expect(sw.switch!.state).toBe(0); }
    if (wasOn && !on) flipped = true;
  });
  expect(wasOn).toBe(true);
  expect(flipped).toBe(true);
  expect(t.head!.pieceId.startsWith('b')).toBe(true);
  expect(sw.switch!.state).toBe(1);
});

test('manual switch does not flip', () => {
  const t = train('t1', T('a', 1.95), { cars: 1, currentSpeed: 1 });
  const d = doc(switchLayout('manual'), [t]);
  run(new Simulation(d), 5);
  expect(t.head!.pieceId.startsWith('b')).toBe(true);
  expect(d.piece('s')!.switch!.state).toBe(0);
});

test('auto switch waits while a second train occupies it', () => {
  const t = train('t1', T('a', 1.95), { cars: 1, currentSpeed: 1 });
  // Parked on the branch, its head just past the switch.
  const t2 = train('t2', T('c', 0.2), { running: false });
  const d = doc(switchLayout(), [t, t2]);
  expect(occupiedPieces(d, t2).has('s')).toBe(true);
  const sim = new Simulation(d);
  run(sim, 5);
  expect(occupiedPieces(d, t).has('s')).toBe(false);
  expect(d.piece('s')!.switch!.state).toBe(0);
  t2.head = T('c2', 1); // moved clear
  sim.step(STEP);
  expect(d.piece('s')!.switch!.state).toBe(1);
});

test('pending flip is dropped when its train is lifted', () => {
  const t = train('t1', T('a', 1.95), { cars: 1, currentSpeed: 1 });
  const d = doc(switchLayout(), [t]);
  const sim = new Simulation(d);
  run(sim, 0.5);
  expect(occupiedPieces(d, t).has('s')).toBe(true);
  t.head = null;
  run(sim, 0.5);
  expect(d.piece('s')!.switch!.state).toBe(0);
});

test('forget drops a pending flip', () => {
  const t = train('t1', T('a', 1.95), { cars: 1, currentSpeed: 1 });
  const d = doc(switchLayout(), [t]);
  const sim = new Simulation(d);
  run(sim, 0.5);
  expect(occupiedPieces(d, t).has('s')).toBe(true);
  sim.forget('t1');
  run(sim, 4);
  expect(occupiedPieces(d, t).has('s')).toBe(false);
  expect(d.piece('s')!.switch!.state).toBe(0);
});

test('trailing entry aligns the switch, unless another train occupies it', () => {
  // t1 comes back along the branch c towards the switch.
  for (const blocked of [false, true]) {
    const t = train('t1', T('c', 1, -1), { currentSpeed: 1 });
    const trains = [t];
    // t2 parked straddling the switch entry.
    if (blocked) trains.push(train('t2', T('s', 0.3), { running: false }));
    const d = doc(switchLayout('manual'), trains);
    if (blocked) expect(occupiedPieces(d, trains[1]).has('s')).toBe(true);
    const sim = new Simulation(d);
    let reached = false;
    run(sim, 2, () => { if (t.head!.pieceId === 's') { reached = true; expect(t.head!.route).toBe(1); } });
    expect(reached).toBe(true);
    expect(d.piece('s')!.switch!.state).toBe(blocked ? 0 : 1);
  }
});

test('toggleSwitch refused while occupied', () => {
  const t = train('t1', T('s', 0.5), { running: false });
  const d = doc(switchLayout('manual'), [t]);
  const sim = new Simulation(d);
  expect(sim.canToggle('s')).toBe(false);
  expect(sim.toggleSwitch('s')).toBe(false);
  expect(d.piece('s')!.switch!.state).toBe(0);
  expect(sim.canToggle('a')).toBe(false); // not a switch
  t.head = T('b2', 1);
  expect(sim.canToggle('s')).toBe(true);
  expect(sim.toggleSwitch('s')).toBe(true);
  expect(d.piece('s')!.switch!.state).toBe(1);
  expect(sim.toggleSwitch('s')).toBe(true);
  expect(d.piece('s')!.switch!.state).toBe(0);
});

/** l0, l1 (level 0) -> ramp r at x 0..2 -> u0, u1 (level 1). */
function rampLayout(): Piece[] {
  return [
    P('l0', 'straight-2', -4, 0), P('l1', 'straight-2', -2, 0),
    P('r', 'ramp-2', 0, 0),
    P('u0', 'straight-2', 2, 0, 0, 1), P('u1', 'straight-2', 4, 0, 0, 1),
  ];
}

/** Steady speed while the head is well inside the ramp. */
function rampSpeed(hill: boolean, up: boolean): number {
  const t = train('t1', up ? T('l1', 0) : T('u0', 2, -1), { currentSpeed: 1 });
  const d = doc(rampLayout(), [t]);
  expect(d.graph.joins.size).toBe(8);
  d.layout.settings.hillEffect = hill;
  const sim = new Simulation(d);
  let speed = NaN;
  run(sim, 6, () => {
    const h = t.head!;
    if (h.pieceId === 'r' && (up ? h.dist > 1.6 : h.dist < 0.4) && Number.isNaN(speed)) speed = t.currentSpeed;
  });
  return speed;
}

test('hill effect: uphill slower, downhill faster, never zero; off = no change', () => {
  expect(rampSpeed(true, true)).toBeCloseTo(1 - HILL_FACTOR, 6);
  expect(rampSpeed(true, false)).toBeCloseTo(1 + HILL_FACTOR, 6);
  expect(rampSpeed(false, true)).toBeCloseTo(1, 9);
  expect(rampSpeed(false, false)).toBeCloseTo(1, 9);
});

test('hill effect: back to set speed on level track', () => {
  const t = train('t1', T('l1', 0), { currentSpeed: 1 });
  const d = doc(rampLayout(), [t]);
  d.layout.settings.hillEffect = true;
  const sim = new Simulation(d);
  run(sim, 7.5);
  expect(t.head!.pieceId).toBe('u1');
  expect(t.currentSpeed).toBeCloseTo(1, 9);
});

test('reverse swaps head to tail and clears crash', () => {
  const t = train('t1', T('s1', 1), { cars: 2, currentSpeed: 1, crashed: true, crashAt: { x: 3, y: 0 } });
  const d = doc(longLine(), [t]);
  const expected = reverseHead(d, t);
  const sim = new Simulation(d);
  sim.reverse('t1');
  expect(t.head).toEqual(expected);
  expect(t.head!.dir).toBe(-1);
  expect(t.currentSpeed).toBe(0);
  expect(t.crashed).toBe(false);
  expect(t.crashAt).toBeNull();
  // Then it runs the other way.
  const before = t.head!.dist;
  sim.step(0.25);
  expect(t.head!.pieceId === 's0' || t.head!.dist < before).toBe(true);
});
