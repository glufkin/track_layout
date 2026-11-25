/**
 * Stroke start resolution and release (spec §5.3 start, §5.4 release, §5.5 bridges, §5.7 switches):
 * turn a StrokeFitter's ghost into ONE undoable command.
 *
 * Usage: `beginStroke` on pointer down; build the fitter as
 * `new StrokeFitter(strokeDoc(doc, start), start)` so it sees the start's switch splice (with ids
 * `startId(i)`) and not the removed buffer; `finishStroke` on pointer up.
 */
import { type Pose, type Vec2, angleDiff, dist, fromAngle } from '../geom/vec';
import { samplePath, transformPath } from '../geom/path';
import { Doc } from '../model/doc';
import type { Piece } from '../model/types';
import { pieceGeometry } from '../track/catalog';
import {
  JOIN_ANGLE_TOL, JOIN_POS_TOL, type WorldConnector, buildGraph, connKey, routeShape, shapeDist, shapesNear, worldConnectors,
} from '../track/graph';
import { batch, deletePieces, placePieces, withLifting } from '../editor/commands';
import type { Command } from '../editor/history';
import { type FitterStart, type StrokeFitter, crossId } from './fitter';
import { chainTurn, gentlest, solveJoin } from './join';
import { type PieceSpec, attachSpec, outPose, specToPiece } from './spec';
import { type Splice, mergeStraights, switchSplice } from './splice';

export type StrokeStart = FitterStart & {
  startSplice?: Splice; removeBuffer?: string; attachedTo?: WorldConnector; empty: boolean;
};

/** Strokes shorter than this (U) are ignored (treated as a click). */
export const MIN_STROKE = 0.5;
/** A point this close to a buffer's route is on the buffer (its track band half-width). */
const BUFFER_HIT = 0.25;
/** Most trailing ghost pieces the end join may rework (spec §5.4). */
const MAX_REWORK = 2;
/**
 * An end join turning more than this in total (degrees) is a loop and is rejected. Wider than the
 * fitter's MAX_JOIN_TURN (120°) for crossings: a stroke meeting straight track square-on can only reach a
 * merging switch's branch (spec §5.7) with an S-bend of 45° plus twice its first bend, which close
 * to the track takes up to about 170°. The gentlest chain is always preferred.
 */
const MAX_END_JOIN_TURN = 180;
/** Stroke length, back from its end, searched for the pointer getting past the last piece's middle. */
const TRIM_TAIL = 3;
const EPS = 1e-9;

/** Id the fitter's doc gives `start.startSplice.add[i]` (see `strokeDoc`). */
export const startId = (i: number): string => 'start:' + i;

const poseOf = (c: WorldConnector): Pose => ({ x: c.pos.x, y: c.pos.y, rot: c.heading });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

// ---- route geometry ----

/** Distance from `pt` to the nearest route of `p`. */
const routeDist = (p: PieceSpec, pt: Vec2): number => shapeDist(routeShape(p), pt);

/** Nearest by distance, preferring entries at `level`. */
function pickNearest<T extends { d: number; level: number }>(xs: T[], level: number): T | null {
  const sorted = [...xs].sort((a, b) => (a.level === level ? 0 : 1) - (b.level === level ? 0 : 1) || a.d - b.d);
  return sorted[0] ?? null;
}

// ---- start ----

/**
 * Resolve a stroke's start at `pt` (spec §5.3), in order:
 * 1. an open connector within `snapRadius` (one at `level` preferred): continue from it;
 * 2. a buffer stop hit, or its connector within `snapRadius`: continue from the track it ends
 *    (`removeBuffer`); a lone buffer is continued from its own connector and kept;
 * 3. a track route at `level` within `snapRadius`: a diverging switch (§5.7), or 'refused' when no
 *    plain straight is within reach. Without a usable `strokeDir` a provisional start is returned
 *    (`heading: null`, `empty: false`, no `startSplice`): call again once the drag direction is known;
 * 4. otherwise an empty start at `level` (heading taken from the drag by the fitter).
 */
export function beginStroke(doc: Doc, pt: Vec2, level: number, snapRadius: number, strokeDir?: Vec2): StrokeStart | 'refused' {
  // 1. Open connector.
  const open = pickNearest(doc.graph.open.map((c) => ({ c, d: dist(c.pos, pt), level: c.level }))
    .filter((e) => e.d <= snapRadius), level);
  if (open) {
    const { c } = open;
    return { pos: { ...c.pos }, heading: c.heading, level: c.level, attachedTo: c, empty: false };
  }

  // 2. Buffer stop.
  const buffers = doc.layout.pieces.filter((p) => p.type === 'buffer').map((p) => {
    const c = worldConnectors(p)[0];
    return { p, c, d: Math.min(dist(c.pos, pt) <= snapRadius ? dist(c.pos, pt) : Infinity, routeDist(p, pt) <= BUFFER_HIT ? routeDist(p, pt) : Infinity), level: c.level };
  }).filter((e) => e.d < Infinity);
  const buf = pickNearest(buffers, level);
  if (buf) {
    const mate = doc.graph.joins.get(connKey(buf.p.id, 0));
    if (mate) return { pos: { ...mate.pos }, heading: mate.heading, level: mate.level, removeBuffer: buf.p.id, attachedTo: mate, empty: false };
    return { pos: { ...buf.c.pos }, heading: buf.c.heading, level: buf.c.level, attachedTo: buf.c, empty: false };
  }

  // 3. On track at this level: a diverging switch.
  if (doc.layout.pieces.some((p) => p.level === level && routeDist(p, pt) <= snapRadius)) {
    const dirOk = !!strokeDir && Math.hypot(strokeDir.x, strokeDir.y) > EPS;
    // Whether a switch fits does not depend on the direction; it only picks the switch's side.
    const res = switchSplice(doc, pt, level, dirOk ? strokeDir! : { x: 1, y: 0 }, 'diverge', snapRadius);
    if (!res) return 'refused';
    if (!dirOk) return { pos: { ...pt }, heading: null, level, empty: false };
    return { pos: { x: res.branch.x, y: res.branch.y }, heading: res.branch.rot, level, startSplice: res.splice, empty: false };
  }

  // 4. Empty table.
  return { pos: { ...pt }, heading: null, level, empty: true };
}

/** The doc a stroke's fitter works against: the start's buffer removed and its switch splice applied (ids `startId(i)`). */
export function strokeDoc(doc: Doc, start: StrokeStart): Doc {
  if (!start.startSplice && !start.removeBuffer) return doc;
  const removed = new Set([...(start.startSplice?.remove ?? []), ...(start.removeBuffer ? [start.removeBuffer] : [])]);
  return new Doc({
    ...doc.layout,
    pieces: [
      ...doc.layout.pieces.filter((p) => !removed.has(p.id)),
      ...(start.startSplice?.add ?? []).map((s, i) => specToPiece(s, startId(i))),
    ],
  });
}

// ---- release ----

/** Fresh piece ids for one command: `p<n>` counted on from `doc.newId('p')`, skipping any in use. */
function idAllocator(doc: Doc): () => string {
  const used = new Set([...doc.layout.pieces.map((p) => p.id), ...doc.layout.trains.map((t) => t.id)]);
  let n = Number(doc.newId('p').slice(1));
  return () => {
    while (used.has('p' + n)) n++;
    used.add('p' + n);
    return 'p' + n;
  };
}

const mates = (from: Pose, to: Pose): boolean =>
  dist(from, to) < JOIN_POS_TOL && angleDiff(from.rot, to.rot + 180) < JOIN_ANGLE_TOL;

/** True when the stroke got more than halfway past the piece `spec` (its route's middle). */
function pastHalf(spec: PieceSpec, points: Vec2[], endPt: Vec2): boolean {
  const path = transformPath(pieceGeometry(spec).routes[0].path, spec);
  const mid = samplePath(path, path.length / 2);
  const u = fromAngle(mid.heading);
  const ahead = (p: Vec2): boolean => dot({ x: p.x - mid.pos.x, y: p.y - mid.pos.y }, u) > 0 && dist(p, mid.pos) <= path.length / 2 + TRIM_TAIL;
  if (ahead(endPt)) return true;
  let s = 0;
  for (let i = points.length - 1; i >= 0 && s <= TRIM_TAIL + path.length; i--) {
    if (ahead(points[i])) return true;
    if (i > 0) s += dist(points[i], points[i - 1]);
  }
  return false;
}

/**
 * Build the stroke's single command on release (spec §5.4), or null for a stroke shorter than
 * MIN_STROKE or one that lays no track. The fitter must have been built on `strokeDoc(doc, start)`.
 * 1. Trim the last ghost piece (not below `fitter.frozen`) if the stroke never got halfway past it.
 * 2. A red stroke ends at its lead (the last good piece) in a buffer stop.
 * 3. The end: an open connector or buffer stop within `snapRadius` at the lead level is joined with
 *    `solveJoin` (the gentlest overlap-free chain over reworking zero to two trailing unfrozen
 *    pieces; a joined buffer is removed); else a
 *    merging switch on plain straight track, joined to its branch; else (or when no join is found)
 *    a buffer stop at the lead. A lead buffer that would overlap track drops unfrozen trailing
 *    pieces until it fits; if none fits down to `frozen`, the end is left open.
 * 4. An empty start gets a buffer stop facing outward, unless it would overlap track (open start). 5. Straights are merged. 6. Raised
 *    `straight-1`/`straight-2` passing over lower track become `bridge-1`/`bridge-2`.
 * 7. One `withLifting` command: start, crossing and end splices, removed buffers, new pieces.
 */
export function finishStroke(doc: Doc, start: StrokeStart, fitter: StrokeFitter, endPt: Vec2, snapRadius: number): Command | null {
  if (fitter.length < MIN_STROKE) return null;
  const newId = idAllocator(doc);

  // The world as the splices leave it: existing pieces kept, pieces this command adds (by new id).
  const world = new Map(doc.layout.pieces.map((p) => [p.id, p]));
  const added = new Map<string, Piece>();
  const removed = new Set<string>();
  const refs = new Map<string, string>();
  const remove = (ref: string): void => {
    const id = refs.get(ref) ?? ref;
    if (added.delete(id)) { world.delete(id); return; }
    if (world.delete(id)) removed.add(id);
  };
  const apply = (s: Splice, ref: (i: number) => string): void => {
    for (const id of s.remove) remove(id);
    s.add.forEach((spec, i) => {
      const p = specToPiece(spec, newId());
      refs.set(ref(i), p.id);
      world.set(p.id, p);
      added.set(p.id, p);
    });
  };
  if (start.removeBuffer) remove(start.removeBuffer);
  if (start.startSplice) apply(start.startSplice, startId);
  fitter.crossings.forEach((c, ci) => { if (!c.ghost) apply(c.splice, (i) => crossId(ci, i)); });

  // 1. Trim.
  let ghost = [...fitter.pieces];
  let lead = fitter.lead.pose;
  const level = fitter.lead.level;
  const red = fitter.redFrom !== null;
  const frozen = fitter.frozen;
  if (!red && ghost.length > frozen && !pastHalf(ghost[ghost.length - 1], fitter.points, endPt)) {
    lead = fitter.anchors[ghost.length - 1];
    ghost.pop();
  }

  /**
   * True when `fresh` (and the pieces `splice` adds) overlap no same-level track other than what is
   * going: the world minus `gone` and the splice's removals, plus ghost[0..keep). Track joined to the
   * new pieces, directly or through one piece, is exempt as in the graph's overlap test.
   */
  const clear = (fresh: PieceSpec[], keep: number, gone: string[], splice?: Splice): boolean => {
    const out = new Set([...gone, ...(splice?.remove ?? [])]);
    const others = [...world.values()].filter((p) => !out.has(p.id));
    ghost.slice(0, keep).forEach((s, i) => others.push(specToPiece(s, '\u0000ghost:' + i)));
    const tag = '\u0000new:';
    const mine = [...(splice?.add ?? []), ...fresh].map((s, i) => specToPiece(s, tag + i));
    return !buildGraph([...others, ...mine]).overlaps.some(([a, b]) => a.startsWith(tag) || b.startsWith(tag));
  };

  /**
   * Join the lead (or the anchor of up to MAX_REWORK trailing unfrozen pieces) to `to`. Of every
   * rework count that closes without overlapping other track (removing `gone` and applying
   * `splice` first) and turns at most MAX_END_JOIN_TURN, the gentlest chain is taken; true when done.
   */
  const joinTo = (to: Pose, gone: string[], splice?: Splice): boolean => {
    const n = ghost.length;
    const found: Array<{ keep: number; chain: PieceSpec[] }> = [];
    for (let k = 0; k <= MAX_REWORK && n - k >= frozen; k++) {
      const from = k === 0 ? lead : fitter.anchors[n - k];
      const chain = mates(from, to) ? [] : solveJoin(from, to, level);
      if (chain && chainTurn(chain) <= MAX_END_JOIN_TURN && clear(chain, n - k, gone, splice)) found.push({ keep: n - k, chain });
    }
    const best = gentlest(found.map((f) => f.chain));
    const pick = found.find((f) => f.chain === best);
    if (!pick) return false;
    ghost = [...ghost.slice(0, pick.keep), ...pick.chain];
    return true;
  };

  // 2./3. Resolve the end.
  const extra: PieceSpec[] = [];
  let ended = false;
  if (!red) {
    const trackDoc = new Doc({ ...doc.layout, pieces: [...world.values()] });
    const ghostPieces = ghost.map((s, i) => specToPiece(s, 'ghost:' + i));
    const full = new Doc({ ...doc.layout, pieces: [...world.values(), ...ghostPieces] });
    const isGhost = (id: string): boolean => id.startsWith('ghost:');
    const targets: Array<{ to: Pose; d: number; level: number; buffer?: string }> = [];
    for (const c of full.graph.open) {
      if (isGhost(c.pieceId) || c.level !== level) continue;
      const d = dist(c.pos, endPt);
      if (d <= snapRadius) targets.push({ to: poseOf(c), d, level });
    }
    for (const p of world.values()) {
      if (p.type !== 'buffer') continue;
      const c = worldConnectors(p)[0];
      const mate = full.graph.joins.get(connKey(p.id, 0));
      if (!mate || isGhost(mate.pieceId) || mate.level !== level) continue;
      const d = Math.min(dist(c.pos, endPt) <= snapRadius ? dist(c.pos, endPt) : Infinity, routeDist(p, endPt) <= BUFFER_HIT ? routeDist(p, endPt) : Infinity);
      if (d < Infinity) targets.push({ to: poseOf(mate), d, level, buffer: p.id });
    }
    const target = pickNearest(targets, level);
    if (target) {
      if (joinTo(target.to, target.buffer ? [target.buffer] : [])) {
        ended = true;
        if (target.buffer) remove(target.buffer);
      }
    } else {
      const sw = switchSplice(trackDoc, endPt, level, fromAngle(lead.rot), 'merge', snapRadius);
      if (sw && joinTo(sw.branch, [], sw.splice)) {
        ended = true;
        apply(sw.splice, (i) => 'end:' + i);
      }
    }
  }
  /** True when `buf` overlaps no same-level track: the world, the ghost and the buffers so far. */
  const fits = (buf: PieceSpec): boolean => {
    const probe = '\u0000buffer';
    const d = new Doc({
      ...doc.layout,
      pieces: [
        ...world.values(),
        ...[...ghost, ...extra].map((s, i) => specToPiece(s, '\u0000ghost:' + i)),
        specToPiece(buf, probe),
      ],
    });
    return !d.graph.overlaps.some(([a, b]) => a === probe || b === probe);
  };

  // The end buffer at the lead; where it would overlap track (a red stroke stops just short of it),
  // drop unfrozen trailing pieces until it fits. If none fits down to `frozen`, the end stays open.
  if (!ended) {
    for (;;) {
      const buf = attachSpec('buffer', false, undefined, lead, level);
      if (fits(buf)) { extra.push(buf); break; }
      if (ghost.length <= frozen) break;
      lead = fitter.anchors[ghost.length - 1];
      ghost.pop();
    }
  }
  if (ghost.length === 0) return null;

  // 4. Buffer at an empty start, mating the first piece's connector at the start point; left out
  // (an open start) where it would overlap track.
  if (start.empty) {
    for (const s of ghost) {
      const i = pieceGeometry(s).connectors.findIndex((_, k) => dist(outPose(s, k), start.pos) < JOIN_POS_TOL);
      if (i < 0) continue;
      const c = pieceGeometry(s).connectors[i];
      const buf = attachSpec('buffer', false, undefined, outPose(s, i), s.level + c.levelOffset);
      if (fits(buf)) extra.push(buf);
      break;
    }
  }

  // 5. Merge straights; 6. raised straights over lower track become bridges.
  const merged = mergeStraights(ghost);
  const lower = [...world.values(), ...merged];
  const laid = merged.map((s) => {
    const bridge = s.type === 'straight-1' ? 'bridge-1' : s.type === 'straight-2' ? 'bridge-2' : null;
    if (!bridge || s.level < 1) return s;
    const ends = [outPose(s, 0), outPose(s, 1)];
    const over = lower.some((o) => o !== s && o.level < s.level
      && !pieceGeometry(o).connectors.some((_, k) => ends.some((e) => dist(outPose(o, k), e) < JOIN_POS_TOL))
      && shapesNear(routeShape(s), routeShape(o)));
    return over ? { ...s, type: bridge } : s;
  });

  // 7. One command.
  const pieces = [...added.values(), ...[...laid, ...extra].map((s) => specToPiece(s, newId()))];
  const gone = [...removed];
  const cmds = gone.length ? [deletePieces(gone), placePieces(pieces)] : [placePieces(pieces)];
  return withLifting(doc, gone, batch('Sketch', cmds));
}

