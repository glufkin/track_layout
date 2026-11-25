import { emptyLayout, MAX_CARS, MAX_LEVEL, type Layout, type Piece, type StyleId, type Train } from '../model/types';
import { CATALOG, getPieceDef, pieceGeometry, validFlex, type FlexParams } from '../track/catalog';

export const FORMAT = 'track-layout';
export const VERSION = 2;
export const AUTOSAVE_KEY = 'track-layout:autosave';
/** Where an autosave that failed to load is kept, so a bad load never silently loses it. */
export const AUTOSAVE_REJECTED_KEY = 'track-layout:autosave-rejected';

const STYLES: StyleId[] = ['wooden', 'model', 'brick'];
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const writeFlex = (f: FlexParams): FlexParams =>
  ('length' in f ? { length: r6(f.length) } : { radius: r6(f.radius), sweep: r6(f.sweep) });

export function serialize(layout: Layout): string {
  const data = {
    format: FORMAT,
    version: VERSION,
    style: layout.style,
    settings: { ...layout.settings },
    pieces: layout.pieces.map((p) => ({
      id: p.id, type: p.type, x: r6(p.x), y: r6(p.y), rotation: r6(p.rot), level: p.level, flipped: p.flipped,
      ...(p.switch ? { switch: { mode: p.switch.mode, state: p.switch.state } } : {}),
      ...(p.flex ? { flex: writeFlex(p.flex) } : {}),
    })),
    trains: layout.trains.map((t) => ({
      id: t.id, cars: t.cars, color: t.color, speed: r6(t.speed), running: t.running,
      head: t.head
        ? { piece: t.head.pieceId, route: t.head.route, distance: r6(t.head.dist), direction: t.head.dir === 1 ? 'forward' : 'backward' }
        : null,
      lifted: t.lifted ? { x: r6(t.lifted.x), y: r6(t.lifted.y), rotation: r6(t.lifted.rot) } : null,
    })),
  };
  return JSON.stringify(data, null, 2);
}

class Bad extends Error {}
const fail = (msg: string): never => { throw new Bad(msg); };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (o: Obj, key: string, where: string): number => {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where}: ${key} must be a finite number`);
};
const int = (o: Obj, key: string, max: number, where: string): number => {
  const v = o[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
    ? v : fail(`${where}: ${key} must be an integer 0..${max}`);
};

function readPiece(raw: unknown, n: number): Piece {
  const where = `Piece #${n}`;
  if (!isObj(raw)) return fail(`${where}: not an object`);
  if (typeof raw.id !== 'string' || raw.id === '') fail(`${where}: id must be a non-empty string`);
  if (typeof raw.type !== 'string' || !Object.prototype.hasOwnProperty.call(CATALOG, raw.type)) {
    fail(`${where}: unknown type ${JSON.stringify(raw.type)}`);
  }
  const type = raw.type as string;
  const piece: Piece = {
    id: raw.id as string, type,
    x: num(raw, 'x', where), y: num(raw, 'y', where), rot: num(raw, 'rotation', where),
    level: int(raw, 'level', MAX_LEVEL, where),
    flipped: typeof raw.flipped === 'boolean' ? raw.flipped : fail(`${where}: flipped must be a boolean`),
  };
  const hasSwitch = getPieceDef(type).switch !== undefined;
  if (raw.switch !== undefined) {
    if (!hasSwitch) fail(`${where}: switch block on a piece without a switch`);
    const s = raw.switch;
    if (!isObj(s)) return fail(`${where}: switch must be an object`);
    if (s.mode !== 'manual' && s.mode !== 'auto') fail(`${where}: bad switch mode`);
    if (s.state !== 0 && s.state !== 1) fail(`${where}: bad switch state`);
    piece.switch = { mode: s.mode as 'manual' | 'auto', state: s.state as 0 | 1 };
  } else if (hasSwitch) {
    piece.switch = { mode: 'manual', state: 0 };
  }
  const flexKind = getPieceDef(type).flex;
  if (flexKind) {
    if (!validFlex(type, raw.flex as FlexParams | undefined)) {
      fail(`${where}: ${type} needs a flex field with valid ${flexKind === 'straight' ? 'length' : 'radius and sweep'}`);
    }
    const f = raw.flex as Record<string, number>;
    piece.flex = flexKind === 'straight' ? { length: f.length } : { radius: f.radius, sweep: f.sweep };
  } else if (raw.flex !== undefined) {
    fail(`${where}: flex field on a piece that is not a flex type`);
  }
  return piece;
}

function readTrain(raw: unknown, n: number, pieces: Map<string, Piece>): Train {
  const where = `Train #${n}`;
  if (!isObj(raw)) return fail(`${where}: not an object`);
  if (typeof raw.id !== 'string' || raw.id === '') fail(`${where}: id must be a non-empty string`);
  const cars = int(raw, 'cars', MAX_CARS, where);
  if (typeof raw.color !== 'string') fail(`${where}: color must be a string`);
  const speed = num(raw, 'speed', where);
  if (speed < 0) fail(`${where}: speed must be >= 0`);
  if (typeof raw.running !== 'boolean') fail(`${where}: running must be a boolean`);
  const train: Train = {
    id: raw.id as string, cars, color: raw.color as string, speed, running: raw.running as boolean,
    head: null, lifted: null, currentSpeed: 0, crashed: false, crashAt: null,
  };
  const h = raw.head;
  if (h !== null && h !== undefined) {
    if (!isObj(h)) return fail(`${where}: head must be an object or null`);
    const p = typeof h.piece === 'string' ? pieces.get(h.piece) : undefined;
    if (!p) return fail(`${where}: head points at missing piece ${JSON.stringify(h.piece)}`);
    const route = h.route;
    if (typeof route !== 'number' || !Number.isInteger(route) || route < 0 || route >= pieceGeometry(p).routes.length) {
      fail(`${where}: head points at missing route ${JSON.stringify(route)}`);
    }
    if (h.direction !== 'forward' && h.direction !== 'backward') fail(`${where}: bad head direction`);
    train.head = {
      pieceId: p.id, route: route as number, dist: num(h, 'distance', `${where} head`),
      dir: h.direction === 'forward' ? 1 : -1,
    };
  } else {
    const l = raw.lifted;
    if (!isObj(l)) return fail(`${where}: a train without a head must have a lifted pose`);
    train.lifted = { x: num(l, 'x', `${where} lifted`), y: num(l, 'y', `${where} lifted`), rot: num(l, 'rotation', `${where} lifted`) };
  }
  return train;
}

export function deserialize(text: string): { ok: true; layout: Layout } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + (e instanceof Error ? e.message : String(e)) };
  }
  try {
    if (!isObj(data) || data.format !== FORMAT) fail(`Not a track layout file (format must be "${FORMAT}")`);
    const d = data as Obj;
    if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) fail('version must be an integer ≥ 1');
    if ((d.version as number) > VERSION) fail(`Unsupported version ${d.version} (this app reads up to ${VERSION})`);
    if (!Array.isArray(d.pieces)) fail('pieces must be an array');
    if (!Array.isArray(d.trains)) fail('trains must be an array');

    const layout = emptyLayout();
    if (d.style !== undefined) {
      if (!STYLES.includes(d.style as StyleId)) fail(`unknown style ${JSON.stringify(d.style)}`);
      layout.style = d.style as StyleId;
    }
    if (d.settings !== undefined) {
      if (!isObj(d.settings)) fail('settings must be an object');
      for (const k of Object.keys(layout.settings) as (keyof Layout['settings'])[]) {
        const v = (d.settings as Obj)[k];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') fail(`settings.${k} must be a boolean`);
        layout.settings[k] = v as boolean;
      }
    }

    const ids = new Set<string>();
    const claim = (id: string) => { if (ids.has(id)) fail(`duplicate id "${id}"`); ids.add(id); };
    const byId = new Map<string, Piece>();
    (d.pieces as unknown[]).forEach((raw, i) => {
      const p = readPiece(raw, i + 1);
      claim(p.id);
      byId.set(p.id, p);
      layout.pieces.push(p);
    });
    (d.trains as unknown[]).forEach((raw, i) => {
      const t = readTrain(raw, i + 1, byId);
      claim(t.id);
      layout.trains.push(t);
    });
    return { ok: true, layout };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}

function defaultStorage(): Storage | undefined {
  try { return (globalThis as { localStorage?: Storage }).localStorage; } catch { return undefined; }
}

export function saveAutosave(layout: Layout, storage: Storage | undefined = defaultStorage()): void {
  try { storage?.setItem(AUTOSAVE_KEY, serialize(layout)); } catch { /* storage unavailable or full */ }
}

export function loadAutosave(storage: Storage | undefined = defaultStorage()): Layout | null {
  try {
    const text = storage?.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    const r = deserialize(text);
    if (r.ok) return r.layout;
    console.warn(`Autosave rejected (${r.error}); kept a copy under "${AUTOSAVE_REJECTED_KEY}".`);
    try { storage?.setItem(AUTOSAVE_REJECTED_KEY, text); } catch { /* storage full or unavailable */ }
    return null;
  } catch { return null; }
}
