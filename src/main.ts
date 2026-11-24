// TEMPORARY demo for the renderer (Task 11). Task 13 replaces this file with the real App.
import type { Pose } from './geom/vec';
import { applyPose } from './geom/vec';
import { pieceConnectors } from './track/catalog';
import { worldConnectors, worldFootprint } from './track/graph';
import { Doc } from './model/doc';
import { emptyLayout, type Piece, type Train } from './model/types';
import { render, liftedCarPoses, type Overlay } from './render/renderer';
import { defaultCamera, fitBounds } from './render/camera';

const pieces: Piece[] = [];
let nextId = 1;

/** Place `type` so its connector `enter` mates with `at` (`at.rot` points into the new piece). */
function place(at: Pose, type: string, o: { enter?: number; flipped?: boolean; level?: number; id?: string } = {}): Piece {
  const flipped = o.flipped ?? false;
  const e = pieceConnectors(type, flipped)[o.enter ?? 0];
  const rot = at.rot + 180 - e.heading;
  const off = applyPose({ x: 0, y: 0, rot }, e.pos);
  const p: Piece = { id: o.id ?? 'p' + nextId++, type, x: at.x - off.x, y: at.y - off.y, rot, level: o.level ?? 0, flipped };
  if (type.startsWith('switch')) p.switch = { mode: 'manual', state: 0 };
  pieces.push(p);
  return p;
}
const out = (p: Piece, i: number): Pose => {
  const c = worldConnectors(p)[i];
  return { x: c.pos.x, y: c.pos.y, rot: c.heading };
};
type Step = [string, { enter?: number; exit?: number; flipped?: boolean; level?: number; id?: string }?];
function run(start: Pose, steps: Step[]): Piece[] {
  let at = start;
  return steps.map(([type, o = {}]) => {
    const p = place(at, type, o);
    at = out(p, o.exit ?? 1);
    return p;
  });
}

// Oval: top run east (with a tunnel), right-hand turns, bottom run west with a passing loop.
const curves: Step[] = [0, 1, 2, 3].map(() => ['curve-m-45']);
const oval = run({ x: 0, y: 0, rot: 0 }, [
  ['straight-2', { id: 'top1' }], ['straight-2'], ['tunnel-2', { id: 'tun' }], ...curves,
  ['switch', { flipped: true, id: 'swA' }], ['straight-1'], ['straight-2'], ['straight-1'],
  ['switch', { enter: 1, exit: 0, id: 'swB' }], ...curves,
]);
const swA = oval.find((p) => p.id === 'swA')!;
swA.switch!.state = 1;
run(out(swA, 2), [['curve-m-45'], ['straight-2'], ['curve-m-45']]);

// A ramped bridge crossing the oval north-south, with buffer stops at the feet.
run({ x: 3, y: 6.9, rot: 90 }, [['buffer', { exit: 0 }]]);
run({ x: 3, y: 6.9, rot: -90 }, [
  ['ramp-2'], ['bridge-2', { level: 1, id: 'br1' }], ['bridge-2', { level: 1 }], ['bridge-2', { level: 1 }],
  ['ramp-2', { enter: 1, exit: 0 }], ['buffer', { exit: 0 }],
]);

const train = (id: string, color: string, cars: number, head: Train['head'], lifted: Pose | null = null): Train => ({
  id, cars, color, speed: 1, running: false, head, lifted, currentSpeed: 0, crashed: false, crashAt: null,
});
const doc = new Doc({
  ...emptyLayout(),
  pieces,
  trains: [
    train('t1', '#d33c2f', 3, { pieceId: 'tun', route: 0, dist: 0.9, dir: 1 }),
    train('t2', '#2f6fd3', 2, { pieceId: 'br1', route: 0, dist: 1.6, dir: 1 }),
    train('t3', '#2a9d4b', 2, null, { x: 10, y: 1.5, rot: 90 }),
  ],
});

const params = new URLSearchParams(location.search);
const overlay: Overlay = { selectedPieces: new Set(), showConnectors: false };
if (params.has('overlays')) {
  overlay.selectedPieces = new Set(['top1']);
  overlay.selectedTrain = 't2';
  overlay.showConnectors = true;
  overlay.ghost = { piece: { id: 'g', type: 'curve-m-45', x: -3, y: 1, rot: 0, level: 0, flipped: false }, valid: false };
  overlay.ghostTrain = liftedCarPoses({ x: -2, y: 4.5, rot: 0 }, 1);
  doc.layout.trains[0].crashed = true;
  doc.layout.trains[0].crashAt = { x: 5, y: 0 };
  doc.layout.pieces.push({ id: 'near', type: 'straight-1', x: -1.05, y: 0.1, rot: 180, level: 0, flipped: false });
  doc.layout.pieces.push({ id: 'over', type: 'straight-1', x: 0.5, y: 1, rot: 90, level: 0, flipped: false });
  doc.rebuild();
}
console.log('demo graph', JSON.stringify({
  pieces: doc.layout.pieces.length, joins: doc.graph.joins.size / 2, open: doc.graph.open.length,
  nearMisses: doc.graph.nearMisses.length, overlaps: doc.graph.overlaps,
}));

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
document.body.style.margin = '0';
(document.getElementById('app') ?? document.body).replaceChildren(canvas);
const ctx = canvas.getContext('2d')!;

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const size = { x: window.innerWidth, y: window.innerHeight };
  canvas.width = Math.round(size.x * dpr);
  canvas.height = Math.round(size.y * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  for (const p of doc.layout.pieces) for (const poly of worldFootprint(p)) for (const v of poly) {
    min = { x: Math.min(min.x, v.x), y: Math.min(min.y, v.y) };
    max = { x: Math.max(max.x, v.x), y: Math.max(max.y, v.y) };
  }
  render(ctx, doc, fitBounds(defaultCamera(), size, min, max), size, overlay, 'wooden');
}
draw();
window.addEventListener('resize', draw);
