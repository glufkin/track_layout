import { type Vec2, applyPose, dist, angleDiff, normDeg } from '../geom/vec';
import { type RoutePath, transformPath, samplePath } from '../geom/path';
import { pieceGeometry } from './catalog';
import type { Piece } from '../model/types';

export interface WorldConnector { pieceId: string; index: number; pos: Vec2; heading: number; level: number }
export interface TrackGraph {
  joins: Map<string, WorldConnector>;
  open: WorldConnector[];
  nearMisses: Array<[WorldConnector, WorldConnector]>;
  overlaps: Array<[string, string]>;
}

export const JOIN_POS_TOL = 0.01;
export const JOIN_ANGLE_TOL = 1;
export const NEAR_POS_TOL = 0.25;
export const NEAR_ANGLE_TOL = 15;

const CELL = 1;
const EPS = 1e-9;

export const connKey = (pieceId: string, index: number): string => pieceId + ':' + index;

export function worldConnectors(p: Piece): WorldConnector[] {
  return pieceGeometry(p).connectors.map((c, index) => ({
    pieceId: p.id, index,
    pos: applyPose(p, c.pos),
    heading: normDeg(c.heading + p.rot),
    level: p.level + c.levelOffset,
  }));
}

export function worldRoutePath(p: Omit<Piece, 'id'>, route: number): RoutePath {
  return transformPath(pieceGeometry(p).routes[route].path, p);
}

/** One band polygon per route, in world coordinates. */
export function worldFootprint(p: Piece): Vec2[][] {
  return pieceGeometry(p).footprint.map((poly) => poly.map((v) => applyPose(p, v)));
}

const cellKey = (cx: number, cy: number): string => cx + ',' + cy;
const cellOf = (v: number): number => Math.floor(v / CELL);

interface Cand { a: WorldConnector; b: WorldConnector; d: number; ka: string; kb: string }

function connectorPairs(conns: WorldConnector[]): Cand[] {
  const grid = new Map<string, WorldConnector[]>();
  for (const c of conns) {
    const k = cellKey(cellOf(c.pos.x), cellOf(c.pos.y));
    const list = grid.get(k);
    if (list) list.push(c); else grid.set(k, [c]);
  }
  const out: Cand[] = [];
  for (const a of conns) {
    const cx = cellOf(a.pos.x), cy = cellOf(a.pos.y);
    const ka = connKey(a.pieceId, a.index);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (b.pieceId === a.pieceId || b.level !== a.level) continue;
        const kb = connKey(b.pieceId, b.index);
        if (ka >= kb) continue; // each unordered pair once
        const d = dist(a.pos, b.pos);
        if (d > NEAR_POS_TOL + EPS) continue;
        if (180 - angleDiff(a.heading, b.heading) > NEAR_ANGLE_TOL + EPS) continue;
        out.push({ a, b, d, ka, kb });
      }
    }
  }
  return out;
}

const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

// ---- overlap: centreline clearance ----

export const OVERLAP_CLEARANCE = 0.3;
const MAX_STEP_U = 1 / 16;
const MAX_STEP_DEG = 5;

const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

export function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance between two segments: 0 if they intersect, else the smallest endpoint-to-segment distance. */
export function segSegDist(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSeg(p1, q1, q2), distToSeg(p2, q1, q2), distToSeg(q1, p1, p2), distToSeg(q2, p1, p2));
}

/** A piece's route centrelines; `box` is their bounding box padded by OVERLAP_CLEARANCE. */
export interface RouteShape { lines: Vec2[][]; box: [number, number, number, number] }

/** Route centrelines as polylines sampled every <= 1/16U and <= 5 degrees of turn. */
export function routeShape(p: Omit<Piece, 'id'>): RouteShape {
  const lines: Vec2[][] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let r = 0; r < pieceGeometry(p).routes.length; r++) {
    const path = worldRoutePath(p, r);
    const turn = path.segments.reduce((t, s) => t + (s.kind === 'arc' ? Math.abs(s.sweep) : 0), 0);
    const n = Math.max(1, Math.ceil(path.length / MAX_STEP_U), Math.ceil(turn / MAX_STEP_DEG));
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const v = samplePath(path, (path.length * i) / n).pos;
      pts.push(v);
      x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y);
    }
    lines.push(pts);
  }
  const m = OVERLAP_CLEARANCE;
  return { lines, box: [x0 - m, y0 - m, x1 + m, y1 + m] };
}

/** True when any route of `a` comes within OVERLAP_CLEARANCE of any route of `b` (the overlap test). */
export function shapesNear(a: RouteShape, b: RouteShape): boolean {
  if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) return false;
  for (const la of a.lines) for (const lb of b.lines) {
    for (let i = 0; i + 1 < la.length; i++) for (let j = 0; j + 1 < lb.length; j++) {
      if (segSegDist(la[i], la[i + 1], lb[j], lb[j + 1]) < OVERLAP_CLEARANCE) return true;
    }
  }
  return false;
}

/** Distance from `pt` to the nearest route centreline of the shape. */
export function shapeDist(s: RouteShape, pt: Vec2): number {
  let d = Infinity;
  for (const line of s.lines) for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSeg(pt, line[i], line[i + 1]));
  return d;
}

export function buildGraph(pieces: Piece[]): TrackGraph {
  const conns = pieces.flatMap(worldConnectors);
  const cands = connectorPairs(conns).sort((x, y) =>
    Math.round((x.d - y.d) * 1e9) || cmpStr(x.ka, y.ka) || cmpStr(x.kb, y.kb));

  const joins = new Map<string, WorldConnector>();
  const joinable = new Set<string>();
  const pairKey = (c: Cand) => c.ka + '|' + c.kb;
  for (const c of cands) {
    if (c.d > JOIN_POS_TOL || 180 - angleDiff(c.a.heading, c.b.heading) > JOIN_ANGLE_TOL) continue;
    joinable.add(pairKey(c));
    if (joins.has(c.ka) || joins.has(c.kb)) continue;
    joins.set(c.ka, c.b);
    joins.set(c.kb, c.a);
  }

  const open = conns.filter((c) => !joins.has(connKey(c.pieceId, c.index)));
  const nearMisses: Array<[WorldConnector, WorldConnector]> = [];
  for (const c of cands) {
    if (joinable.has(pairKey(c)) || joins.has(c.ka) || joins.has(c.kb)) continue;
    nearMisses.push([c.a, c.b]);
  }

  // Overlaps via a 1U spatial hash over centreline bounding boxes (padded by the clearance).
  const shapes = pieces.map(routeShape);
  const joinedPieces = new Set<string>();
  const nbrs = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { const l = nbrs.get(a); if (l) l.add(b); else nbrs.set(a, new Set([b])); };
  for (const [k, w] of joins) {
    const id = k.slice(0, k.lastIndexOf(':'));
    joinedPieces.add(id + '|' + w.pieceId);
    link(id, w.pieceId);
  }
  // Pieces joined to the same third piece (graph distance 2) are also exempt: across a short piece such as
  // straight-1-4 their ends are < OVERLAP_CLEARANCE apart. Limitation: a genuine overlap between two pieces
  // that share a neighbour is therefore not detected.
  for (const set of nbrs.values()) {
    for (const x of set) for (const y of set) if (x !== y) joinedPieces.add(x + '|' + y);
  }
  const grid = new Map<string, number[]>();
  shapes.forEach((s, i) => {
    for (let cx = cellOf(s.box[0]); cx <= cellOf(s.box[2]); cx++) {
      for (let cy = cellOf(s.box[1]); cy <= cellOf(s.box[3]); cy++) {
        const k = cellKey(cx, cy);
        const l = grid.get(k);
        if (l) l.push(i); else grid.set(k, [i]);
      }
    }
  });
  const seen = new Set<string>();
  const overlaps: Array<[string, string]> = [];
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
      const pk = i + ',' + j;
      if (seen.has(pk)) continue;
      seen.add(pk);
      if (pieces[i].level !== pieces[j].level || pieces[i].id === pieces[j].id) continue;
      if (joinedPieces.has(pieces[i].id + '|' + pieces[j].id)) continue;
      if (shapesNear(shapes[i], shapes[j])) {
        const [a, b] = pieces[i].id < pieces[j].id ? [pieces[i].id, pieces[j].id] : [pieces[j].id, pieces[i].id];
        overlaps.push([a, b]);
      }
    }
  }
  overlaps.sort((p, q) => cmpStr(p[0], q[0]) || cmpStr(p[1], q[1]));
  return { joins, open, nearMisses, overlaps };
}
