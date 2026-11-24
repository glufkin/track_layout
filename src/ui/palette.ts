import { CATALOG, PALETTE_ORDER, type Family } from '../track/catalog';
import { worldFootprint } from '../track/graph';
import { MAX_CARS, type Piece, type StyleId } from '../model/types';
import { STYLES } from '../render/style';
import type { App } from './app';

const FAMILY_LABEL: Record<Family, string> = {
  straight: 'Straight', curve: 'Curves', switch: 'Switches', crossover: 'Crossings',
  ramp: 'Ramps', bridge: 'Bridges', tunnel: 'Tunnels', buffer: 'Buffers',
};
const THUMB_W = 72, THUMB_H = 48, THUMB_PAD = 6;
/** Max thumbnail scale (px per U), so short pieces are not blown up to fill the tile. */
const THUMB_MAX_SCALE = 30;
export const DEFAULT_CARS = 3;

/** Draw a catalogue piece centred and scaled to fit a thumbnail canvas, in the given style. */
function drawThumb(canvas: HTMLCanvasElement, type: string, styleId: StyleId): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = Math.round(THUMB_W * dpr);
  canvas.height = Math.round(THUMB_H * dpr);
  const piece: Piece = { id: 'thumb', type, x: 0, y: 0, rot: 0, level: 0, flipped: false };
  if (CATALOG[type].switch) piece.switch = { mode: 'manual', state: 0 };
  const pts = worldFootprint(piece).flat();
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const k = Math.min(THUMB_MAX_SCALE, (THUMB_W - 2 * THUMB_PAD) / (maxX - minX), (THUMB_H - 2 * THUMB_PAD) / (maxY - minY));
  const style = STYLES[styleId];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  ctx.save();
  ctx.translate(THUMB_W / 2, THUMB_H / 2);
  ctx.scale(k, k);
  ctx.translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
  style.piece(ctx, piece, {});
  if (CATALOG[type].tunnel) style.tunnelCover(ctx, piece);
  ctx.restore();
}

/** The left palette (spec §5.12): one thumbnail per catalogue entry grouped by family, plus "+ Train". */
export function buildPalette(app: App, el: HTMLElement): void {
  const thumbs: Array<{ type: string; item: HTMLElement; canvas: HTMLCanvasElement }> = [];
  let group: HTMLElement | null = null;
  let family: Family | null = null;
  for (const type of PALETTE_ORDER) {
    const def = CATALOG[type];
    if (def.family !== family) {
      family = def.family;
      const h = document.createElement('h3');
      h.textContent = FAMILY_LABEL[family];
      group = document.createElement('div');
      group.className = 'tl-group';
      el.append(h, group);
    }
    const item = document.createElement('div');
    item.className = 'tl-thumb';
    item.dataset.piece = type;
    item.title = def.label;
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = def.label;
    item.append(canvas, label);
    item.addEventListener('click', () => {
      app.input.setMode({ kind: 'place', type, flipped: false, attachIndex: 0, freeRot: 0 });
    });
    group!.append(item);
    thumbs.push({ type, item, canvas });
  }

  const h = document.createElement('h3');
  h.textContent = 'Trains';
  const row = document.createElement('div');
  row.className = 'tl-train';
  const cars = document.createElement('input');
  cars.type = 'number';
  cars.min = '0';
  cars.max = String(MAX_CARS);
  cars.value = String(DEFAULT_CARS);
  cars.title = 'Cars behind the locomotive';
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+ Train';
  add.dataset.action = 'train';
  add.addEventListener('click', () => {
    const n = Math.round(Number(cars.value));
    const count = Number.isFinite(n) ? Math.min(MAX_CARS, Math.max(0, n)) : DEFAULT_CARS;
    cars.value = String(count);
    app.selectedTrain = undefined;
    app.input.setMode({ kind: 'placeTrain', cars: count, dir: 1 });
  });
  row.append(add, cars);
  el.append(h, row);

  let drawnStyle: StyleId | null = null;
  const update = (): void => {
    if (app.style !== drawnStyle) {
      drawnStyle = app.style;
      for (const t of thumbs) drawThumb(t.canvas, t.type, drawnStyle);
    }
    const m = app.input.mode;
    for (const t of thumbs) t.item.classList.toggle('tl-active', m.kind === 'place' && m.type === t.type);
    add.classList.toggle('tl-active', m.kind === 'placeTrain');
  };
  app.onChange(update);
  update();
}
