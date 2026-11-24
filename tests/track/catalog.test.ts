import { test, expect } from 'vitest';
import { type Pose, dist, angleDiff, normDeg, applyPose } from '../../src/geom/vec';
import { pathEnd, samplePath } from '../../src/geom/path';
import {
  CATALOG, PALETTE_ORDER, D, R_M, R_S, R_L, getPieceDef, pieceConnectors, pieceRoutes, pieceFootprint,
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
/** Ray-casting point-in-polygon (works for non-convex simple polygons). */
const inPoly = (poly: { x: number; y: number }[], p: { x: number; y: number }) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const offset = (r: { path: Parameters<typeof samplePath>[0] }, d: number, k: number) => {
  const s = samplePath(r.path, d), h = (s.heading * Math.PI) / 180;
  return { x: s.pos.x - Math.sin(h) * k, y: s.pos.y + Math.cos(h) * k };
};
test('footprint is one 0.5U band polygon per route', () => {
  for (const type of Object.keys(CATALOG)) {
    for (const flipped of [false, true]) {
      const fp = pieceFootprint(type, flipped), routes = pieceRoutes(type, flipped);
      expect(fp).toHaveLength(routes.length);
      routes.forEach((r, ri) => {
        for (let i = 0; i < 10; i++) {
          const d = (r.path.length * (i + 0.5)) / 10;
          for (const k of [-0.24, 0, 0.24]) expect(inPoly(fp[ri], offset(r, d, k))).toBe(true);
          for (const k of [-0.3, 0.3]) expect(inPoly(fp[ri], offset(r, d, k))).toBe(false);
        }
        const s0 = samplePath(r.path, 0), h0 = (s0.heading * Math.PI) / 180;
        const behind = { x: s0.pos.x - Math.cos(h0) * 0.05, y: s0.pos.y - Math.sin(h0) * 0.05 };
        expect(inPoly(fp[ri], behind)).toBe(false); // nothing beyond the start
      });
    }
  }
  expect(pieceFootprint('curve-m-45', false)).toEqual(getPieceDef('curve-m-45').footprint);
});
test('footprint does not fill the wedge between branches or the gaps between crossover arms', () => {
  const outsideAll = (type: string, p: { x: number; y: number }) =>
    getPieceDef(type).footprint.every((poly) => !inPoly(poly, p));
  expect(outsideAll('switch-y', { x: 0.95, y: 0 })).toBe(true);
  expect(outsideAll('crossover-90', { x: 0.15, y: 0.35 })).toBe(true);
  expect(outsideAll('switch', { x: 1.1, y: 0.1 })).toBe(true);
});
test('flipped switch branches left', () => {
  expect(pieceConnectors('switch', true)[2].pos.y).toBeLessThan(0);
  expect(pieceConnectors('switch', true)[2].heading).toBeCloseTo(-45);
});
test('crossover routes intersect at their midpoints', () => {
  for (const [type, angle] of [['crossover-90', 90], ['crossover-45', 45]] as const) {
    const [r0, r1] = getPieceDef(type).routes;
    const a = samplePath(r0.path, r0.path.length / 2), b = samplePath(r1.path, r1.path.length / 2);
    expect(dist(a.pos, b.pos)).toBeLessThan(1e-12);
    expect(angleDiff(b.heading - a.heading, angle)).toBeLessThan(1e-9);
  }
});
