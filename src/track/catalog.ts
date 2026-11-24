import { type Vec2, normDeg } from '../geom/vec';
import { type RoutePath, type PathStep, makePath, samplePath, pathEnd, mirrorPath } from '../geom/path';

/** Medium radius: a 45° medium curve advances exactly 1U forward. */
export const R_M = Math.SQRT2;
/** Parallel-track spacing (and the difference between neighbouring radii). */
export const D = 2 * (Math.SQRT2 - 1);
export const R_S = R_M - D;
export const R_L = R_M + D;

export type Family = 'straight' | 'curve' | 'switch' | 'crossover' | 'ramp' | 'bridge' | 'tunnel' | 'buffer';

export interface ConnectorDef { pos: Vec2; heading: number; levelOffset: 0 | 1; gender: 'm' | 'f' }
export interface RouteDef { from: number; to: number | null; path: RoutePath }
export interface PieceDef {
  type: string; family: Family; label: string;
  connectors: ConnectorDef[]; routes: RouteDef[];
  switch?: { entry: number; routes: [number, number] };
  /** One simple (possibly non-convex) polygon per route: the 0.5U-wide track band around it. */
  footprint: Vec2[][]; flippable: boolean;
  ramp?: true; bridge?: true; tunnel?: true;
}

const HALF_BAND = 0.25;
const ORIGIN: Vec2 = { x: 0, y: 0 };

interface RouteSpec { from: number; to: number | null; start: Vec2; heading: number; steps: PathStep[] }

/**
 * Build a piece from its routes. Connector poses are derived from the path ends so they
 * cannot drift: a route's `from` connector gets the reversed start heading, its `to`
 * connector the end heading. Gender: a connector that starts a route is female, others male
 * (drawn only, never enforced).
 */
function piece(
  type: string, family: Family, label: string, specs: RouteSpec[],
  extra: Partial<Pick<PieceDef, 'switch' | 'flippable' | 'ramp' | 'bridge' | 'tunnel'>> & { levelOffsets?: (0 | 1)[] } = {},
): PieceDef {
  const connectors: ConnectorDef[] = [];
  const routes: RouteDef[] = specs.map((s) => {
    const path = makePath(s.start, s.heading, s.steps);
    const a = samplePath(path, 0);
    connectors[s.from] = { pos: a.pos, heading: normDeg(a.heading + 180), levelOffset: 0, gender: 'f' };
    if (s.to !== null) {
      const e = pathEnd(path);
      connectors[s.to] = { pos: e.pos, heading: normDeg(e.heading), levelOffset: 0, gender: 'm' };
    }
    return { from: s.from, to: s.to, path };
  });
  extra.levelOffsets?.forEach((l, i) => { connectors[i].levelOffset = l; });
  const def: PieceDef = {
    type, family, label, connectors, routes,
    footprint: routes.map((r) => bandPolygon(r.path)),
    flippable: extra.flippable ?? false,
  };
  if (extra.switch) def.switch = extra.switch;
  if (extra.ramp) def.ramp = true;
  if (extra.bridge) def.bridge = true;
  if (extra.tunnel) def.tunnel = true;
  return def;
}

const MAX_STEP_U = 1 / 16;
const MAX_STEP_DEG = 5;

/** Total absolute heading change along a path, in degrees. */
const turnOf = (p: RoutePath): number =>
  p.segments.reduce((t, s) => t + (s.kind === 'arc' ? Math.abs(s.sweep) : 0), 0);

/**
 * The track band around one route: outer-edge samples at +HALF_BAND (right of travel), then
 * the inner-edge samples at -HALF_BAND in reverse. Sampled every <=1/16U and <=5° of turn.
 */
function bandPolygon(p: RoutePath): Vec2[] {
  const n = Math.max(1, Math.ceil(p.length / MAX_STEP_U), Math.ceil(turnOf(p) / MAX_STEP_DEG));
  const right: Vec2[] = [], left: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const s = samplePath(p, (p.length * i) / n);
    const h = (s.heading * Math.PI) / 180;
    const nx = -Math.sin(h) * HALF_BAND, ny = Math.cos(h) * HALF_BAND;
    right.push({ x: s.pos.x + nx, y: s.pos.y + ny });
    left.push({ x: s.pos.x - nx, y: s.pos.y - ny });
  }
  return [...right, ...left.reverse()];
}

const line = (len: number, from = 0, to: number | null = 1): RouteSpec =>
  ({ from, to, start: ORIGIN, heading: 0, steps: [{ line: len }] });
const arc = (radius: number, sweep: number, to = 1): RouteSpec =>
  ({ from: 0, to, start: ORIGIN, heading: 0, steps: [{ arc: { radius, sweep } }] });
/** A straight route of `len` crossing route 0 (a line of `len` from the origin) at its midpoint at `angle`. */
const crossing = (len: number, angle: number): RouteSpec => {
  const h = (angle * Math.PI) / 180;
  return {
    from: 2, to: 3, heading: angle, steps: [{ line: len }],
    start: { x: len / 2 - (len / 2) * Math.cos(h), y: -(len / 2) * Math.sin(h) },
  };
};

const defs: PieceDef[] = [
  piece('straight-1-4', 'straight', 'Straight ¼', [line(0.25)]),
  piece('straight-1-2', 'straight', 'Straight ½', [line(0.5)]),
  piece('straight-1', 'straight', 'Straight 1', [line(1)]),
  piece('straight-2', 'straight', 'Straight 2', [line(2)]),
  piece('straight-d1-2', 'straight', 'Diagonal ½', [line(Math.SQRT2 / 2)]),
  piece('straight-d1', 'straight', 'Diagonal 1', [line(Math.SQRT2)]),
  piece('curve-s-45', 'curve', 'Curve small 45°', [arc(R_S, 45)], { flippable: true }),
  piece('curve-m-45', 'curve', 'Curve medium 45°', [arc(R_M, 45)], { flippable: true }),
  piece('curve-l-45', 'curve', 'Curve large 45°', [arc(R_L, 45)], { flippable: true }),
  piece('curve-l-22', 'curve', 'Curve large 22.5°', [arc(R_L, 22.5)], { flippable: true }),
  piece('switch', 'switch', 'Switch', [line(1), arc(R_M, 45, 2)],
    { switch: { entry: 0, routes: [0, 1] }, flippable: true }),
  piece('switch-y', 'switch', 'Y switch', [arc(R_M, -45, 1), arc(R_M, 45, 2)],
    { switch: { entry: 0, routes: [0, 1] } }),
  piece('crossover-90', 'crossover', 'Crossing 90°', [line(Math.SQRT2), crossing(Math.SQRT2, 90)]),
  piece('crossover-45', 'crossover', 'Crossing 45°', [line(1), crossing(1, 45)]),
  piece('ramp-2', 'ramp', 'Ramp', [line(2)], { ramp: true, levelOffsets: [0, 1] }),
  piece('bridge-1', 'bridge', 'Bridge 1', [line(1)], { bridge: true }),
  piece('bridge-2', 'bridge', 'Bridge 2', [line(2)], { bridge: true }),
  piece('tunnel-1', 'tunnel', 'Tunnel 1', [line(1)], { tunnel: true }),
  piece('tunnel-2', 'tunnel', 'Tunnel 2', [line(2)], { tunnel: true }),
  piece('tunnel-m-45', 'tunnel', 'Tunnel curve 45°', [arc(R_M, 45)], { tunnel: true, flippable: true }),
  piece('buffer', 'buffer', 'Buffer stop', [line(0.5, 0, null)]),
];

export const PALETTE_ORDER: string[] = defs.map((d) => d.type);
export const CATALOG: Readonly<Record<string, PieceDef>> = Object.freeze(
  Object.fromEntries(defs.map((d) => [d.type, d])),
);

export function getPieceDef(type: string): PieceDef {
  const def = Object.prototype.hasOwnProperty.call(CATALOG, type) ? CATALOG[type] : undefined;
  if (!def) throw new Error('Unknown piece type: ' + type);
  return def;
}

/** Connectors in local coordinates; flipped mirrors across the x-axis (y and heading negated). */
export function pieceConnectors(type: string, flipped: boolean): ConnectorDef[] {
  return getPieceDef(type).connectors.map((c) => ({
    ...c,
    pos: flipped ? { x: c.pos.x, y: -c.pos.y } : { ...c.pos },
    heading: flipped ? normDeg(-c.heading) : c.heading,
  }));
}

/** Routes in local coordinates; flipped mirrors each path with `mirrorPath`. */
export function pieceRoutes(type: string, flipped: boolean): RouteDef[] {
  return getPieceDef(type).routes.map((r) => ({ ...r, path: flipped ? mirrorPath(r.path) : r.path }));
}

/** Footprint band polygons in local coordinates; flipped mirrors y (and reverses winding). */
export function pieceFootprint(type: string, flipped: boolean): Vec2[][] {
  return getPieceDef(type).footprint.map((poly) =>
    flipped ? poly.map((v) => ({ x: v.x, y: -v.y })).reverse() : poly.map((v) => ({ ...v })));
}
