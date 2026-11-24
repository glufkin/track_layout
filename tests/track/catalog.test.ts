import { test, expect } from 'vitest';
import { type Pose, dist, angleDiff, normDeg, applyPose } from '../../src/geom/vec';
import { pathEnd, samplePath } from '../../src/geom/path';
import {
  CATALOG, PALETTE_ORDER, D, R_M, R_S, R_L, getPieceDef, pieceConnectors, pieceRoutes,
} from '../../src/track/catalog';
import { chain } from '../helpers/chain';

const closes = (end: Pose, start: Pose) => {
  expect(dist(end, start)).toBeLessThan(1e-9);
  expect(angleDiff(end.rot, start.rot + 180)).toBeLessThan(1e-9);
};
const O = { x: 0, y: 0, rot: 180 }; // outward heading of a virtual connector at the origin

test('8 medium curves make a circle', () => closes(chain(O, Array(8).fill({ type: 'curve-m-45' })), O));
test('each radius closes in 8 (or 16 for 22.5°)', () => {
  for (const t of ['curve-s-45', 'curve-l-45']) closes(chain(O, Array(8).fill({ type: t })), O);
  closes(chain(O, Array(16).fill({ type: 'curve-l-22' })), O);
});
test('oval: 4 curves, 2 straight-2, 4 curves, 2 straight-2', () => {
  const c = { type: 'curve-m-45' }, s = { type: 'straight-2' };
  closes(chain(O, [s, s, c, c, c, c, s, s, c, c, c, c]), O);
});
test('concentric medium and large curves are D apart', () => {
  const inner = chain(O, Array(4).fill({ type: 'curve-m-45' }));
  const outer = chain({ x: 0, y: -D, rot: 180 }, Array(4).fill({ type: 'curve-l-45' }));
  expect(dist(inner, outer)).toBeCloseTo(D);
});
test('passing loop closes: switch + reverse curve vs main straights', () => {
  const branch = chain(O, [{ type: 'switch', exit: 2 }, { type: 'curve-m-45', flipped: true }]);
  const main = chain(O, [{ type: 'switch', exit: 1 }, { type: 'straight-1' }]);
  expect(branch.x).toBeCloseTo(main.x); expect(branch.y - main.y).toBeCloseTo(D); expect(normDeg(branch.rot)).toBeCloseTo(normDeg(main.rot));
});
test('figure-eight: crossover-90 at 45°, two lobes of diag-half + 6 curves + diag-half', () => {
  const lobe = [{ type: 'straight-d1-2' }, ...Array(6).fill({ type: 'curve-m-45', flipped: true }), { type: 'straight-d1-2' }];
  const xo = getPieceDef('crossover-90');
  expect(xo.connectors).toHaveLength(4);
  expect(lobe).toHaveLength(8);
  const at: Pose = { x: 3, y: -1, rot: 45 };
  const arm = (i: number): Pose => {
    const p = applyPose(at, xo.connectors[i].pos);
    return { x: p.x, y: p.y, rot: at.rot + xo.connectors[i].heading };
  };
  // chain's start is the first lobe piece's own entering connector: it mates with the arm
  const mate = (p: Pose): Pose => ({ ...p, rot: p.rot + 180 });
  closes(chain(mate(arm(1)), lobe), arm(2)); // leaves route 0's far arm, returns into route 1's start
  closes(chain(mate(arm(0)), lobe), arm(3)); // leaves route 0's start, returns into route 1's far arm
});
test('raised oval: ramp up and ramp down on one side match 2×straight-2 on the other', () => {
  const c = { type: 'curve-m-45' };
  closes(chain(O, [{ type: 'straight-2' }, { type: 'straight-2' }, c, c, c, c, { type: 'ramp-2' }, { type: 'ramp-2', enter: 1, exit: 0 }, c, c, c, c]), O);
});
test('unknown type throws', () => expect(() => getPieceDef('nope')).toThrow('Unknown piece type: nope'));
test('switch branch path equals curve-m-45 path', () => {
  expect(pathEnd(getPieceDef('switch').routes[1].path)).toEqual(pathEnd(getPieceDef('curve-m-45').routes[0].path));
});

test('radii constants', () => {
  expect(R_M).toBe(Math.SQRT2);
  expect(D).toBeCloseTo(0.828427, 6);
  expect(R_S).toBeCloseTo(R_M - D); expect(R_L).toBeCloseTo(R_M + D);
});
test('every palette entry is in the catalogue and vice versa', () => {
  expect([...PALETTE_ORDER].sort()).toEqual(Object.keys(CATALOG).sort());
});
test('connectors sit at their route ends with matching headings', () => {
  for (const def of Object.values(CATALOG)) {
    expect(def.connectors[0].pos).toEqual({ x: 0, y: 0 });
    expect(def.connectors[0].heading).toBe(180);
    for (const r of def.routes) {
      const s = samplePath(r.path, 0), e = pathEnd(r.path);
      const from = def.connectors[r.from];
      expect(dist(from.pos, s.pos)).toBeLessThan(1e-12);
      expect(angleDiff(from.heading, s.heading + 180)).toBeLessThan(1e-9);
      if (r.to !== null) {
        const to = def.connectors[r.to];
        expect(dist(to.pos, e.pos)).toBeLessThan(1e-12);
        expect(angleDiff(to.heading, e.heading)).toBeLessThan(1e-9);
      }
    }
  }
});
test('diagonal straights span one (or half a) grid cell at 45°', () => {
  const one = chain({ x: 0, y: 0, rot: 225 }, [{ type: 'straight-d1' }]);
  expect(one.x).toBeCloseTo(1); expect(one.y).toBeCloseTo(1);
  const half = chain({ x: 0, y: 0, rot: 225 }, [{ type: 'straight-d1-2' }]);
  expect(half.x).toBeCloseTo(0.5); expect(half.y).toBeCloseTo(0.5);
});
test('a 45° medium curve advances exactly 1U', () => {
  expect(pathEnd(getPieceDef('curve-m-45').routes[0].path).pos.x).toBeCloseTo(1, 12);
});
test('flipped curve turns left: mirrored connectors and routes', () => {
  const c = pieceConnectors('curve-m-45', true)[1];
  expect(c.pos.y).toBeLessThan(0); expect(c.heading).toBeCloseTo(-45);
  const e = pathEnd(pieceRoutes('curve-m-45', true)[0].path);
  expect(e.pos.y).toBeCloseTo(c.pos.y); expect(normDeg(e.heading)).toBeCloseTo(-45);
  // unflipped copies are not shared with the catalogue
  expect(pieceConnectors('curve-m-45', false)).not.toBe(getPieceDef('curve-m-45').connectors);
});
test('switch-y branches left and right', () => {
  const [, l, r] = getPieceDef('switch-y').connectors;
  expect(l.pos.y).toBeLessThan(0); expect(r.pos.y).toBeGreaterThan(0);
  expect(getPieceDef('switch-y').switch).toEqual({ entry: 0, routes: [0, 1] });
});
test('flags: ramp level offset, bridges, tunnels, buffer dead end', () => {
  const ramp = getPieceDef('ramp-2');
  expect(ramp.ramp).toBe(true); expect(ramp.connectors.map((c) => c.levelOffset)).toEqual([0, 1]);
  expect(getPieceDef('bridge-2').bridge).toBe(true);
  for (const t of ['tunnel-1', 'tunnel-2', 'tunnel-m-45']) expect(getPieceDef(t).tunnel).toBe(true);
  const buf = getPieceDef('buffer');
  expect(buf.connectors).toHaveLength(1);
  expect(buf.routes).toEqual([expect.objectContaining({ from: 0, to: null })]);
  expect(buf.routes[0].path.length).toBe(0.5);
});
test('footprint contains every route sample and the 0.25U band around it', () => {
  const inside = (poly: { x: number; y: number }[], p: { x: number; y: number }) => {
    // convex polygon test: point on the same side of every edge
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(cr) < 1e-9) continue;
      if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
    }
    return true;
  };
  for (const def of Object.values(CATALOG)) {
    expect(def.footprint.length).toBeGreaterThanOrEqual(4);
    for (const r of def.routes) {
      for (let i = 0; i <= 10; i++) {
        const s = samplePath(r.path, (r.path.length * i) / 10);
        const n = { x: -Math.sin((s.heading * Math.PI) / 180), y: Math.cos((s.heading * Math.PI) / 180) };
        for (const k of [-0.24, 0, 0.24]) expect(inside(def.footprint, { x: s.pos.x + n.x * k, y: s.pos.y + n.y * k })).toBe(true);
      }
    }
    expect(inside(def.footprint, { x: 0, y: 0.4 })).toBe(false);
  }
});
