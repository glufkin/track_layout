import { type Vec2, normDeg } from '../geom/vec';
import { samplePath } from '../geom/path';
import { getPieceDef, pieceRoutes, type RouteDef } from '../track/catalog';
import { connKey, worldRoutePath } from '../track/graph';
import type { Doc } from '../model/doc';
import type { Piece, Train, TrackPos } from '../model/types';

export const LOCO_LEN = 1.0;
export const CAR_LEN = 0.8;
export const COUPLING = 0.1;
export const CAR_WIDTH = 0.45;

export const trainLength = (cars: number): number => LOCO_LEN + cars * (CAR_LEN + COUPLING);

export interface AdvanceResult {
  pos: TrackPos; moved: number; hitEnd: boolean;
  entered: Array<{ pieceId: string; viaConnector: number; facing: boolean }>;
}

export interface CarPose { center: Vec2; heading: number; length: number; level: number; isLoco: boolean; pieceIds: string[] }

function pieceOf(doc: Doc, id: string): Piece {
  const p = doc.piece(id);
  if (!p) throw new Error('Unknown piece: ' + id);
  return p;
}

const routeOf = (p: Piece, route: number): RouteDef => {
  const r = pieceRoutes(p.type, p.flipped)[route];
  if (!r) throw new Error('Unknown route ' + route + ' on piece ' + p.id);
  return r;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** The route (and travel direction) a train takes when entering `pieceId` through `connector`. */
export function routeEntering(doc: Doc, pieceId: string, connector: number): { route: number; dir: 1 | -1; facing: boolean } {
  const p = pieceOf(doc, pieceId);
  const def = getPieceDef(p.type);
  const routes = pieceRoutes(p.type, p.flipped);
  if (def.switch && connector === def.switch.entry) {
    const route = def.switch.routes[p.switch?.state ?? 0];
    return { route, dir: routes[route].from === connector ? 1 : -1, facing: true };
  }
  for (let i = 0; i < routes.length; i++) {
    if (routes[i].from === connector) return { route: i, dir: 1, facing: false };
    if (routes[i].to === connector) return { route: i, dir: -1, facing: false };
  }
  throw new Error('Connector ' + connector + ' is on no route of piece ' + pieceId);
}

/** Move `ds >= 0` along `pos.dir`, route by route, following switches. */
export function advance(doc: Doc, pos: TrackPos, ds: number, opts: { alignTrailing: boolean }): AdvanceResult {
  let piece = pieceOf(doc, pos.pieceId);
  let route = routeOf(piece, pos.route);
  let cur: TrackPos = { ...pos, dist: clamp(pos.dist, 0, route.path.length) };
  let remaining = Math.max(0, ds);
  let moved = 0;
  const entered: AdvanceResult['entered'] = [];
  // Guard against cycles of zero-length routes: give up after this many transitions without progress.
  const maxIdle = 4 * doc.layout.pieces.length + 4;
  let idle = 0;

  for (;;) {
    const len = route.path.length;
    const toEnd = cur.dir === 1 ? len - cur.dist : cur.dist;
    if (remaining <= toEnd) {
      cur.dist += cur.dir * remaining;
      moved += remaining;
      return { pos: cur, moved, hitEnd: false, entered };
    }
    moved += toEnd;
    remaining -= toEnd;
    cur.dist = cur.dir === 1 ? len : 0;
    idle = toEnd > 0 ? 0 : idle + 1;

    const exit = cur.dir === 1 ? route.to : route.from;
    const next = exit === null ? undefined : doc.graph.joins.get(connKey(piece.id, exit));
    const nextPiece = next ? doc.piece(next.pieceId) : undefined;
    if (!next || !nextPiece || idle > maxIdle) return { pos: cur, moved, hitEnd: true, entered };

    const e = routeEntering(doc, next.pieceId, next.index);
    const sw = getPieceDef(nextPiece.type).switch;
    if (sw && !e.facing && opts.alignTrailing) {
      const state: 0 | 1 = sw.routes[0] === e.route ? 0 : 1;
      if (nextPiece.switch) nextPiece.switch.state = state;
      else nextPiece.switch = { mode: 'manual', state };
    }
    entered.push({ pieceId: next.pieceId, viaConnector: next.index, facing: e.facing });
    piece = nextPiece;
    route = routeOf(piece, e.route);
    cur = { pieceId: piece.id, route: e.route, dist: e.dir === 1 ? 0 : route.path.length, dir: e.dir };
  }
}

const flip = (p: TrackPos): TrackPos => ({ ...p, dir: p.dir === 1 ? -1 : 1 });

/** Move `ds` against `pos.dir` without touching switches; the result keeps the original travel direction. */
export function walkBack(doc: Doc, pos: TrackPos, ds: number): TrackPos {
  return flip(advance(doc, flip(pos), ds, { alignTrailing: false }).pos);
}

export function poseAt(doc: Doc, pos: TrackPos): { pos: Vec2; heading: number; level: number } {
  const p = pieceOf(doc, pos.pieceId);
  const path = worldRoutePath(p, pos.route);
  const dist = clamp(pos.dist, 0, path.length);
  const s = samplePath(path, dist);
  const fraction = path.length > 0 ? dist / path.length : 0;
  const level = p.level + (getPieceDef(p.type).ramp && fraction > 0.5 ? 1 : 0);
  return { pos: s.pos, heading: normDeg(s.heading + (pos.dir === -1 ? 180 : 0)), level };
}

/** Pieces under the span from `front` back `length`, front to rear. */
function piecesUnder(doc: Doc, front: TrackPos, length: number): string[] {
  const r = advance(doc, flip(front), length, { alignTrailing: false });
  const ids = [front.pieceId];
  for (const e of r.entered) if (!ids.includes(e.pieceId)) ids.push(e.pieceId);
  return ids;
}

export function carPoses(doc: Doc, train: Train): CarPose[] {
  if (train.head === null) return [];
  const out: CarPose[] = [];
  let centre = 0; // distance of this car's centre behind the head
  for (let i = 0; i <= train.cars; i++) {
    const isLoco = i === 0;
    const length = isLoco ? LOCO_LEN : CAR_LEN;
    centre += isLoco ? LOCO_LEN / 2 : out[i - 1].length / 2 + COUPLING + CAR_LEN / 2;
    const c = walkBack(doc, train.head, centre);
    const front = walkBack(doc, train.head, centre - length / 2);
    const pose = poseAt(doc, c);
    out.push({
      center: pose.pos, heading: pose.heading, length, level: pose.level, isLoco,
      pieceIds: piecesUnder(doc, front, length),
    });
  }
  return out;
}

export function occupiedPieces(doc: Doc, train: Train): Set<string> {
  const s = new Set<string>();
  for (const c of carPoses(doc, train)) for (const id of c.pieceIds) s.add(id);
  return s;
}

/** Distance to the next dead end along current switch states, capped at `max`. Changes nothing. */
export function distanceAhead(doc: Doc, pos: TrackPos, max: number): number {
  return advance(doc, pos, max, { alignTrailing: false }).moved;
}

/** The train's tail position with the direction flipped (the new head after reversing). */
export function reverseHead(doc: Doc, train: Train): TrackPos {
  if (train.head === null) throw new Error('reverseHead: train ' + train.id + ' is lifted');
  return flip(walkBack(doc, train.head, trainLength(train.cars)));
}
