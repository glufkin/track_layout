import { type Vec2, type Pose, applyPose, fromAngle, normDeg } from './vec';

export type Segment =
  | { kind: 'line'; from: Vec2; heading: number; length: number }
  | { kind: 'arc'; from: Vec2; heading: number; radius: number; sweep: number };

export type PathStep = { line: number } | { arc: { radius: number; sweep: number } };

export interface RoutePath { segments: Segment[]; length: number }

const RAD = Math.PI / 180;

const segLength = (s: Segment): number =>
  s.kind === 'line' ? s.length : s.radius * Math.abs(s.sweep) * RAD;

/** Position and heading reached `d` along a segment (0 <= d <= segLength). */
function segAt(s: Segment, d: number): { pos: Vec2; heading: number } {
  if (s.kind === 'line') {
    const u = fromAngle(s.heading);
    return { pos: { x: s.from.x + u.x * d, y: s.from.y + u.y * d }, heading: s.heading };
  }
  const sgn = s.sweep >= 0 ? 1 : -1;
  const turned = sgn * (d / s.radius) / RAD; // signed degrees turned
  const h0 = s.heading * RAD;
  const h1 = (s.heading + turned) * RAD;
  // centre lies to the right (+y side, for sgn > 0) of the start heading
  const cx = s.from.x - sgn * s.radius * Math.sin(h0);
  const cy = s.from.y + sgn * s.radius * Math.cos(h0);
  return {
    pos: { x: cx + sgn * s.radius * Math.sin(h1), y: cy - sgn * s.radius * Math.cos(h1) },
    heading: s.heading + turned,
  };
}

export function makePath(start: Vec2, heading: number, steps: PathStep[]): RoutePath {
  const segments: Segment[] = [];
  let pos = start, h = heading, length = 0;
  for (const step of steps) {
    const seg: Segment = 'line' in step
      ? { kind: 'line', from: pos, heading: h, length: step.line }
      : { kind: 'arc', from: pos, heading: h, radius: step.arc.radius, sweep: step.arc.sweep };
    const l = segLength(seg);
    const end = segAt(seg, l);
    segments.push(seg);
    length += l;
    pos = end.pos;
    h = end.heading;
  }
  return { segments, length };
}

export function samplePath(p: RoutePath, d: number): { pos: Vec2; heading: number } {
  const dd = Math.min(Math.max(d, 0), p.length);
  let rem = dd;
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    const l = segLength(s);
    if (rem <= l || i === p.segments.length - 1) return segAt(s, Math.min(rem, l));
    rem -= l;
  }
  throw new Error('samplePath: empty path');
}

export const pathEnd = (p: RoutePath): { pos: Vec2; heading: number } => samplePath(p, p.length);

export function transformPath(p: RoutePath, pose: Pose): RoutePath {
  const segments = p.segments.map((s): Segment => ({
    ...s,
    from: applyPose(pose, s.from),
    heading: normDeg(s.heading + pose.rot),
  }));
  return { segments, length: p.length };
}

/** Reflect across the x-axis: y -> -y, heading -> -heading, sweep -> -sweep. */
export function mirrorPath(p: RoutePath): RoutePath {
  const segments = p.segments.map((s): Segment => {
    const from = { x: s.from.x, y: -s.from.y };
    return s.kind === 'line'
      ? { ...s, from, heading: -s.heading }
      : { ...s, from, heading: -s.heading, sweep: -s.sweep };
  });
  return { segments, length: p.length };
}
