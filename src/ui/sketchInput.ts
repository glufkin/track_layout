import { type Vec2, dist, sub } from '../geom/vec';
import { MAX_LEVEL, type Piece } from '../model/types';
import { START_DIST, StrokeFitter } from '../sketch/fitter';
import { type StrokeStart, beginStroke, finishStroke, strokeDoc } from '../sketch/stroke';
import { specToPiece } from '../sketch/spec';
import { switchSplice } from '../sketch/splice';
import type { Overlay } from '../render/renderer';
import type { App } from './app';
import { SNAP_PX } from './input';

/** Canvas class showing the "not allowed" cursor after a refused stroke start. */
export const REFUSED_CLASS = 'tl-refused';

/** Keys requesting a ramp: `+` is Shift+`=` and `_` is Shift+`-` on most keyboards. */
const RAMP_KEYS: Record<string, 1 | -1> = { '+': 1, '=': 1, '-': -1, '_': -1 };

const isCrossover = (type: string): boolean => type.startsWith('crossover');

/**
 * The sketch tool (spec §5.2, §5.3, §5.5): one stroke from pointer down to up, fitted live by a
 * StrokeFitter and committed on release as one command. Input routes pointer events and keys here
 * while the mode is `sketch` (pan and zoom stay with Input).
 */
export class SketchController {
  /** The press point; non-null while a stroke is being drawn (including a provisional start). */
  private downAt: Vec2 | null = null;
  private start: StrokeStart | null = null;
  /** Null while the start is provisional (on the middle of track, direction not yet known). */
  private fitter: StrokeFitter | null = null;
  /** Ramp keys pressed before the fitter exists (provisional start): the net request. */
  private queuedRamp: -1 | 0 | 1 = 0;
  private shift = false;
  private refusedAt: Vec2 | undefined;
  /** A refused press: no stroke until the pointer is released. */
  private refused = false;

  constructor(private app: App) {}

  /** True while a stroke (or a refused press) is in progress. */
  get active(): boolean { return this.downAt !== null || this.refused; }

  private get snapRadius(): number { return SNAP_PX / this.app.camera.zoom; }

  down(world: Vec2): void {
    this.reset();
    this.refusedAt = undefined;
    this.setRefusedCursor(false);
    const s = beginStroke(this.app.doc, world, this.app.level, this.snapRadius);
    if (s === 'refused') { this.refuse(world); return; }
    this.downAt = { ...world };
    this.start = s;
    if (!(s.heading === null && !s.empty)) this.fitter = new StrokeFitter(strokeDoc(this.app.doc, s), s);
    this.update();
  }

  move(world: Vec2, shift: boolean): void {
    this.shift = shift;
    if (!this.downAt) return;
    if (!this.fitter) {
      // Provisional start on the middle of track: wait for the drag direction, then build the switch.
      if (dist(world, this.downAt) < START_DIST) return;
      const s = beginStroke(this.app.doc, this.downAt, this.app.level, this.snapRadius, sub(world, this.downAt));
      if (s === 'refused') { const at = this.downAt; this.reset(); this.refuse(at); return; }
      this.start = s;
      this.fitter = new StrokeFitter(strokeDoc(this.app.doc, s), s);
      if (this.queuedRamp !== 0 && !this.fitter.requestRamp(this.queuedRamp)) this.app.clicker.bonk();
      this.queuedRamp = 0;
    }
    const n = this.fitter.addPoint(world, shift);
    for (let i = 0; i < n; i++) this.app.clicker.tick();
    this.update();
  }

  up(world: Vec2): void {
    if (this.refused) { this.refused = false; this.setRefusedCursor(false); this.update(); return; }
    const { start, fitter } = this;
    this.reset();
    if (start && fitter) {
      const n = fitter.addPoint(world, this.shift);
      for (let i = 0; i < n; i++) this.app.clicker.tick();
      const cmd = finishStroke(this.app.doc, start, fitter, world, this.snapRadius);
      if (cmd) {
        this.app.exec(cmd);
        this.app.clicker.settle();
      }
    }
    this.update();
  }

  /** Handle a sketch key; true when it was handled. Ramp keys only act during a stroke. */
  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (!this.active) return false;
      this.cancel();
      return true;
    }
    const dir = RAMP_KEYS[e.key];
    if (!dir || !this.downAt) return false;
    if (this.fitter) {
      if (!this.fitter.requestRamp(dir)) this.app.clicker.bonk();
    } else {
      const next = this.queuedRamp + dir;
      const level = (this.start?.level ?? this.app.level) + next;
      if (next < -1 || next > 1 || level < 0 || level > MAX_LEVEL) this.app.clicker.bonk();
      else this.queuedRamp = next as -1 | 0 | 1;
    }
    this.update();
    return true;
  }

  /** Abandon the stroke in progress (Esc, leaving sketch mode); nothing is committed. */
  cancel(): void {
    this.reset();
    this.refusedAt = undefined;
    this.setRefusedCursor(false);
    this.update();
  }

  overlay(): Overlay['sketch'] {
    const f = this.fitter, s = this.start;
    if (!this.downAt) {
      if (!this.refusedAt) return undefined;
      return { points: [], ghost: [], level: this.app.level, redFrom: null, pendingRamp: 0, refusedAt: this.refusedAt };
    }
    const switchPreview = (s?.startSplice?.add ?? []).filter((p) => p.type === 'switch')
      .map((p, i) => specToPiece(p, 'sketch:switch:' + i));
    if (!f) {
      return { points: [this.downAt], ghost: [], level: s?.level ?? this.app.level, redFrom: null, pendingRamp: this.queuedRamp, switchPreview };
    }
    const ghost: Piece[] = f.pieces.map((p, i) => specToPiece(p, 'sketch:' + i));
    f.crossings.forEach((c, ci) => {
      if (c.ghost) return;
      c.splice.add.forEach((p, i) => { if (isCrossover(p.type)) ghost.push(specToPiece(p, 'sketch:x:' + ci + ':' + i)); });
    });
    const endSwitch = this.endSwitch(f);
    if (endSwitch) switchPreview.push(endSwitch);
    return {
      points: f.points, ghost, level: f.lead.level, redFrom: f.redFrom, pendingRamp: f.pendingRamp,
      lead: { x: f.lead.pose.x, y: f.lead.pose.y }, switchPreview,
    };
  }

  /** The merging switch a release here would build (spec §5.7), when the pointer is on plain straight track. */
  private endSwitch(f: StrokeFitter): Piece | null {
    if (f.redFrom !== null || f.pieces.length === 0) return null;
    const pt = f.points[f.points.length - 1];
    const level = f.lead.level, r = this.snapRadius;
    if (this.app.doc.graph.open.some((c) => c.level === level && dist(c.pos, pt) <= r)) return null;
    const dir = { x: Math.cos((f.lead.pose.rot * Math.PI) / 180), y: Math.sin((f.lead.pose.rot * Math.PI) / 180) };
    const sw = switchSplice(this.app.doc, pt, level, dir, 'merge', r);
    const p = sw?.splice.add.find((q) => q.type === 'switch');
    return p ? specToPiece(p, 'sketch:switch:end') : null;
  }

  private refuse(at: Vec2): void {
    this.refused = true;
    this.refusedAt = { ...at };
    this.setRefusedCursor(true);
    this.update();
  }

  private reset(): void {
    this.downAt = null;
    this.start = null;
    this.fitter = null;
    this.queuedRamp = 0;
    this.refused = false;
  }

  private setRefusedCursor(on: boolean): void { this.app.canvas.classList.toggle(REFUSED_CLASS, on); }

  private update(): void {
    if (this.app.input?.mode.kind !== 'sketch') return;
    const o = this.overlay();
    if (o) this.app.overlay.sketch = o; else delete this.app.overlay.sketch;
    this.app.requestRender();
  }
}
