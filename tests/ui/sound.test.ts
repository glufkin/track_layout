import { test, expect } from 'vitest';
import { Clicker, SOUND_PREF_KEY, MIN_CLICK_MS } from '../../src/ui/sound';

function fakeCtx() {
  const started: { freq: number; gain: number }[] = [];
  let resumed = 0;
  const ctx = {
    currentTime: 0,
    state: 'suspended',
    destination: {},
    resume() { resumed++; ctx.state = 'running'; return Promise.resolve(); },
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
    },
    createOscillator() {
      const o = {
        type: 'sine', frequency: { value: 0, setValueAtTime(v: number) { o.frequency.value = v; } },
        connect(g: unknown) { (o as any).g = g; }, start() { started.push({ freq: o.frequency.value, gain: 0 }); }, stop() {},
      };
      return o;
    },
  };
  return { ctx: ctx as unknown as AudioContext, started, resumes: () => resumed };
}

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
}

function make(t = { v: 0 }) {
  const f = fakeCtx();
  const storage = memStorage();
  const c = new Clicker({ ctxFactory: () => f.ctx, now: () => t.v, storage });
  c.unlock();
  return { c, f, t, storage };
}

test('rate limit: 5 ticks within 30 ms start 1 source; 50 ms apart start 2', () => {
  const a = make();
  for (let i = 0; i < 5; i++) { a.t.v = i * 7; a.c.tick(); }
  expect(a.f.started.length).toBe(1);
  const b = make();
  b.c.tick(); b.t.v = 50; b.c.tick();
  expect(b.f.started.length).toBe(2);
  expect(MIN_CLICK_MS).toBe(40);
});

test('settle shares the rate limit; bonk does not', () => {
  const a = make();
  a.c.tick(); a.t.v = 10; a.c.settle();
  expect(a.f.started.length).toBe(1);
  a.c.bonk(); a.c.bonk();
  expect(a.f.started.length).toBe(3);
});

test('mute stores off and silences; re-enable stores on', () => {
  const a = make();
  a.c.setEnabled(false);
  expect(a.storage.getItem(SOUND_PREF_KEY)).toBe('off');
  a.c.tick(); a.c.settle(); a.c.bonk();
  expect(a.f.started.length).toBe(0);
  a.c.setEnabled(true);
  expect(a.storage.getItem(SOUND_PREF_KEY)).toBe('on');
  a.c.tick();
  expect(a.f.started.length).toBe(1);
});

test('preference loads from storage', () => {
  const storage = memStorage();
  storage.setItem(SOUND_PREF_KEY, 'off');
  expect(new Clicker({ storage }).enabled).toBe(false);
});

test('throwing storage does not throw and leaves default on', () => {
  const storage = {
    getItem() { throw new Error('x'); },
    setItem() { throw new Error('x'); },
  } as unknown as Storage;
  const c = new Clicker({ storage, ctxFactory: () => null });
  expect(c.enabled).toBe(true);
  expect(() => c.setEnabled(false)).not.toThrow();
  expect(c.enabled).toBe(false);
});

test('no audio context: everything is a no-op', () => {
  const c = new Clicker({ ctxFactory: () => null, storage: null });
  expect(() => { c.unlock(); c.tick(); c.settle(); c.bonk(); }).not.toThrow();
});

test('sounds are no-ops before unlock; unlock resumes a suspended context', () => {
  const f = fakeCtx();
  const c = new Clicker({ ctxFactory: () => f.ctx, now: () => 0, storage: null });
  c.tick();
  expect(f.started.length).toBe(0);
  c.unlock();
  expect(f.resumes()).toBe(1);
  c.unlock();
  expect(f.resumes()).toBe(1);
});

test('tick pitch varies within +-8%; settle is lower than tick; bonk ~120 Hz', () => {
  const a = make();
  const freqs: number[] = [];
  for (let i = 0; i < 30; i++) { a.t.v = i * 100; a.c.tick(); }
  for (const s of a.f.started) freqs.push(s.freq);
  const base = (Math.min(...freqs) + Math.max(...freqs)) / 2;
  expect(Math.max(...freqs) / Math.min(...freqs)).toBeLessThanOrEqual(1.08 / 0.92 + 1e-9);
  expect(new Set(freqs).size).toBeGreaterThan(1);
  const b = make();
  b.c.settle();
  expect(b.f.started[0].freq).toBeLessThan(Math.min(...freqs));
  b.c.bonk();
  expect(b.f.started[1].freq).toBeCloseTo(120, -1);
  expect(base).toBeGreaterThan(0);
});
