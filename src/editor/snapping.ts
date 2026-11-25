import { type Vec2, type Pose, applyPose, dist, normDeg, rotate, add, sub } from '../geom/vec';
import { pieceGeometry } from '../track/catalog';
import { type WorldConnector, connKey, worldConnectors } from '../track/graph';
import { MAX_LEVEL } from '../model/types';
import type { Doc } from '../model/doc';

export const GRID = 0.5;
export const ROT_STEP = 22.5;
/** Max heading error (from exactly opposite) for a group-drag connector pair to be compatible. */
const GROUP_ANGLE_TOL = 45;

export interface GhostRequest {
  type: string; flipped: boolean; attachIndex: number;
  cursor: Vec2; freeRot: number; level: number; alt: boolean; snapRadius: number;
  prefer?: WorldConnector;
}
export interface GhostResult {
  pose: Pose; level: number; mode: 'connector' | 'grid' | 'free';
  target?: WorldConnector; attachIndex: number;
}

const snapTo = (v: number, step: number): number => Math.round(v / step) * step + 0;

export function computeGhost(doc: Doc, req: GhostRequest): GhostResult {
  const conns = pieceGeometry(req).connectors;
  const n = conns.length;
  const attachIndex = ((req.attachIndex % n) + n) % n;
  if (req.alt) {
    return { pose: { x: req.cursor.x, y: req.cursor.y, rot: req.freeRot }, level: req.level, mode: 'free', attachIndex };
  }

  const conn = conns[attachIndex];
  const fit = (t: WorldConnector): GhostResult | null => {
    const level = t.level - conn.levelOffset;
    if (level < 0 || level > MAX_LEVEL) return null;
    const rot = normDeg(t.heading + 180 - conn.heading);
    const off = applyPose({ x: 0, y: 0, rot }, conn.pos);
    return { pose: { x: t.pos.x - off.x, y: t.pos.y - off.y, rot }, level, mode: 'connector', target: t, attachIndex };
  };

  const open = doc.graph.open;
  const pref = req.prefer;
  if (pref && open.some((c) => c.pieceId === pref.pieceId && c.index === pref.index) && dist(pref.pos, req.cursor) <= 3 * req.snapRadius) {
    const r = fit(pref);
    if (r) return r;
  }
  const near = open
    .map((c) => ({ c, d: dist(c.pos, req.cursor) }))
    .filter((e) => e.d <= req.snapRadius)
    .sort((a, b) => a.d - b.d);
  for (const { c } of near) {
    const r = fit(c);
    if (r) return r;
  }

  return {
    pose: { x: snapTo(req.cursor.x, GRID), y: snapTo(req.cursor.y, GRID), rot: normDeg(snapTo(req.freeRot, ROT_STEP)) },
    level: req.level, mode: 'grid', attachIndex,
  };
}

export interface GroupSnap { delta: Vec2; rot: number; pivot: Vec2 }

const moveBy = (p: Vec2, g: GroupSnap): Vec2 => add(add(rotate(sub(p, g.pivot), g.rot), g.pivot), g.delta);

export function snapGroup(doc: Doc, ids: string[], proposed: GroupSnap, snapRadius: number, alt: boolean): GroupSnap {
  if (alt) return proposed;
  const sel = new Set(ids);
  // Unselected connectors that are open, or joined to a selected piece (that join breaks, so it may re-form).
  const targets: WorldConnector[] = [];
  for (const p of doc.layout.pieces) {
    if (sel.has(p.id)) continue;
    for (const c of worldConnectors(p)) {
      const j = doc.graph.joins.get(connKey(c.pieceId, c.index));
      if (!j || sel.has(j.pieceId)) targets.push(c);
    }
  }
  if (!targets.length) return proposed;

  // Selected connectors that are open, or joined to an unselected piece (that join breaks).
  const moving: WorldConnector[] = [];
  for (const id of ids) {
    const p = doc.piece(id);
    if (!p) continue;
    for (const c of worldConnectors(p)) {
      const j = doc.graph.joins.get(connKey(c.pieceId, c.index));
      if (!j || !sel.has(j.pieceId)) moving.push(c);
    }
  }

  let best: { m: WorldConnector; t: WorldConnector; d: number } | null = null;
  for (const m of moving) {
    const pos = moveBy(m.pos, proposed);
    const heading = normDeg(m.heading + proposed.rot);
    for (const t of targets) {
      if (t.level !== m.level) continue;
      const d = dist(pos, t.pos);
      if (d > snapRadius) continue;
      if (Math.abs(normDeg(t.heading + 180 - heading)) > GROUP_ANGLE_TOL) continue;
      if (!best || d < best.d) best = { m, t, d };
    }
  }
  if (!best) return proposed;

  const rot = proposed.rot + normDeg(best.t.heading + 180 - normDeg(best.m.heading + proposed.rot));
  const at = add(rotate(sub(best.m.pos, proposed.pivot), rot), proposed.pivot);
  return { delta: sub(best.t.pos, at), rot, pivot: proposed.pivot };
}

export function posesAfterGroup(doc: Doc, ids: string[], g: GroupSnap): Map<string, Pose> {
  const out = new Map<string, Pose>();
  for (const id of ids) {
    const p = doc.piece(id);
    if (!p) continue;
    const pos = moveBy(p, g);
    out.set(id, { x: pos.x, y: pos.y, rot: normDeg(p.rot + g.rot) });
  }
  return out;
}
