import { type Vec2, normDeg, rotate, sub } from '../geom/vec';
import type { Piece } from '../model/types';
import { FLEX_LIMITS, FLEX_DEFAULTS, pieceGeometry, type FlexParams, type FlexType } from '../track/catalog';
import { worldConnectors } from '../track/graph';
import type { Command } from '../editor/history';

export interface FlexResult { flex: FlexParams; x: number; y: number; rot: number }

/** Smallest sweep a dragged curve may shrink to: positive, so it never reaches 0 or flips sign. */
const MIN_SWEEP = 1;
const DEG = 180 / Math.PI;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const currentFlex = (p: Piece): FlexParams => p.flex ?? FLEX_DEFAULTS[p.type as FlexType];

/** New parameters when end 1 is dragged to `to`; end 0 (the piece pose) stays put. */
function resizeEnd1(p: Piece, to: Vec2, alt: boolean): FlexParams {
  const f = currentFlex(p);
  const L = FLEX_LIMITS;
  const local = rotate(sub(to, p), -p.rot);
  if ('length' in f) return { length: clamp(local.x, L.minLength, L.maxLength) };
  const t = p.flipped ? { x: local.x, y: -local.y } : local; // unflipped: right turn
  if (alt) {
    const r = Math.hypot(t.x, t.y) / (2 * Math.sin((f.sweep * Math.PI) / 360));
    return { radius: clamp(r, L.minRadius, L.maxRadius), sweep: f.sweep };
  }
  const sweep = Math.atan2(t.x, f.radius - t.y) * DEG;
  return { radius: f.radius, sweep: clamp(sweep, MIN_SWEEP, L.maxSweep) };
}

/**
 * Resize a flex piece by dragging open end `end` to world point `to`; the other end keeps its
 * world pose, so the piece pose (connector 0) moves when end 0 is dragged. A straight takes the
 * projected length; a curve the swept angle, or (with `alt`) a new radius at the same sweep.
 */
export function flexResize(piece: Piece, end: 0 | 1, to: Vec2, alt: boolean): FlexResult {
  if (end === 1) return { flex: resizeEnd1(piece, to, alt), x: piece.x, y: piece.y, rot: piece.rot };
  // Work on the piece seen from its other end (reversed travel, mirrored turn), then map back.
  const e1 = worldConnectors(piece)[1];
  const rev: Piece = { ...piece, x: e1.pos.x, y: e1.pos.y, rot: normDeg(e1.heading + 180), flipped: !piece.flipped };
  const flex = resizeEnd1(rev, to, alt);
  const c = pieceGeometry({ type: rev.type, flipped: rev.flipped, flex }).connectors[1];
  const o = rotate(c.pos, rev.rot);
  return { flex, x: rev.x + o.x, y: rev.y + o.y, rot: normDeg(rev.rot + c.heading + 180) };
}

/** Set a flex piece's parameters and pose, undoably. Issue it through `withLifting`. */
export function resizeFlex(id: string, next: FlexResult): Command {
  let before: Piece | null = null;
  const put = (doc: Parameters<Command['do']>[0], q: Piece): void => {
    doc.layout.pieces = doc.layout.pieces.map((p) => (p.id === id ? structuredClone(q) : p));
    doc.rebuild();
  };
  return {
    label: 'Resize flex',
    do(doc) {
      const p = doc.piece(id);
      if (!p) return;
      before ??= structuredClone(p);
      put(doc, { ...p, ...structuredClone(next) });
    },
    undo(doc) { if (before) put(doc, before); },
  };
}
