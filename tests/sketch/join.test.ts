import { test, expect } from 'vitest';
import { type Pose, dist, angleDiff } from '../../src/geom/vec';
import { D, validFlex } from '../../src/track/catalog';
import { JOIN_POS_TOL, JOIN_ANGLE_TOL, buildGraph } from '../../src/track/graph';
import { type PieceSpec, attachSpec, outPose, chainEnd, specToPiece } from '../../src/sketch/spec';
import { solveJoin, JOIN_MAX_PIECES } from '../../src/sketch/join';

const closesOn = (chain: PieceSpec[], to: Pose) => {
  const e = chainEnd(chain);
  expect(dist(e, to)).toBeLessThan(JOIN_POS_TOL); expect(angleDiff(e.rot, to.rot + 180)).toBeLessThan(JOIN_ANGLE_TOL);
  for (const s of chain) if (s.flex) expect(validFlex(s.type, s.flex)).toBe(true);
};

/** Each piece's connector 0 must mate with the previous piece's connector 1 (or the start pose). */
const chainsFrom = (chain: PieceSpec[], from: Pose) => {
  let at = from;
  for (const s of chain) {
    const c0 = outPose(s, 0);
    expect(dist(c0, at)).toBeLessThan(1e-9); expect(angleDiff(c0.rot, at.rot + 180)).toBeLessThan(1e-9);
    at = outPose(s, 1);
  }
};

test('attachSpec mates connector `enter` with the outward pose and sets rot = at.rot + 180 - heading', () => {
  const at = { x: 3, y: -1, rot: 30 };
  const s = attachSpec('curve-m-45', true, undefined, at, 2);
  expect(s.level).toBe(2); expect(s.flipped).toBe(true); expect(s.rot).toBeCloseTo(30);
  const c0 = outPose(s, 0);
  expect(dist(c0, at)).toBeLessThan(1e-9); expect(angleDiff(c0.rot, 210)).toBeLessThan(1e-9);
  // flipped medium curve turns left: exit heading 30 - 45
  expect(angleDiff(outPose(s, 1).rot, -15)).toBeLessThan(1e-9);
  const back = attachSpec('straight-1', false, undefined, at, 0, 1);
  expect(dist(outPose(back, 1), at)).toBeLessThan(1e-9); expect(angleDiff(outPose(back, 0).rot, 30)).toBeLessThan(1e-9);
});

test('specToPiece adds the id; chainEnd is the last spec exit pose; flex parameters are used', () => {
  const a = attachSpec('flex-straight', false, { length: 0.3 }, { x: 0, y: 0, rot: 0 }, 0);
  const b = attachSpec('straight-1', false, undefined, outPose(a, 1), 0);
  const e = chainEnd([a, b]);
  expect(e.x).toBeCloseTo(1.3); expect(e.y).toBeCloseTo(0); expect(angleDiff(e.rot, 0)).toBeLessThan(1e-9);
  expect(angleDiff(chainEnd([a, b], 0).rot, 180)).toBeLessThan(1e-9);
  const p = specToPiece(a, 'p1');
  expect(p).toEqual({ ...a, id: 'p1' });
  expect(p.flex).toEqual({ length: 0.3 });
  expect(p.flex).not.toBe(a.flex);
});

test('1.3 straight ahead → straight-1 + flex 0.3', () => {
  const c = solveJoin({ x: 0, y: 0, rot: 0 }, { x: 1.3, y: 0, rot: 180 }, 0)!;
  expect(c.map((s) => s.type)).toEqual(['straight-1', 'flex-straight']); closesOn(c, { x: 1.3, y: 0, rot: 180 });
  expect((c[1].flex as { length: number }).length).toBeCloseTo(0.3);
});

test('exact catalogue length straight ahead uses only catalogue straights', () => {
  const to = { x: 3.75, y: 0, rot: 180 };
  const c = solveJoin({ x: 0, y: 0, rot: 0 }, to, 1)!;
  expect(c.map((s) => s.type)).toEqual(['straight-2', 'straight-1', 'straight-1-2', 'straight-1-4']);
  expect(c.every((s) => s.level === 1)).toBe(true);
  closesOn(c, to);
});

test('2U ahead, D sideways, same heading → S-bend that closes', () => {
  const to = { x: 2, y: D, rot: 180 }; closesOn(solveJoin({ x: 0, y: 0, rot: 0 }, to, 0)!, to);
});

test('S-bend to the left also closes, using flipped curves', () => {
  const from = { x: 0, y: 0, rot: 0 }, to = { x: 2, y: -D, rot: 180 };
  const c = solveJoin(from, to, 0)!;
  closesOn(c, to); chainsFrom(c, from);
  expect(c[0].type).toBe('flex-curve'); expect(c[0].flipped).toBe(true);
});

test('U-turn radius 1 → several flex curves each ≤ 45°', () => {
  const to = { x: 0, y: 2, rot: 0 }; const c = solveJoin({ x: 0, y: 0, rot: 0 }, to, 0)!;
  expect(c.length).toBeGreaterThanOrEqual(4); closesOn(c, to);
  expect(c.every((s) => s.type === 'flex-curve')).toBe(true);
});

test('a joined chain is recognised by the track graph (connectors mate within v1 tolerances)', () => {
  const from = { x: 1, y: 1, rot: 22.5 };
  const target = attachSpec('curve-m-45', false, undefined, { x: 4, y: 3, rot: 20 }, 0);
  const c = solveJoin(from, outPose(target, 0), 0)!;
  const pieces = [...c, target].map((s, i) => specToPiece(s, 'p' + i));
  const g = buildGraph(pieces);
  const open = g.open.map((o) => o.pieceId + ':' + o.index).sort();
  expect(open).toEqual(['p0:0', 'p' + c.length + ':1']);
  expect(g.nearMisses).toEqual([]);
});

test('near misses over a longer stretch close: tiny sideways offsets and small angle errors', () => {
  // A bare biarc would need radii far beyond 8U here; flex straights either side of it make room.
  for (const to of [{ x: 3, y: 0.02, rot: 180 }, { x: 1, y: -0.03, rot: 180 }, { x: 2, y: 0, rot: 181.5 }]) {
    const from = { x: 0, y: 0, rot: 0 };
    const c = solveJoin(from, to, 0);
    expect(c, JSON.stringify(to)).not.toBeNull();
    closesOn(c!, to); chainsFrom(c!, from);
  }
});

test('a gentle turn with offset is a single flex curve plus a flex straight', () => {
  const to = { x: 3, y: 1, rot: 210 };
  const c = solveJoin({ x: 0, y: 0, rot: 0 }, to, 0)!;
  expect(c.map((s) => s.type)).toEqual(['flex-curve', 'flex-straight']);
  closesOn(c, to);
});

test('0.02 sideways with 0.1 forward is impossible → null', () => {
  expect(solveJoin({ x: 0, y: 0, rot: 0 }, { x: 0.1, y: 0.02, rot: 180 }, 0)).toBeNull();
});

test('a target behind the start that needs a tight loop is null rather than a bad join', () => {
  expect(solveJoin({ x: 0, y: 0, rot: 0 }, { x: -0.2, y: 0, rot: 0 }, 0)).toBeNull();
});

/** mulberry32: small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random feasible targets always close exactly when solved', () => {
  const r = rng(12345);
  let solved = 0;
  for (let i = 0; i < 200; i++) {
    const from = { x: r() * 10 - 5, y: r() * 10 - 5, rot: r() * 360 - 180 };
    const d = 2 + r() * 4, a = r() * 2 * Math.PI;
    const to = { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a), rot: r() * 360 - 180 };
    const c = solveJoin(from, to, 0);
    if (!c) continue;
    solved++;
    expect(c.length).toBeLessThanOrEqual(JOIN_MAX_PIECES);
    closesOn(c, to); chainsFrom(c, from);
  }
  expect(solved).toBeGreaterThan(SOLVED_FLOOR);
});
const SOLVED_FLOOR = 140; // 160 of these 200 are solved today; the rest need loops or tighter turns

test('gentle bends of every sort within reach are solved', () => {
  // Targets reachable by a pair of R_M-ish arcs: offsets up to 1.5U sideways over 3U, heading change ±45°.
  for (const lat of [-1.5, -0.5, 0.3, 1]) for (const dh of [-45, 0, 30]) {
    const to = { x: 3, y: lat, rot: 180 + dh };
    const c = solveJoin({ x: 0, y: 0, rot: 0 }, to, 0);
    expect(c, `lat ${lat} dh ${dh}`).not.toBeNull();
    closesOn(c!, to);
  }
});
