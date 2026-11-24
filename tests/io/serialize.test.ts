import { describe, expect, test } from 'vitest';
import { emptyLayout, type Layout, type Piece, type Train } from '../../src/model/types';
import {
  AUTOSAVE_KEY, FORMAT, VERSION, deserialize, loadAutosave, saveAutosave, serialize,
} from '../../src/io/serialize';

const piece = (id: string, type = 'straight-1', extra: Partial<Piece> = {}): Piece =>
  ({ id, type, x: 0, y: 0, rot: 0, level: 0, flipped: false, ...extra });
const train = (id: string, extra: Partial<Train> = {}): Train => ({
  id, cars: 2, color: '#ff0000', speed: 1.5, running: true, head: null, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null, ...extra,
});
const file = (over: Record<string, unknown>) =>
  JSON.stringify({ format: 'track-layout', version: 1, style: 'wooden', pieces: [], trains: [], ...over });
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
};

const dupIds = file({ pieces: [{ id: 'p1', type: 'straight-1', x: 0, y: 0, rotation: 0, level: 0, flipped: false }, { id: 'p1', type: 'straight-1', x: 1, y: 0, rotation: 0, level: 0, flipped: false }] });
const unknownType = file({ pieces: [{ id: 'p1', type: 'foo', x: 0, y: 0, rotation: 0, level: 0, flipped: false }] });
const nanCoord = file({ pieces: [{ id: 'p1', type: 'straight-1', x: null, y: 0, rotation: 0, level: 0, flipped: false }] });
const trainBadRef = file({
  trains: [{ id: 't1', cars: 1, color: 'red', speed: 1, running: false, head: { piece: 'nope', route: 0, distance: 0, direction: 'forward' }, lifted: null }],
});
const goodPiece = { id: 'p1', type: 'straight-1', x: 0, y: 0, rotation: 0, level: 0, flipped: false };
const goodTrain = { id: 't1', cars: 1, color: 'red', speed: 1, running: false, head: null, lifted: { x: 1, y: 2, rotation: 3 } };

describe('serialize', () => {
  test('constants', () => {
    expect([FORMAT, VERSION, AUTOSAVE_KEY]).toEqual(['track-layout', 1, 'track-layout:autosave']);
  });

  test('round trip preserves pieces, trains, settings, style', () => {
    const l: Layout = {
      style: 'brick',
      settings: { collisions: false, hillEffect: true, gridVisible: false },
      pieces: [
        piece('p1', 'switch', { x: 1.5, y: -2, rot: 90, level: 1, flipped: true, switch: { mode: 'auto', state: 1 } }),
        piece('p2'),
      ],
      trains: [
        train('t1', { head: { pieceId: 'p2', route: 0, dist: 0.75, dir: -1 } }),
        train('t2', { cars: 0, running: false, lifted: { x: 3, y: 4, rot: 45 } }),
      ],
    };
    const r = deserialize(serialize(l));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layout).toEqual(l);
  });

  test('transient fields are not written and reset on load', () => {
    const l = emptyLayout();
    l.pieces.push(piece('p1'));
    l.trains.push(train('t1', { currentSpeed: 2, crashed: true, crashAt: { x: 1, y: 1 }, head: { pieceId: 'p1', route: 0, dist: 0, dir: 1 } }));
    const s = serialize(l);
    expect(s).not.toMatch(/currentSpeed|crashed|crashAt/);
    const r = deserialize(s);
    if (!r.ok) throw new Error(r.error);
    expect(r.layout.trains[0]).toMatchObject({ currentSpeed: 0, crashed: false, crashAt: null });
  });

  test('numbers are rounded to 6 decimals', () => {
    const l = emptyLayout();
    l.pieces.push(piece('p1', 'straight-1', { x: 1 / 3 }));
    expect(JSON.parse(serialize(l)).pieces[0].x).toBe(0.333333);
  });

  test('output is pretty-printed and contains no join data', () => {
    const s = serialize(emptyLayout());
    expect(s).toContain('\n  "format": "track-layout"');
    expect(s).not.toMatch(/join/i);
  });

  test('a switch piece without a switch block gets manual/0; non-switch has none', () => {
    const r = deserialize(file({ pieces: [{ ...goodPiece, id: 'a', type: 'switch' }, goodPiece] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.layout.pieces[0].switch).toEqual({ mode: 'manual', state: 0 });
    expect(r.layout.pieces[1].switch).toBeUndefined();
  });

  test('missing settings get defaults (collisions on, hills off, grid on); partial settings fill gaps', () => {
    const r = deserialize(file({}));
    if (!r.ok) throw new Error(r.error);
    expect(r.layout.settings).toEqual({ collisions: true, hillEffect: false, gridVisible: true });
    const r2 = deserialize(file({ settings: { hillEffect: true } }));
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.layout.settings).toEqual({ collisions: true, hillEffect: true, gridVisible: true });
  });

  test('missing style defaults to wooden; bad style rejected', () => {
    const r = deserialize(JSON.stringify({ format: 'track-layout', version: 1, pieces: [], trains: [] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.layout.style).toBe('wooden');
    expect(deserialize(file({ style: 'lego' })).ok).toBe(false);
  });

  test('accepts a valid file with a lifted train', () => {
    const r = deserialize(file({ pieces: [goodPiece], trains: [goodTrain] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.layout.trains[0].lifted).toEqual({ x: 1, y: 2, rot: 3 });
  });

  test.each([
    ['{}', /format/],
    ['null', /format/],
    ['{"format":"track-layout","version":2,"pieces":[],"trains":[]}', /version/],
    [file({ pieces: {} }), /pieces/],
    [file({ trains: 'x' }), /trains/],
    [dupIds, /duplicate id "p1"/],
    [file({ pieces: [goodPiece], trains: [{ ...goodTrain, id: 'p1' }] }), /duplicate id "p1"/],
    [unknownType, /Piece #1: unknown type "foo"/],
    [nanCoord, /x/],
    [file({ pieces: [{ ...goodPiece, level: 4 }] }), /level/],
    [file({ pieces: [{ ...goodPiece, level: 1.5 }] }), /level/],
    [file({ pieces: [{ ...goodPiece, switch: { mode: 'manual', state: 0 } }] }), /switch/],
    [file({ pieces: [{ ...goodPiece, type: 'switch', switch: { mode: 'weird', state: 0 } }] }), /mode/],
    [file({ pieces: [{ ...goodPiece, type: 'switch', switch: { mode: 'auto', state: 2 } }] }), /state/],
    [file({ trains: [{ ...goodTrain, cars: 21 }] }), /cars/],
    [file({ trains: [{ ...goodTrain, cars: 1.5 }] }), /cars/],
    [file({ trains: [{ ...goodTrain, color: 5 }] }), /color/],
    [file({ trains: [{ ...goodTrain, speed: -1 }] }), /speed/],
    [file({ trains: [{ ...goodTrain, running: 'yes' }] }), /running/],
    [trainBadRef, /missing piece/],
    [file({ pieces: [goodPiece], trains: [{ ...goodTrain, head: { piece: 'p1', route: 5, distance: 0, direction: 'forward' }, lifted: null }] }), /route/],
    [file({ pieces: [goodPiece], trains: [{ ...goodTrain, head: { piece: 'p1', route: 0, distance: 0, direction: 'sideways' }, lifted: null }] }), /direction/],
    ['not json', /JSON/],
  ])('rejects bad file %#', (text, msg) => {
    const r = deserialize(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe('autosave', () => {
  test('round trips through storage', () => {
    const st = memStorage();
    const l = emptyLayout();
    l.pieces.push(piece('p1'));
    saveAutosave(l, st);
    expect(st.getItem(AUTOSAVE_KEY)).not.toBeNull();
    expect(loadAutosave(st)).toEqual(l);
  });

  test('empty or corrupt storage gives null', () => {
    const st = memStorage();
    expect(loadAutosave(st)).toBeNull();
    st.setItem(AUTOSAVE_KEY, 'garbage');
    expect(loadAutosave(st)).toBeNull();
  });

  test('survives a throwing storage', () => {
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } as unknown as Storage;
    expect(() => saveAutosave(emptyLayout(), bad)).not.toThrow();
    expect(loadAutosave(bad)).toBeNull();
  });

  test('default storage does not throw in node', () => {
    expect(() => saveAutosave(emptyLayout())).not.toThrow();
    expect(loadAutosave()).toBeNull();
  });
});
