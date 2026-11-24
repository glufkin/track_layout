import type { Vec2 } from '../geom/vec';
import { MAX_CARS } from '../model/types';
import { deleteTrains, setSwitchMode, setTrainProps } from '../editor/commands';
import { carPoses } from '../sim/motion';
import { worldToScreen } from '../render/camera';
import type { App } from './app';

/** Speed slider range and step, in U/s. */
export const MIN_SPEED = 0.2;
export const MAX_SPEED = 4;
const SPEED_STEP = 0.1;
/** Panel offset from the object's screen point, and the margin kept to the window edge (CSS px). */
const OFFSET = 18;
const MARGIN = 8;

interface Panel {
  app: App;
  kind: 'train' | 'switch';
  id: string;
  el: HTMLElement;
  /** Refresh the controls from the model (skipping the focused one). */
  sync: () => void;
  /** The object's world point the panel sits next to, or null if it no longer exists. */
  anchor: () => Vec2 | null;
}

let current: Panel | null = null;

function button(label: string, action: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.action = action;
  b.addEventListener('click', onClick);
  return b;
}

function row(label: string, ...controls: HTMLElement[]): HTMLLabelElement {
  const l = document.createElement('label');
  l.append(label, ...controls);
  return l;
}

/** Set a control's value unless the user is editing it. */
function setValue(input: HTMLInputElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

function reuse(app: App, kind: Panel['kind'], id: string): boolean {
  if (current && current.app === app && current.kind === kind && current.id === id && current.el.isConnected) {
    current.sync();
    positionPanels(app);
    return true;
  }
  return false;
}

function mount(panel: Panel): void {
  hidePanels();
  panel.el.classList.add('tl-panel');
  document.body.append(panel.el);
  current = panel;
  panel.sync();
  positionPanels(panel.app);
}

/** The floating panel of a train (spec §5.5): run/stop, reverse, speed, cars, colour, delete, place back. */
export function showTrainPanel(app: App, trainId: string): void {
  if (reuse(app, 'train', trainId)) return;
  const train = () => app.doc.train(trainId);
  const el = document.createElement('div');
  el.dataset.train = trainId;

  const title = document.createElement('strong');
  title.textContent = 'Train';
  const run = button('', 'run', () => {
    const t = train();
    if (!t || t.head === null) return;
    t.running = !t.running; // play, not an edit
    sync();
    app.requestRender();
  });
  const reverse = button('⇄ Reverse', 'reverse', () => { app.sim.reverse(trainId); app.requestRender(); });
  const placeBack = button('Place back', 'place-back', () => {
    const t = train();
    if (!t) return;
    app.selection = new Set();
    app.selectedTrain = trainId;
    app.input.setMode({ kind: 'placeTrain', cars: t.cars, dir: 1 });
  });

  const speed = document.createElement('input');
  speed.type = 'range';
  speed.dataset.action = 'speed';
  speed.min = String(MIN_SPEED);
  speed.max = String(MAX_SPEED);
  speed.step = String(SPEED_STEP);
  speed.addEventListener('input', () => {
    const t = train();
    if (!t) return;
    t.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(speed.value))); // play, not an edit
    app.requestRender();
  });

  const cars = document.createElement('input');
  cars.type = 'number';
  cars.dataset.action = 'cars';
  cars.min = '0';
  cars.max = String(MAX_CARS);
  cars.addEventListener('change', () => {
    const t = train();
    if (!t) return;
    const n = Math.round(Number(cars.value));
    const count = Number.isFinite(n) ? Math.min(MAX_CARS, Math.max(0, n)) : t.cars;
    cars.value = String(count);
    if (count !== t.cars) app.exec(setTrainProps(trainId, { cars: count }));
  });

  const color = document.createElement('input');
  color.type = 'color';
  color.dataset.action = 'color';
  color.addEventListener('change', () => {
    const t = train();
    if (t && color.value !== t.color) app.exec(setTrainProps(trainId, { color: color.value }));
  });

  const del = button('Delete', 'delete', () => {
    app.selectedTrain = undefined;
    app.exec(deleteTrains([trainId]));
    app.sim.forget(trainId);
  });

  const buttons = document.createElement('div');
  buttons.className = 'tl-panel-row';
  el.append(title, buttons, row('Speed', speed), row('Cars', cars), row('Colour', color), del);

  const sync = (): void => {
    const t = train();
    if (!t) return;
    const lifted = t.head === null;
    buttons.replaceChildren(...(lifted ? [placeBack] : [run, reverse]));
    run.textContent = t.running ? '■ Stop' : '▶ Run';
    run.setAttribute('aria-pressed', String(t.running));
    speed.disabled = lifted;
    setValue(speed, String(t.speed));
    setValue(cars, String(t.cars));
    setValue(color, t.color);
  };
  const anchor = (): Vec2 | null => {
    const t = train();
    if (!t) return null;
    if (t.head !== null) return carPoses(app.doc, t)[0]?.center ?? null;
    return t.lifted ? { x: t.lifted.x, y: t.lifted.y } : null;
  };
  mount({ app, kind: 'train', id: trainId, el, sync, anchor });
}

/** The floating panel of a switch (spec §5.6): manual / auto mode. */
export function showSwitchPanel(app: App, pieceId: string): void {
  if (reuse(app, 'switch', pieceId)) return;
  const el = document.createElement('div');
  el.dataset.switch = pieceId;
  const title = document.createElement('strong');
  title.textContent = 'Switch';
  const radios = (['manual', 'auto'] as const).map((mode) => {
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = `tl-switch-mode-${pieceId}`;
    r.value = mode;
    r.addEventListener('change', () => {
      const p = app.doc.piece(pieceId);
      if (r.checked && p?.switch && p.switch.mode !== mode) app.exec(setSwitchMode(pieceId, mode));
    });
    return r;
  });
  el.append(title, row('Manual', radios[0]), row('Auto', radios[1]));
  const sync = (): void => {
    const mode = app.doc.piece(pieceId)?.switch?.mode ?? 'manual';
    for (const r of radios) r.checked = r.value === mode;
  };
  const anchor = (): Vec2 | null => {
    const p = app.doc.piece(pieceId);
    return p ? { x: p.x, y: p.y } : null;
  };
  mount({ app, kind: 'switch', id: pieceId, el, sync, anchor });
}

export function hidePanels(): void {
  current?.el.remove();
  current = null;
}

/** Keep the open panel next to its object (which may be a moving train) and inside the window. */
export function positionPanels(app: App): void {
  if (!current || current.app !== app) return;
  const w = current.anchor();
  if (!w) return;
  const rect = app.canvas.getBoundingClientRect();
  const s = worldToScreen(app.camera, app.viewSize(), w);
  const el = current.el;
  const width = el.offsetWidth, height = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = rect.left + s.x + OFFSET, y = rect.top + s.y + OFFSET;
  if (x + width > vw - MARGIN) x = rect.left + s.x - OFFSET - width; // flip to the left of the object
  if (y + height > vh - MARGIN) y = rect.top + s.y - OFFSET - height; // flip above it
  x = Math.max(MARGIN, Math.min(x, vw - MARGIN - width));
  y = Math.max(MARGIN, Math.min(y, vh - MARGIN - height));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}
