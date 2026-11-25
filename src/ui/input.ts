import { type Pose, type Vec2, dist, normDeg, rotate, sub } from '../geom/vec';
import { samplePath } from '../geom/path';
import { Doc } from '../model/doc';
import type { Piece, TrackPos, Train } from '../model/types';
import { getPieceDef, pieceGeometry } from '../track/catalog';
import { type WorldConnector, connKey, worldFootprint, worldRoutePath } from '../track/graph';
import { computeGhost, posesAfterGroup, snapGroup, ROT_STEP, type GhostResult } from '../editor/snapping';
import {
  canPlaceTrain, deletePieces, deleteTrains, moveTrain, placePieces, placeTrain, transformPieces, withLifting,
} from '../editor/commands';
import { carPoses, CAR_WIDTH, type CarPose } from '../sim/motion';
import { screenToWorld, zoomAt } from '../render/camera';
import { liftedCarPoses } from '../render/renderer';
import type { App } from './app';

export type Mode =
  | { kind: 'select' }
  | { kind: 'place'; type: string; flipped: boolean; attachIndex: number; freeRot: number; prefer?: WorldConnector }
  | { kind: 'placeTrain'; cars: number; dir: 1 | -1 };

/** Connector snap radius in CSS pixels (divided by zoom to get world units). */
export const SNAP_PX = 12;
/** Pointer travel (CSS px) before a press becomes a drag. */
export const DRAG_PX = 4;
/** Zoom factor per wheel delta unit. */
const WHEEL_ZOOM = 0.0015;
/** New trains take these colours in turn. */
export const TRAIN_COLORS = ['#c0392b', '#2f6fd3', '#2a9d4b', '#e1a100', '#8e44ad', '#16a2a2', '#e67e22', '#34495e'];
export const NEW_TRAIN_SPEED = 1.5;
/** Sampling step (U) when finding the nearest point on a route. */
const ROUTE_SAMPLE = 0.02;

type Drag =
  | { kind: 'pan'; last: Vec2 }
  | { kind: 'press'; start: Vec2; hit: string | null; shift: boolean }
  | { kind: 'move'; ids: string[]; start: Vec2; pivot: Vec2; poses: Map<string, Pose> }
  | { kind: 'box'; start: Vec2; shift: boolean };

const isTextTarget = (t: EventTarget | null): boolean =>
  t instanceof Element && (t.matches('input, select, textarea') || (t as HTMLElement).isContentEditable);

/** Ray-casting point-in-polygon. */
function inPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function inCar(pt: Vec2, c: CarPose): boolean {
  const l = rotate(sub(pt, c.center), -c.heading);
  return Math.abs(l.x) <= c.length / 2 && Math.abs(l.y) <= CAR_WIDTH / 2;
}

/** The track position nearest `pt` within `maxDist`, if any (higher levels win ties). */
export function nearestTrackPos(doc: Doc, pt: Vec2, maxDist: number, dir: 1 | -1): TrackPos | null {
  let best: { pos: TrackPos; d: number; level: number } | null = null;
  for (const p of doc.layout.pieces) {
    const routes = pieceGeometry(p).routes;
    for (let r = 0; r < routes.length; r++) {
      const path = worldRoutePath(p, r);
      const n = Math.max(1, Math.ceil(path.length / ROUTE_SAMPLE));
      for (let i = 0; i <= n; i++) {
        const s = (path.length * i) / n;
        const d = dist(samplePath(path, s).pos, pt);
        if (d > maxDist) continue;
        if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && p.level > best.level)) {
          best = { pos: { pieceId: p.id, route: r, dist: s, dir }, d, level: p.level };
        }
      }
    }
  }
  return best?.pos ?? null;
}

/** Pointer, wheel and keyboard handling for the canvas (spec §5.3, §5.10). */
export class Input {
  private _mode: Mode = { kind: 'select' };
  /** Last pointer position over the canvas, in CSS px; null when outside. */
  private cursor: Vec2 | null = null;
  private alt = false;
  private space = false;
  private drag: Drag | null = null;
  /** After a keep-placing click, the ghost stays on `prefer` until the pointer moves away from here. */
  private stickAt: Vec2 | null = null;
  private disposers: Array<() => void> = [];

  constructor(private app: App, private canvas: HTMLCanvasElement) {
    const on = (t: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const ptr = (e: PointerEvent | MouseEvent): void => this.handlePointer(e as PointerEvent);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'dblclick', 'contextmenu']) {
      on(canvas, type, ptr);
    }
    on(canvas, 'wheel', (e: WheelEvent) => this.handleWheel(e), { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => this.handleKey(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.handleKey(e));
    on(window, 'blur', () => { this.alt = false; this.space = false; });
  }

  dispose(): void { for (const d of this.disposers) d(); this.disposers = []; }

  get mode(): Mode { return this._mode; }
  set mode(m: Mode) { this.setMode(m); }

  setMode(m: Mode): void {
    this._mode = m;
    this.stickAt = null;
    if (this.drag?.kind !== 'pan') this.drag = null;
    this.app.preview = null;
    this.app.box = null;
    this.refresh();
    this.app.notify();
  }

  /** Forget the keep-placing pin (after undo/redo it may name a piece that no longer exists). */
  clearPin(): void {
    this.stickAt = null;
    if (this._mode.kind === 'place' && this._mode.prefer) this._mode = { ...this._mode, prefer: undefined };
    this.refresh();
  }

  // ---- helpers ----

  private size(): Vec2 { return this.app.viewSize(); }
  private toWorld(s: Vec2): Vec2 { return screenToWorld(this.app.camera, this.size(), s); }
  private get snapRadius(): number { return SNAP_PX / this.app.camera.zoom; }

  private local(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private ghost(m: Extract<Mode, { kind: 'place' }>, cursor: Vec2): GhostResult {
    const stuck = this.stickAt !== null && m.prefer;
    return computeGhost(this.app.doc, {
      type: m.type, flipped: m.flipped, attachIndex: m.attachIndex, freeRot: m.freeRot, prefer: m.prefer,
      cursor: stuck ? m.prefer!.pos : this.toWorld(cursor),
      level: this.app.level, alt: this.alt, snapRadius: this.snapRadius,
    });
  }

  private ghostPiece(m: Extract<Mode, { kind: 'place' }>, g: GhostResult, id: string): Piece {
    const p: Piece = { id, type: m.type, x: g.pose.x, y: g.pose.y, rot: g.pose.rot, level: g.level, flipped: m.flipped };
    if (getPieceDef(m.type).switch) p.switch = { mode: 'manual', state: 0 };
    return p;
  }

  private trainHead(m: Extract<Mode, { kind: 'placeTrain' }>, cursor: Vec2): TrackPos | null {
    return nearestTrackPos(this.app.doc, this.toWorld(cursor), this.snapRadius, m.dir);
  }

  /** Car count of the train being placed: the lifted selected train's, else the mode's. */
  private placeTrainCars(m: Extract<Mode, { kind: 'placeTrain' }>): number {
    const t = this.app.selectedTrain ? this.app.doc.train(this.app.selectedTrain) : undefined;
    return t && t.head === null ? t.cars : m.cars;
  }

  /** Recompute ghosts for the current mode and cursor. */
  private refresh(): void {
    const m = this._mode, app = this.app;
    app.overlay = {};
    if (this.cursor && m.kind === 'place') {
      const g = this.ghost(m, this.cursor);
      app.overlay.ghost = { piece: this.ghostPiece(m, g, 'ghost'), valid: true };
    } else if (this.cursor && m.kind === 'placeTrain') {
      const head = this.trainHead(m, this.cursor);
      if (head) {
        const cars = this.placeTrainCars(m);
        const t: Train = {
          id: 'ghost', cars, color: '#808080', speed: 0, running: false, head, lifted: null,
          currentSpeed: 0, crashed: false, crashAt: null,
        };
        app.overlay.ghostTrain = carPoses(app.doc, t);
        app.overlay.ghostTrainValid = canPlaceTrain(app.doc, head, cars);
      }
    }
    app.requestRender();
  }

  /** Topmost piece (highest level, latest drawn) under a world point. */
  private pieceAt(w: Vec2): string | null {
    const pieces = this.app.doc.layout.pieces;
    let best: Piece | null = null;
    for (const p of pieces) {
      if (best && p.level < best.level) continue;
      if (worldFootprint(p).some((poly) => inPolygon(w, poly))) best = p;
    }
    return best?.id ?? null;
  }

  private trainAt(w: Vec2): Train | null {
    const { doc } = this.app;
    for (const t of [...doc.layout.trains].reverse()) {
      const cars = t.head !== null ? carPoses(doc, t) : t.lifted ? liftedCarPoses(t.lifted, t.cars) : [];
      if (cars.some((c) => inCar(w, c))) return t;
    }
    return null;
  }

  private connected(id: string): Set<string> {
    const { doc } = this.app;
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      const p = doc.piece(queue.shift()!);
      if (!p) continue;
      const n = pieceGeometry(p).connectors.length;
      for (let i = 0; i < n; i++) {
        const other = doc.graph.joins.get(connKey(p.id, i))?.pieceId;
        if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
    return seen;
  }

  private centroid(ids: string[]): Vec2 {
    let x = 0, y = 0, n = 0;
    for (const id of ids) {
      const p = this.app.doc.piece(id);
      if (p) { x += p.x; y += p.y; n++; }
    }
    return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
  }

  private selectOnly(ids: Iterable<string>): void {
    this.app.selection = new Set(ids);
    this.app.selectedTrain = undefined;
  }

  // ---- actions ----

  private placeAt(m: Extract<Mode, { kind: 'place' }>, cursor: Vec2): void {
    const { app } = this;
    const g = this.ghost(m, cursor);
    const piece = this.ghostPiece(m, g, app.doc.newId('p'));
    app.exec(placePieces([piece]));
    // Keep placing: the ghost moves on to the new piece's open end (not the slot it was placed by).
    const open = app.doc.graph.open.filter((c) => c.pieceId === piece.id);
    const prefer = open.find((c) => c.index !== g.attachIndex) ?? open[0];
    this._mode = { ...m, prefer };
    this.stickAt = cursor;
    this.refresh();
    app.notify();
  }

  private placeTrainAt(m: Extract<Mode, { kind: 'placeTrain' }>, cursor: Vec2): void {
    const { app } = this;
    const head = this.trainHead(m, cursor);
    if (!head) return;
    const lifted = app.selectedTrain ? app.doc.train(app.selectedTrain) : undefined;
    const cars = this.placeTrainCars(m);
    if (!canPlaceTrain(app.doc, head, cars)) return;
    let id: string;
    if (lifted && lifted.head === null) {
      id = lifted.id;
      app.exec(moveTrain(id, head));
    } else {
      id = app.doc.newId('t');
      app.exec(placeTrain({
        id, cars, color: TRAIN_COLORS[app.doc.layout.trains.length % TRAIN_COLORS.length],
        speed: NEW_TRAIN_SPEED, running: false, head, lifted: null, currentSpeed: 0, crashed: false, crashAt: null,
      }));
    }
    this.app.selection = new Set();
    this.app.selectedTrain = id;
    this.setMode({ kind: 'select' });
  }

  private transformSelection(poses: Map<string, Pose>): void {
    const ids = [...poses.keys()];
    if (!ids.length) return;
    this.app.exec(withLifting(this.app.doc, ids, transformPieces(ids, poses)));
  }

  private rotateSelection(deg: number): void {
    const ids = [...this.app.selection];
    if (!ids.length) return;
    this.transformSelection(posesAfterGroup(this.app.doc, ids, { delta: { x: 0, y: 0 }, rot: deg, pivot: this.centroid(ids) }));
  }

  private deleteSelection(): void {
    const { app } = this;
    const ids = [...app.selection];
    if (ids.length) {
      app.selection = new Set();
      app.exec(withLifting(app.doc, ids, deletePieces(ids)));
    } else if (app.selectedTrain) {
      const id = app.selectedTrain;
      app.selectedTrain = undefined;
      app.exec(deleteTrains([id]));
      app.sim.forget(id);
    }
  }

  // ---- event handlers ----

  handleKey(e: KeyboardEvent): void {
    if (isTextTarget(e.target)) return;
    const k = e.key;
    if (e.type === 'keyup') {
      if (k === 'Alt') { this.alt = false; e.preventDefault(); this.refresh(); }
      if (k === ' ') this.space = false;
      return;
    }
    if (e.type !== 'keydown') return;
    const lower = k.toLowerCase();
    const m = this._mode;

    if (e.ctrlKey || e.metaKey) {
      if (lower === 'z') { e.preventDefault(); if (e.shiftKey) this.app.redo(); else this.app.undo(); this.refresh(); }
      else if (lower === 'y') { e.preventDefault(); this.app.redo(); this.refresh(); }
      return;
    }
    switch (k) {
      case 'Alt': this.alt = true; e.preventDefault(); this.refresh(); return;
      case ' ':
        // Only claim Space over the canvas (or nothing focused); elsewhere it presses buttons etc.
        if (e.target instanceof Element && e.target !== this.canvas && e.target !== document.body) return;
        this.space = true; e.preventDefault(); return;
      case 'Escape':
        if (m.kind === 'select') { this.selectOnly([]); this.app.notify(); } else this.setMode({ kind: 'select' });
        return;
      case 'Tab':
        if (m.kind !== 'place' && m.kind !== 'placeTrain') return; // keep keyboard navigation
        e.preventDefault();
        if (m.kind === 'place') {
          const n = pieceGeometry(m).connectors.length;
          this._mode = { ...m, attachIndex: (m.attachIndex + 1) % n };
          this.refresh();
        } else if (m.kind === 'placeTrain') {
          this._mode = { ...m, dir: m.dir === 1 ? -1 : 1 };
          this.refresh();
        }
        return;
      case 'Delete': case 'Backspace':
        if (m.kind === 'select') { e.preventDefault(); this.deleteSelection(); }
        return;
    }
    if (lower === 'r' && m.kind === 'place') {
      this._mode = getPieceDef(m.type).flippable
        ? { ...m, flipped: !m.flipped }
        : { ...m, freeRot: normDeg(m.freeRot + ROT_STEP) };
      this.refresh();
    } else if (lower === 'q' || lower === 'e') {
      const deg = lower === 'q' ? -ROT_STEP : ROT_STEP;
      if (m.kind === 'select') this.rotateSelection(deg);
      else if (m.kind === 'place') { this._mode = { ...m, freeRot: normDeg(m.freeRot + deg) }; this.refresh(); }
    }
  }

  handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const m = this._mode;
    if (m.kind === 'place' && getPieceDef(m.type).flippable) {
      if (e.deltaY !== 0) { this._mode = { ...m, flipped: !m.flipped }; this.refresh(); }
      return;
    }
    const at = this.local(e);
    this.app.camera = zoomAt(this.app.camera, this.size(), at, Math.exp(-e.deltaY * WHEEL_ZOOM));
    this.refresh();
  }

  handlePointer(e: PointerEvent | MouseEvent): void {
    const at = this.local(e);
    this.alt = e.altKey;
    switch (e.type) {
      case 'contextmenu': e.preventDefault(); return;
      case 'pointerleave':
        if (!this.drag) { this.cursor = null; this.refresh(); }
        return;
      case 'dblclick': this.onDoubleClick(at); return;
      case 'pointerdown': this.onDown(e as PointerEvent, at); return;
      case 'pointermove': this.onMove(at); return;
      case 'pointerup': case 'pointercancel': this.onUp(e as PointerEvent, at); return;
    }
  }

  private onDown(e: PointerEvent, at: Vec2): void {
    this.cursor = at;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or unsupported */ }
    this.canvas.focus?.({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && this.space)) {
      e.preventDefault();
      this.drag = { kind: 'pan', last: at };
      return;
    }
    const m = this._mode;
    if (e.button === 2) {
      if (m.kind !== 'select') this.setMode({ kind: 'select' });
      return;
    }
    if (e.button !== 0) return;
    if (m.kind === 'place') { this.placeAt(m, at); return; }
    if (m.kind === 'placeTrain') { this.placeTrainAt(m, at); return; }

    const w = this.toWorld(at);
    const train = e.shiftKey ? null : this.trainAt(w);
    if (train) {
      this.app.selection = new Set();
      this.app.selectedTrain = train.id;
      // A lifted train is dropped back with the same placement as "Add train".
      if (train.head === null) this.setMode({ kind: 'placeTrain', cars: train.cars, dir: 1 });
      else this.app.notify();
      return;
    }
    this.drag = { kind: 'press', start: at, hit: this.pieceAt(w), shift: e.shiftKey };
  }

  private onMove(at: Vec2): void {
    this.cursor = at;
    if (this.stickAt && dist(at, this.stickAt) > DRAG_PX) this.stickAt = null;
    const d = this.drag, app = this.app;
    if (!d) { this.refresh(); return; }
    if (d.kind === 'pan') {
      const z = app.camera.zoom;
      app.camera = { ...app.camera, cx: app.camera.cx - (at.x - d.last.x) / z, cy: app.camera.cy - (at.y - d.last.y) / z };
      d.last = at;
      app.requestRender();
      return;
    }
    if (d.kind === 'press') {
      if (dist(at, d.start) <= DRAG_PX) return;
      if (d.hit) {
        if (!app.selection.has(d.hit)) this.selectOnly(d.shift ? [...app.selection, d.hit] : [d.hit]);
        const ids = [...app.selection];
        this.drag = { kind: 'move', ids, start: this.toWorld(d.start), pivot: this.centroid(ids), poses: new Map() };
      } else {
        this.drag = { kind: 'box', start: d.start, shift: d.shift };
      }
      this.onMove(at);
      return;
    }
    if (d.kind === 'move') {
      const g = snapGroup(app.doc, d.ids, { delta: sub(this.toWorld(at), d.start), rot: 0, pivot: d.pivot }, this.snapRadius, this.alt);
      d.poses = posesAfterGroup(app.doc, d.ids, g);
      const layout = app.doc.layout;
      app.preview = new Doc({
        ...layout,
        pieces: layout.pieces.map((p) => { const q = d.poses.get(p.id); return q ? { ...p, ...q } : p; }),
      });
      app.requestRender();
      return;
    }
    app.box = { a: d.start, b: at };
    app.requestRender();
  }

  private onUp(e: PointerEvent, at: Vec2): void {
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const d = this.drag, app = this.app;
    this.drag = null;
    if (!d || d.kind === 'pan') return;
    if (e.type === 'pointercancel') { app.preview = null; app.box = null; app.requestRender(); return; }
    if (d.kind === 'press') {
      if (d.hit) {
        const p = app.doc.piece(d.hit);
        if (d.shift) {
          const s = new Set(app.selection);
          if (s.has(d.hit)) s.delete(d.hit); else s.add(d.hit);
          this.selectOnly(s);
        } else if (p && getPieceDef(p.type).switch && app.selection.size === 0) {
          // Play, not an edit: not added to history.
          if (app.sim.toggleSwitch(p.id)) app.changed();
          app.selectedTrain = undefined;
        } else {
          this.selectOnly([d.hit]);
        }
      } else if (!d.shift) {
        this.selectOnly([]);
      }
      app.notify();
      return;
    }
    if (d.kind === 'move') {
      app.preview = null;
      const moved = [...d.poses].filter(([id, q]) => {
        const p = app.doc.piece(id);
        return p && (Math.abs(p.x - q.x) > 1e-9 || Math.abs(p.y - q.y) > 1e-9 || Math.abs(normDeg(p.rot - q.rot)) > 1e-9);
      });
      if (moved.length) this.transformSelection(d.poses);
      else app.requestRender();
      return;
    }
    // Box select: pieces with any footprint vertex inside the box.
    app.box = null;
    const a = this.toWorld(d.start), b = this.toWorld(at);
    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    const inside = app.doc.layout.pieces.filter((p) => worldFootprint(p).some((poly) =>
      poly.some((v) => v.x >= min.x && v.x <= max.x && v.y >= min.y && v.y <= max.y))).map((p) => p.id);
    this.selectOnly(d.shift ? [...app.selection, ...inside] : inside);
    app.notify();
  }

  private onDoubleClick(at: Vec2): void {
    if (this._mode.kind !== 'select') return;
    const hit = this.pieceAt(this.toWorld(at));
    if (!hit) return;
    this.selectOnly(this.connected(hit));
    this.app.notify();
  }
}
