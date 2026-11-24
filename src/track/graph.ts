import { type Vec2, applyPose, dist, angleDiff, normDeg } from '../geom/vec';
import { type RoutePath, transformPath, samplePath } from '../geom/path';
import { pieceConnectors, pieceRoutes, pieceFootprint } from './catalog';
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
  return pieceConnectors(p.type, p.flipped).map((c, index) => ({
    pieceId: p.id, index,
    pos: applyPose(p, c.pos),
    heading: normDeg(c.heading + p.rot),
    level: p.level + c.levelOffset,
  }));
}

export function worldRoutePath(p: Piece, route: number): RoutePath {
  return transformPath(pieceRoutes(p.type, p.flipped)[route].path, p);
}

/** One band polygon per route, in world coordinates. */
export function worldFootprint(p: Piece): Vec2[][] {
  return pieceFootprint(p.type, p.flipped).map((poly) => poly.map((v) => applyPose(p, v)));
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

// ---- polygon intersection (footprints are simple, possibly non-convex) ----

const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Strictly inside: boundary points (within 1e-6) do not count. */
function strictlyInside(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSeg(pt, poly[j], poly[i]) < 1e-6) return false;
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Proper crossing (interiors cross at a single point); touching and collinear do not count. */
function segsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  const e = 1e-9;
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

interface Shape { id: string; polys: Vec2[][]; samples: Vec2[]; box: [number, number, number, number] }

function makeShape(p: Piece): Shape {
  const polys = worldFootprint(p);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const v of poly) {
    x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y);
  }
  // Route centreline samples catch stacked pieces whose band edges are collinear.
  const samples: Vec2[] = [];
  for (let r = 0; r < polys.length; r++) {
    const path = worldRoutePath(p, r);
    const n = Math.max(2, Math.ceil(path.length / 0.25));
    for (let i = 0; i <= n; i++) samples.push(samplePath(path, (path.length * i) / n).pos);
  }
  return { id: p.id, polys, samples, box: [x0, y0, x1, y1] };
}

function shapesOverlap(a: Shape, b: Shape): boolean {
  if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) return false;
  for (const pa of a.polys) for (const pb of b.polys) {
    for (let i = 0; i < pa.length; i++) {
      const p1 = pa[i], p2 = pa[(i + 1) % pa.length];
      for (let j = 0; j < pb.length; j++) if (segsCross(p1, p2, pb[j], pb[(j + 1) % pb.length])) return true;
    }
  }
  for (const pt of a.samples) for (const pb of b.polys) if (strictlyInside(pt, pb)) return true;
  for (const pt of b.samples) for (const pa of a.polys) if (strictlyInside(pt, pa)) return true;
  for (const [s, o] of [[a, b], [b, a]] as const) {
    for (const poly of s.polys) for (const v of poly) for (const po of o.polys) if (strictlyInside(v, po)) return true;
  }
  return false;
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

  // Overlaps via a 1U spatial hash over footprint bounding boxes.
  const shapes = pieces.map(makeShape);
  const joinedPieces = new Set<string>();
  for (const [k, w] of joins) joinedPieces.add(k.slice(0, k.lastIndexOf(':')) + '|' + w.pieceId);
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
      if (shapesOverlap(shapes[i], shapes[j])) {
        const [a, b] = pieces[i].id < pieces[j].id ? [pieces[i].id, pieces[j].id] : [pieces[j].id, pieces[i].id];
        overlaps.push([a, b]);
      }
    }
  }
  overlaps.sort((p, q) => cmpStr(p[0], q[0]) || cmpStr(p[1], q[1]));
  return { joins, open, nearMisses, overlaps };
}
