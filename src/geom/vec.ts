export interface Vec2 { x: number; y: number }
export interface Pose { x: number; y: number; rot: number }

const RAD = Math.PI / 180;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v: Vec2, k: number): Vec2 => ({ x: v.x * k, y: v.y * k });
export const len = (v: Vec2): number => Math.hypot(v.x, v.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));
export const fromAngle = (deg: number): Vec2 => ({ x: Math.cos(deg * RAD), y: Math.sin(deg * RAD) });

export function rotate(v: Vec2, deg: number): Vec2 {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Wrap an angle in degrees into (-180, 180]. */
export function normDeg(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  else if (r <= -180) r += 360;
  return r;
}

/** Absolute normalised difference between two angles, in [0, 180]. */
export const angleDiff = (a: number, b: number): number => Math.abs(normDeg(a - b));

/** Rotate `local` by the pose's rotation, then translate by the pose's position. */
export function applyPose(pose: Pose, local: Vec2): Vec2 {
  const r = rotate(local, pose.rot);
  return { x: r.x + pose.x, y: r.y + pose.y };
}

export function composePose(parent: Pose, local: Pose): Pose {
  const p = applyPose(parent, local);
  return { x: p.x, y: p.y, rot: parent.rot + local.rot };
}

export function invertPose(p: Pose): Pose {
  const t = rotate({ x: -p.x, y: -p.y }, -p.rot);
  return { x: t.x, y: t.y, rot: -p.rot };
}

export const approxEq = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
