import { type Pose, type Vec2, dist, angleDiff, fromAngle, sub } from '../geom/vec';
import { type FlexParams, R_S, FLEX_LIMITS, validFlex } from '../track/catalog';
import { JOIN_POS_TOL, JOIN_ANGLE_TOL } from '../track/graph';
import { type PieceSpec, attachSpec, chainEnd } from './spec';

export const JOIN_MAX_PIECES = 8;

const RAD = Math.PI / 180;
const EPS = 1e-9;
/** Slack (degrees) when deciding how many 45° pieces an arc needs. */
const SNAP = 1e-6;
/** Catalogue straights, largest first, used to fill a straight-ahead gap. */
const STRAIGHTS: Array<[string, number]> = [['straight-2', 2], ['straight-1', 1], ['straight-1-2', 0.5], ['straight-1-4', 0.25]];
/** An arc flatter than this (with a radius beyond the flex limit) is laid as a flex straight. */
const FLAT_SWEEP = 0.5;
const MAX_ARC_SWEEP = FLEX_LIMITS.maxSweep;
/** Tangent-length ratios d2/d1 tried for the biarc, equal lengths first. */
const RATIOS = [1, 2 / 3, 3 / 2, 1 / 2, 2, 1 / 3, 3, 1 / 5, 5];

type Part = { type: string; flipped: boolean; flex?: FlexParams };

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

/** Lay `parts` one after another from `from`; null unless the chain mates with `to` within the join tolerances. */
function layChain(parts: Part[], from: Pose, to: Pose, level: number): PieceSpec[] | null {
  if (parts.length === 0 || parts.length > JOIN_MAX_PIECES) return null;
  if (parts.some((p) => p.flex && !validFlex(p.type, p.flex))) return null;
  const chain: PieceSpec[] = [];
  let at = from;
  for (const p of parts) {
    const s = attachSpec(p.type, p.flipped, p.flex, at, level);
    chain.push(s);
    at = chainEnd(chain);
  }
  return dist(at, to) < JOIN_POS_TOL && angleDiff(at.rot, to.rot + 180) < JOIN_ANGLE_TOL ? chain : null;
}

/** Step 1: `to` dead ahead, closed with catalogue straights plus at most one flex straight. */
function straightAhead(from: Pose, to: Pose, level: number): PieceSpec[] | null {
  const t = fromAngle(from.rot), v = sub(to, from);
  if (Math.abs(cross(t, v)) >= JOIN_POS_TOL || angleDiff(to.rot, from.rot + 180) >= JOIN_ANGLE_TOL) return null;
  const ahead = dot(t, v);
  if (ahead < FLEX_LIMITS.minLength - EPS) return null;
  const parts: Part[] = [];
  let rem = ahead;
  for (const [type, len] of STRAIGHTS) {
    while (rem >= len - EPS && parts.length <= JOIN_MAX_PIECES) { parts.push({ type, flipped: false }); rem -= len; }
  }
  if (rem > EPS) {
    // A remainder of (about) 0.05 or more is its own flex straight; a smaller one is folded into the last straight.
    if (rem > FLEX_LIMITS.minLength + EPS || parts.length === 0) {
      parts.push({ type: 'flex-straight', flipped: false, flex: { length: rem } });
    } else {
      const last = STRAIGHTS.find(([type]) => type === parts[parts.length - 1].type)![1];
      parts[parts.length - 1] = { type: 'flex-straight', flipped: false, flex: { length: last + rem } };
    }
  }
  return layChain(parts, from, to, level);
}

/**
 * Pieces for one circular arc leaving `a` along heading `h` and ending at `b`, or null when it
 * breaks the flex limits. A very flat, large arc becomes flex straight(s); a long one is split
 * into equal flex curves of at most 45°.
 */
function arcParts(a: Vec2, h: number, b: Vec2): Part[] | null {
  const w = sub(b, a), chord = Math.hypot(w.x, w.y);
  if (chord < EPS) return [];
  const t = fromAngle(h);
  const sweep = (2 * Math.atan2(cross(t, w), dot(t, w))) / RAD; // signed, positive = right turn
  const abs = Math.abs(sweep);
  const radius = abs < EPS ? Infinity : chord / (2 * Math.sin((abs * RAD) / 2));
  if (radius > FLEX_LIMITS.maxRadius) {
    if (abs >= FLAT_SWEEP) return null;
    const n = Math.ceil(chord / FLEX_LIMITS.maxLength - EPS);
    return Array.from({ length: n }, () => ({ type: 'flex-straight', flipped: false, flex: { length: chord / n } }));
  }
  if (radius < R_S - EPS) return null;
  // Rounding may leave a sweep a hair over 45° (or a radius a hair under R_S): clamp it; the laid chain is checked anyway.
  const n = Math.max(1, Math.ceil((abs - SNAP) / MAX_ARC_SWEEP));
  const r = Math.max(radius, R_S), each = Math.min(abs / n, MAX_ARC_SWEEP);
  return Array.from({ length: n }, () => ({ type: 'flex-curve', flipped: sweep < 0, flex: { radius: r, sweep: each } }));
}

/** Flex straight(s) of total length `len` (each ≤ 4U); [] for nothing, null when too short to lay. */
function straightParts(len: number): Part[] | null {
  if (len < EPS) return [];
  if (len < FLEX_LIMITS.minLength) return null;
  const n = Math.ceil(len / FLEX_LIMITS.maxLength - EPS);
  return Array.from({ length: n }, () => ({ type: 'flex-straight', flipped: false, flex: { length: len / n } }));
}

/**
 * Biarc from `p0` (travel heading h0) to `p1` (arriving with travel heading h1), tangent lengths
 * d1 = d and d2 = k·d. The junction lies on the segment Q0 = p0 + d1·t0 → Q1 = p1 − d2·t1.
 */
function biarcParts(p0: Vec2, h0: number, p1: Vec2, h1: number, k: number): Part[] | null {
  const t0 = fromAngle(h0), t1 = fromAngle(h1);
  const v = sub(p1, p0), vv = dot(v, v), c = dot(t0, t1);
  if (vv < EPS * EPS) return angleDiff(h0, h1) < EPS ? [] : null;
  // |v − d(t0 + k·t1)| = d(1 + k)  →  2k(c − 1)·d² − 2·v·(t0 + k·t1)·d + v·v = 0
  const tk = { x: t0.x + k * t1.x, y: t0.y + k * t1.y };
  const qa = 2 * k * (c - 1), qb = -2 * dot(v, tk);
  let d: number;
  if (Math.abs(qa) < 1e-12) {
    if (qb >= 0) return null;
    d = -vv / qb;
  } else {
    d = (-qb - Math.sqrt(qb * qb - 4 * qa * vv)) / (2 * qa); // qa < 0 and v·v > 0: the one positive root
  }
  if (!Number.isFinite(d) || d <= EPS) return null;
  const d2 = k * d;
  const q0 = { x: p0.x + d * t0.x, y: p0.y + d * t0.y };
  const q1 = { x: p1.x - d2 * t1.x, y: p1.y - d2 * t1.y };
  const f = d / (d + d2);
  const j = { x: q0.x + (q1.x - q0.x) * f, y: q0.y + (q1.y - q0.y) * f };
  const first = arcParts(p0, h0, j);
  const second = first && arcParts(j, Math.atan2(q1.y - q0.y, q1.x - q0.x) / RAD, p1);
  return first && second ? [...first, ...second] : null;
}

/**
 * One arc filleting the corner where the start ray meets the (backwards) end ray, with a flex
 * straight before or after it: exact for any turn whose rays cross ahead of both ends.
 */
function filletParts(p0: Vec2, h0: number, p1: Vec2, h1: number): Part[] | null {
  const t0 = fromAngle(h0), t1 = fromAngle(h1), v = sub(p1, p0);
  const den = cross(t0, t1);
  if (Math.abs(den) < 1e-6) return null;
  const a = cross(v, t1) / den, b = cross(t0, v) / den; // p0 + a·t0 = p1 − b·t1
  if (a < 0 || b < 0) return null;
  const m = Math.min(a, b);
  const corner = { x: p0.x + a * t0.x, y: p0.y + a * t0.y };
  const arcStart = { x: corner.x - m * t0.x, y: corner.y - m * t0.y };
  const arcEnd = { x: corner.x + m * t1.x, y: corner.y + m * t1.y };
  const lead = straightParts(a - m), arc = lead && arcParts(arcStart, h0, arcEnd), tail = arc && straightParts(b - m);
  return lead && arc && tail ? [...lead, ...arc, ...tail] : null;
}

/** Fractions of half the gap given to equal lead-in and lead-out straights around a padded biarc. */
const PADS = [0.5, 0.75, 0.9];

/**
 * Step 2: biarcs. Equal tangent lengths first, then the ratio search; then (still a biarc, plus
 * flex straights) a single filleted arc, and biarcs padded with straights at both ends, which
 * reach the flat S-bends and gentle turns a bare biarc can only do with radii beyond 8U.
 */
function biarc(from: Pose, to: Pose, level: number): PieceSpec[] | null {
  const h0 = from.rot, h1 = to.rot + 180; // travel headings at both ends
  const p0: Vec2 = from, p1: Vec2 = to;
  const tryParts = (parts: Part[] | null): PieceSpec[] | null => (parts ? layChain(parts, from, to, level) : null);
  for (const k of RATIOS) {
    const chain = tryParts(biarcParts(p0, h0, p1, h1, k));
    if (chain) return chain;
  }
  const fillet = tryParts(filletParts(p0, h0, p1, h1));
  if (fillet) return fillet;
  const t0 = fromAngle(h0), t1 = fromAngle(h1), half = dist(p0, p1) / 2;
  for (const f of PADS) {
    const s = f * half;
    const a = { x: p0.x + s * t0.x, y: p0.y + s * t0.y }, b = { x: p1.x - s * t1.x, y: p1.y - s * t1.y };
    const pad = straightParts(s);
    if (!pad) continue;
    for (const k of RATIOS) {
      const mid = biarcParts(a, h0, b, h1, k);
      const chain = mid && tryParts([...pad, ...mid, ...pad]);
      if (chain) return chain;
    }
  }
  return null;
}

/**
 * A chain of pieces whose first piece enters at the outward pose `from` and whose last exit mates
 * with the outward pose `to` (same position, opposite heading) within the v1 join tolerances, or
 * null when none exists within FLEX_LIMITS and JOIN_MAX_PIECES pieces.
 */
export function solveJoin(from: Pose, to: Pose, level: number): PieceSpec[] | null {
  if (dist(from, to) < EPS) return null;
  return straightAhead(from, to, level) ?? biarc(from, to, level);
}
