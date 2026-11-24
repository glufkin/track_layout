import type { Vec2 } from '../geom/vec';
import { Doc } from '../model/doc';
import { emptyLayout, type Layout, type StyleId } from '../model/types';
import { History, type Command } from '../editor/history';
import { Simulation } from '../sim/simulation';
import { deserialize, loadAutosave, saveAutosave, serialize } from '../io/serialize';
import { type Camera, defaultCamera, fitBounds } from '../render/camera';
import { render, type Overlay } from '../render/renderer';
import { worldFootprint } from '../track/graph';
import { getPieceDef } from '../track/catalog';
import { Input } from './input';
import { buildToolbar } from './toolbar';
import { buildPalette } from './palette';
import { framePanels, hidePanels, positionPanels, showSwitchPanel, showTrainPanel } from './panels';

export const AUTOSAVE_DELAY_MS = 500;
/** While a train runs, its moving position is autosaved at most this often. */
export const PLAY_AUTOSAVE_MS = 5000;

/**
 * The editor: owns the document, history, simulation and view, and wires the DOM (toolbar on
 * top, palette on the left, canvas filling the rest — spec §5.12; the layout CSS is in index.html).
 */
export class App {
  doc: Doc;
  history = new History();
  sim: Simulation;
  camera: Camera = defaultCamera();
  /** The current level for loose placements (toolbar). */
  level = 0;
  selection = new Set<string>();
  selectedTrain: string | undefined;
  readonly canvas: HTMLCanvasElement;
  readonly input: Input;
  /** Extra overlay fields set by Input (ghosts); merged into the render overlay. */
  overlay: Omit<Overlay, 'selectedPieces' | 'selectedTrain' | 'showConnectors'> = {};
  /** A doc to draw instead of `doc` (drag preview). Never edited through history. */
  preview: Doc | null = null;
  /** Screen-space box-select rectangle, drawn over the scene. */
  box: { a: Vec2; b: Vec2 } | null = null;

  private ctx: CanvasRenderingContext2D | null;
  private listeners: Array<() => void> = [];
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private frame: number | null = null;
  private lastTime: number | null = null;
  /** Frame time of the last autosave made because trains were running (null: none running). */
  private lastPlaySave: number | null = null;
  private disposers: Array<() => void> = [];

  constructor(root: HTMLElement) {
    this.doc = new Doc(loadAutosave() ?? emptyLayout());
    this.sim = new Simulation(this.doc);

    const shell = document.createElement('div');
    shell.className = 'tl-app';
    const toolbar = document.createElement('div');
    toolbar.className = 'tl-toolbar';
    const palette = document.createElement('div');
    palette.className = 'tl-palette';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-canvas';
    this.canvas.tabIndex = 0;
    shell.append(toolbar, palette, this.canvas);
    root.replaceChildren(shell);

    this.ctx = this.canvas.getContext('2d');
    this.input = new Input(this, this.canvas);
    buildToolbar(this, toolbar);
    buildPalette(this, palette);
    this.onChange(() => this.syncPanels());

    const onResize = (): void => this.requestRender();
    window.addEventListener('resize', onResize);
    const onDragOver = (e: DragEvent): void => { e.preventDefault(); };
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file && /\.json$/i.test(file.name)) void file.text().then((t) => this.openText(t));
    };
    const onPageHide = (): void => this.flushAutosave();
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('pagehide', onPageHide);
    this.disposers.push(() => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    });

    this.fit();
    this.notify();
  }

  get style(): StyleId { return this.doc.layout.style; }
  set style(id: StyleId) {
    this.doc.layout.style = id;
    this.changed();
  }

  /** The canvas size in CSS pixels. */
  viewSize(): Vec2 { return { x: this.canvas.clientWidth, y: this.canvas.clientHeight }; }

  exec(cmd: Command): void { this.history.exec(cmd, this.doc); this.afterEdit(); }
  undo(): void { if (this.history.undo(this.doc)) { this.input.clearPin(); this.afterEdit(); } }
  redo(): void { if (this.history.redo(this.doc)) { this.input.clearPin(); this.afterEdit(); } }

  private afterEdit(): void {
    this.doc.rebuild();
    // Forget selections whose pieces/trains no longer exist.
    for (const id of this.selection) if (!this.doc.piece(id)) this.selection.delete(id);
    if (this.selectedTrain && !this.doc.train(this.selectedTrain)) this.selectedTrain = undefined;
    this.changed();
  }

  /** A non-history change to the layout (settings, style, switch toggle): autosave, notify, render. */
  changed(): void {
    this.scheduleAutosave();
    this.notify();
  }

  /** Show the train panel for the selected train, the switch panel for a lone selected switch, else none. */
  private syncPanels(): void {
    if (this.selectedTrain && this.doc.train(this.selectedTrain)) { showTrainPanel(this, this.selectedTrain); return; }
    if (this.selection.size === 1) {
      const p = this.doc.piece([...this.selection][0]);
      if (p && getPieceDef(p.type).switch) { showSwitchPanel(this, p.id); return; }
    }
    hidePanels();
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      saveAutosave(this.doc.layout);
    }, AUTOSAVE_DELAY_MS);
  }

  /** Save now (e.g. the page is going away), cancelling any pending debounced save. */
  flushAutosave(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    saveAutosave(this.doc.layout);
  }

  /** While any placed train runs, autosave its moving state every PLAY_AUTOSAVE_MS of frame time. */
  private playAutosave(time: number): void {
    const running = !this.sim.paused && this.doc.layout.trains.some((t) => t.running && t.head !== null);
    if (!running) { this.lastPlaySave = null; return; }
    if (this.lastPlaySave === null) { this.lastPlaySave = time; return; } // starting to run already saved
    if (time - this.lastPlaySave < PLAY_AUTOSAVE_MS) return;
    this.lastPlaySave = time;
    saveAutosave(this.doc.layout);
  }

  /** Subscribe to state changes (history, selection, settings, mode). */
  onChange(fn: () => void): void { this.listeners.push(fn); }

  notify(): void {
    for (const fn of this.listeners) fn();
    this.requestRender();
  }

  /** Replace the whole layout (New / Open): clears history and selection and fits the view. */
  loadLayout(layout: Layout): void {
    const paused = this.sim.paused;
    this.doc = new Doc(layout);
    this.sim = new Simulation(this.doc);
    this.sim.paused = paused;
    this.selection.clear();
    this.selectedTrain = undefined;
    this.preview = null;
    this.input.setMode({ kind: 'select' });
    this.history.clear();
    this.fit();
    this.changed();
  }

  newLayout(): void {
    const { pieces, trains } = this.doc.layout;
    const hasWork = pieces.length > 0 || trains.length > 0 || this.history.canUndo || this.history.canRedo;
    if (hasWork && !window.confirm('Discard the current layout and start a new one?')) return;
    this.loadLayout(emptyLayout());
  }

  /** Open a saved layout; a bad file shows the error and leaves the current layout untouched. */
  openText(text: string): void {
    const r = deserialize(text);
    if (!r.ok) { window.alert(r.error); return; }
    this.loadLayout(r.layout);
  }

  save(): void {
    const blob = new Blob([serialize(this.doc.layout)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'layout.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Fit the view to the layout; an empty layout gets the default camera. */
  fit(): void {
    let min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
    for (const p of this.doc.layout.pieces) for (const poly of worldFootprint(p)) for (const v of poly) {
      min = { x: Math.min(min.x, v.x), y: Math.min(min.y, v.y) };
      max = { x: Math.max(max.x, v.x), y: Math.max(max.y, v.y) };
    }
    const size = this.viewSize();
    this.camera = this.doc.layout.pieces.length && size.x > 0 && size.y > 0
      ? fitBounds(defaultCamera(), size, min, max) : defaultCamera();
    this.requestRender();
  }

  togglePlay(): void {
    this.sim.paused = !this.sim.paused;
    this.notify();
  }

  requestRender(): void {
    if (this.renderQueued || this.frame !== null) return; // the running loop renders every frame
    if (typeof requestAnimationFrame !== 'function') return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.draw(); });
  }

  /** Start the animation loop: each frame steps the simulation, then renders. */
  start(): void {
    if (this.frame !== null) return;
    const tick = (time: number): void => {
      const dt = this.lastTime === null ? 0 : (time - this.lastTime) / 1000;
      this.lastTime = time;
      try {
        if (dt > 0) this.sim.step(dt);
        this.playAutosave(time);
        framePanels(this);
        this.draw();
      } catch (e) {
        console.error('Frame failed:', e); // keep the loop alive; the next frame may well succeed
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.input.dispose();
    hidePanels();
    for (const d of this.disposers) d();
  }

  /** Draw one frame. Skipped when the canvas has no 2D context (e.g. jsdom). */
  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const size = this.viewSize();
    const w = Math.max(1, Math.round(size.x * dpr)), h = Math.max(1, Math.round(size.y * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const overlay: Overlay = {
      ...this.overlay,
      selectedPieces: this.selection,
      selectedTrain: this.selectedTrain,
      showConnectors: true,
    };
    render(ctx, this.preview ?? this.doc, this.camera, size, overlay, this.style);
    if (this.box) {
      const { a, b } = this.box;
      ctx.save();
      ctx.fillStyle = 'rgba(30,136,229,0.12)';
      ctx.strokeStyle = '#1e88e5';
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      ctx.restore();
    }
    positionPanels(this); // follow a moving train
  }
}
