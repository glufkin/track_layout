import { type Pose, type Vec2, angleDiff, dist, fromAngle, normDeg } from '../geom/vec';
import type { Doc } from '../model/doc';
import type { Piece } from '../model/types';
import { FLEX_LIMITS, pieceGeometry } from '../track/catalog';
import { JOIN_ANGLE_TOL, JOIN_POS_TOL, connKey, worldConnectors } from '../track/graph';
import { type PieceSpec, attachSpec, outPose } from './spec';

/** A pure edit: piece ids to remove and new pieces to add. Applying it is the caller's job. */
export interface Splice { remove: string[]; add: PieceSpec[] }

/** Plain straight track: catalogue `straight-*` and `flex-straight`. Never bridges, tunnels or ramps. */
export function isPlainStraight(type: string): boolean {
  return type.startsWith('straight-') || type === 'flex-straight';
}

const EPS = 1e-6;
const MIN_FLEX = FLEX_LIMITS.minLength;
const FILL_LENGTHS: Array<[string, number]> = [['straight-2', 2], ['straight-1', 1], ['straight-1-2', 0.5], ['straight-1-4', 0.25]];
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/**
 * Straight pieces covering exactly `g`: catalogue straights largest first, then one flex remainder
 * of at least MIN_FLEX. A smaller remainder is folded into the last catalogue piece as flex. Returns
 * null when `g` is positive but shorter than MIN_FLEX.
 */
function fillLengths(g: number): Array<{ type: string; length: number }> | null {
  if (g < EPS) return [];
  const out: Array<{ type: string; length: number }> = [];
  let r = g;
  for (const [type, l] of FILL_LENGTHS) {
    while (r >= l - EPS) { out.push({ type, length: l }); r -= l; }
  }
  if (r < EPS) return out;
  // Strict: a flex shorter than MIN_FLEX by rounding would fail validFlex.
  if (r >= MIN_FLEX) { out.push({ type: 'flex-straight', length: r }); return out; }
  const last = out.pop();
  if (!last) return null;
  out.push({ type: 'flex-straight', length: last.length + r });
  return out;
}

/** Lay straights covering `g` from outward pose `at` (heading = direction of travel), at `level`. */
function layStraights(at: Pose, g: number, level: number): PieceSpec[] | null {
  const parts = fillLengths(g);
  return parts && layParts(parts, at, level);
}

/** Lay straights of the given types and lengths end to end from outward pose `at`. */
function layParts(parts: Array<{ type: string; length: number }>, at: Pose, level: number): PieceSpec[] {
  const out: PieceSpec[] = [];
  for (const p of parts) {
    const spec = attachSpec(p.type, false, p.type === 'flex-straight' ? { length: p.length } : undefined, at, level);
    out.push(spec);
    at = outPose(spec, 1);
  }
  return out;
}

/** One piece of a run: its span [s0, s1] along the run and the connectors at each end. */
interface RunPiece { piece: Piece; s0: number; s1: number; back: number; fwd: number }
/** A maximal chain of collinear plain straights joined end to end at one level, heading `rot` from `origin`. */
interface Run { pieces: RunPiece[]; origin: Vec2; rot: number; length: number; level: number }

const isRunPiece = (p: Piece | undefined, level: number): p is Piece =>
  !!p && isPlainStraight(p.type) && p.level === level && pieceGeometry(p).connectors.length === 2;

/** The run of joined plain straights through `start`, oriented along its connector 0 → 1. */
function collectRun(doc: Doc, start: Piece): Run {
  const level = start.level;
  const seen = new Set([start.id]);
  const walk = (p: Piece, exit: number): Array<{ piece: Piece; enter: number }> => {
    const out: Array<{ piece: Piece; enter: number }> = [];
    for (;;) {
      const mate = doc.graph.joins.get(connKey(p.id, exit));
      const q = mate && doc.piece(mate.pieceId);
      if (!mate || !isRunPiece(q, level) || seen.has(q.id)) return out;
      seen.add(q.id);
      out.push({ piece: q, enter: mate.index });
      p = q;
      exit = 1 - mate.index;
    }
  };
  const ahead = walk(start, 1);
  const behind = walk(start, 0);
  const ordered = [
    ...behind.reverse().map(({ piece, enter }) => ({ piece, back: 1 - enter })),
    { piece: start, back: 0 },
    ...ahead.map(({ piece, enter }) => ({ piece, back: enter })),
  ];
  const sc = worldConnectors(start);
  const rot = normDeg(sc[1].heading);
  const u = fromAngle(rot);
  const origin = worldConnectors(ordered[0].piece)[ordered[0].back].pos;
  const pieces = ordered.map(({ piece, back }) => {
    const wc = worldConnectors(piece);
    const fwd = 1 - back;
    const s0 = dot({ x: wc[back].pos.x - origin.x, y: wc[back].pos.y - origin.y }, u);
    const s1 = dot({ x: wc[fwd].pos.x - origin.x, y: wc[fwd].pos.y - origin.y }, u);
    return { piece, s0, s1, back, fwd };
  });
  return { pieces, origin, rot, length: pieces[pieces.length - 1].s1, level };
}

/**
 * Cut a span of width `w` centred near `c` out of the run and refill around an element. `place`
 * builds the element given the outward pose at the span's start (heading along the run); it returns
 * the element spec and the connector at the span's end. The centre is shifted along the run so the
 * span fits and no gap below MIN_FLEX is left at a run end; null when the run is too short.
 */
function cutRun(run: Run, c: number, w: number, place: (at: Pose) => { spec: PieceSpec; far: number }):
  { splice: Splice; element: PieceSpec } | null {
  const { pieces, length } = run;
  if (length < w - EPS) return null;
  const n = pieces.length;
  const clamp = (v: number) => Math.min(Math.max(v, w / 2), length - w / 2);
  const small = (g: number) => g > EPS && g < MIN_FLEX;
  c = clamp(c);
  let i = 0, j = n - 1, gL = 0, gR = 0;
  const span = () => {
    const lo = c - w / 2, hi = c + w / 2;
    i = pieces.findIndex((p) => p.s1 > lo + EPS);
    j = n - 1;
    while (j > i && pieces[j].s0 >= hi - EPS) j--;
    gL = lo - pieces[i].s0;
    gR = pieces[j].s1 - hi;
  };
  for (let k = 0; k < 4; k++) {
    span();
    if (small(gL) && i === 0) c = clamp(c - gL);
    else if (small(gR) && j === n - 1) c = clamp(c + gR);
    else break;
  }
  span();
  while (small(gL) && i > 0) { i--; gL += pieces[i].s1 - pieces[i].s0; }
  while (small(gR) && j < n - 1) { j++; gR += pieces[j].s1 - pieces[j].s0; }
  if (small(gL) || small(gR)) return null;

  const first = pieces[i];
  const startPos = worldConnectors(first.piece)[first.back].pos;
  const left = layStraights({ ...startPos, rot: run.rot }, gL, run.level);
  if (!left) return null;
  const at: Pose = left.length ? outPose(left[left.length - 1], 1) : { ...startPos, rot: run.rot };
  const { spec, far } = place(at);
  const right = layStraights(outPose(spec, far), gR, run.level);
  if (!right) return null;
  return {
    splice: { remove: pieces.slice(i, j + 1).map((p) => p.piece.id), add: [...left, spec, ...right] },
    element: spec,
  };
}

/** Run position of world point `pt` (projection onto the run's line). */
const runPos = (run: Run, pt: Vec2): number =>
  dot({ x: pt.x - run.origin.x, y: pt.y - run.origin.y }, fromAngle(run.rot));

/** Nearest point on any plain straight at `level` within `radius` of `pt`. */
function nearestStraight(doc: Doc, pt: Vec2, level: number, radius: number): { piece: Piece; pos: Vec2 } | null {
  let best: { piece: Piece; pos: Vec2; d: number } | null = null;
  for (const p of doc.layout.pieces) {
    if (!isRunPiece(p, level)) continue;
    const [a, b] = worldConnectors(p).map((c) => c.pos);
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const t = Math.min(1, Math.max(0, dot({ x: pt.x - a.x, y: pt.y - a.y }, ab) / dot(ab, ab)));
    const pos = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(pos, pt);
    if (d <= radius && (!best || d < best.d)) best = { piece: p, pos, d };
  }
  return best && { piece: best.piece, pos: best.pos };
}

/**
 * Turn plain straight track near `pt` into a 1U switch (spec §5.7). The switch is centred on the
 * nearest point within `snapRadius`, shifted along the run of joined straights if needed, and the
 * rest of the removed span is refilled. Of the four ways the switch can sit, the one whose branch
 * points most nearly along `strokeDir` ('diverge') or against it ('merge') is chosen, so the branch
 * is on the stroke's side and, diverging, the entry faces against the stroke's along-track direction.
 * `branch` is the outward pose of the switch's branch connector (2).
 */
export function switchSplice(
  doc: Doc, pt: Vec2, level: number, strokeDir: Vec2, mode: 'diverge' | 'merge', snapRadius: number,
): { splice: Splice; branch: Pose } | null {
  const hit = nearestStraight(doc, pt, level, snapRadius);
  if (!hit) return null;
  const run = collectRun(doc, hit.piece);
  const strokeRot = (Math.atan2(strokeDir.y, strokeDir.x) * 180) / Math.PI;
  const target = mode === 'diverge' ? strokeRot : strokeRot + 180;
  // Branch heading relative to the switch's local +x is ±45; local +x is along the run or against it.
  let best: { reversed: boolean; flipped: boolean; err: number } | null = null;
  for (const reversed of [false, true]) {
    for (const flipped of [false, true]) {
      const err = angleDiff(run.rot + (reversed ? 180 : 0) + (flipped ? -45 : 45), target);
      if (!best || err < best.err - EPS) best = { reversed, flipped, err };
    }
  }
  const { reversed, flipped } = best!;
  const cut = cutRun(run, runPos(run, hit.pos), 1, (at) => {
    if (!reversed) return { spec: withSwitch(attachSpec('switch', flipped, undefined, at, level, 0)), far: 1 };
    // Reversed: the switch's through connector 1 meets the span start, its entry the span end.
    return { spec: withSwitch(attachSpec('switch', flipped, undefined, at, level, 1)), far: 0 };
  });
  if (!cut) return null;
  return { splice: cut.splice, branch: outPose(cut.element, 2) };
}

const withSwitch = (s: PieceSpec): PieceSpec => ({ ...s, switch: { mode: 'manual', state: 0 } });

/** Route connectors [from, to] of each crossover route. */
const CROSS_ROUTES: Array<[number, number]> = [[0, 1], [2, 3]];

/**
 * Insert a crossover into the plain straight `pieceId` at `at` for a stroke heading `strokeHeading`
 * (spec §5.8): `crossover-90` when the acute angle between stroke and track is nearer 90° than 45°
 * (≥ 67.5°), else `crossover-45`. One route lies along the existing track (route 1 for a 45° crossing
 * leaning the other way, since crossover-45 cannot flip); the rest of the run is refilled. `entry` is
 * the crossing route's connector the stroke arrives at, `exit` the opposite one.
 */
export function crossingSplice(doc: Doc, pieceId: string, at: Vec2, strokeHeading: number):
  { splice: Splice; entry: Pose; exit: Pose; type: 'crossover-90' | 'crossover-45' } | null {
  const piece = doc.piece(pieceId);
  if (!piece || !isRunPiece(piece, piece.level)) return null;
  const run = collectRun(doc, piece);
  const rel = ((normDeg(strokeHeading - run.rot) % 180) + 180) % 180;
  const acute = Math.min(rel, 180 - rel);
  const type = acute >= 67.5 ? 'crossover-90' : 'crossover-45';
  // crossover-45's route 1 leans +45° from route 0: put route 1 on the track when the stroke leans −45°.
  const trackRoute = type === 'crossover-45' && rel >= 90 ? 1 : 0;
  const [from, to] = CROSS_ROUTES[trackRoute];
  const w = pieceGeometry({ type, flipped: false }).routes[trackRoute].path.length;
  const cut = cutRun(run, runPos(run, at), w, (pose) =>
    ({ spec: attachSpec(type, false, undefined, pose, run.level, from), far: to }));
  if (!cut) return null;
  const [c0, c1] = CROSS_ROUTES[1 - trackRoute].map((i) => outPose(cut.element, i));
  const arrive = normDeg(strokeHeading + 180);
  const [entry, exit] = angleDiff(c0.rot, arrive) <= angleDiff(c1.rot, arrive) ? [c0, c1] : [c1, c0];
  return { splice: cut.splice, entry, exit, type };
}

const straightLength = (s: PieceSpec): number => pieceGeometry(s).routes[0].path.length;

/**
 * Re-lay a run of straights of total length `total` from outward pose `at`: the catalogue pieces'
 * length as the fewest catalogue straights, largest first, then the flex length (plus any catalogue
 * remainder, from diagonals) as one flex straight; a remainder below MIN_FLEX is folded into the
 * last catalogue straight as flex. The last piece ends exactly `total` from `at`.
 */
function mergeRun(group: PieceSpec[], at: Pose, total: number): PieceSpec[] | null {
  const flexLen = group.filter((s) => s.type === 'flex-straight').reduce((t, s) => t + straightLength(s), 0);
  const parts: Array<{ type: string; length: number }> = [];
  let r = total - flexLen;
  for (const [type, l] of FILL_LENGTHS) {
    while (r >= l - EPS) { parts.push({ type, length: l }); r -= l; }
  }
  const rest = r + flexLen;
  if (rest > FLEX_LIMITS.maxLength) {
    const more = fillLengths(rest);
    if (!more) return null;
    parts.push(...more);
  } else if (rest >= MIN_FLEX) {
    parts.push({ type: 'flex-straight', length: rest });
  } else if (rest > EPS) {
    const last = parts.pop();
    if (!last) return null;
    parts.push({ type: 'flex-straight', length: last.length + rest });
  }
  return layParts(parts, at, group[0].level);
}

/** Both world ends of a straight spec: positions and outward headings. */
const ends = (s: PieceSpec): [Pose, Pose] => [outPose(s, 0), outPose(s, 1)];

/** If `b` continues straight on from `a` (joined end to end, collinear, same level), b's end that meets a. */
function continues(a: PieceSpec, b: PieceSpec, aExit: number): number | null {
  if (a.level !== b.level) return null;
  const ea = ends(a)[aExit];
  const eb = ends(b);
  for (const k of [0, 1]) {
    if (dist(ea, eb[k]) <= JOIN_POS_TOL && 180 - angleDiff(ea.rot, eb[k].rot) <= JOIN_ANGLE_TOL) return k;
  }
  return null;
}

/**
 * Merge each run of consecutive, collinear plain straights joined end to end at one level into the
 * fewest catalogue straights (2, 1, ½, ¼, largest first) plus at most one flex remainder ≥ 0.05; the
 * run's outer ends keep their poses. A run is kept as it is when merging would not reduce its piece
 * count (a single straight, or diagonal straights). Other specs pass through unchanged.
 */
export function mergeStraights(specs: PieceSpec[]): PieceSpec[] {
  const out: PieceSpec[] = [];
  let i = 0;
  while (i < specs.length) {
    if (!isPlainStraight(specs[i].type)) { out.push(specs[i]); i++; continue; }
    // Which end of the first piece leads on: the one the next straight meets (default 1).
    let exit = 1;
    const next = specs[i + 1];
    if (next && isPlainStraight(next.type) && continues(specs[i], next, 1) === null && continues(specs[i], next, 0) !== null) exit = 0;
    const start = ends(specs[i])[1 - exit];
    let j = i;
    while (j + 1 < specs.length && isPlainStraight(specs[j + 1].type)) {
      const k = continues(specs[j], specs[j + 1], exit);
      if (k === null) break;
      exit = 1 - k;
      j++;
    }
    const group = specs.slice(i, j + 1);
    const merged = mergeRun(group, { x: start.x, y: start.y, rot: normDeg(start.rot + 180) }, dist(start, ends(specs[j])[exit]));
    out.push(...(merged && merged.length <= group.length ? merged : group));
    i = j + 1;
  }
  return out;
}
