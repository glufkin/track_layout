// Generated click sounds (spec §5.9). Web Audio only; no audio files.
export const SOUND_PREF_KEY = 'track-layout:sound';
export const MIN_CLICK_MS = 40;

const TICK_HZ = 1800;
const SETTLE_HZ = 1100;
const BONK_HZ = 120;
const TICK_GAIN = 0.06; // about -24 dBFS
const TICK_S = 0.015;
const BONK_S = 0.08;
const PITCH_JITTER = 0.08;

export interface ClickerOptions {
  ctxFactory?: () => AudioContext | null;
  now?: () => number;
  storage?: Storage | null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class Clicker {
  enabled = true;
  private ctx: AudioContext | null = null;
  private last = -Infinity;
  private readonly ctxFactory: () => AudioContext | null;
  private readonly now: () => number;
  private readonly storage: Storage | null;

  constructor(opts: ClickerOptions = {}) {
    this.ctxFactory =
      opts.ctxFactory ?? (() => (typeof AudioContext !== 'undefined' ? new AudioContext() : null));
    this.now = opts.now ?? (() => performance.now());
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    try {
      if (this.storage?.getItem(SOUND_PREF_KEY) === 'off') this.enabled = false;
    } catch {
      /* keep default */
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      this.storage?.setItem(SOUND_PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* preference just isn't persisted */
    }
  }

  /** Create or resume the context; call from a user gesture. */
  unlock(): void {
    try {
      if (!this.ctx) this.ctx = this.ctxFactory();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  tick(): void {
    if (this.limited()) return;
    this.blip(TICK_HZ * this.jitter(), TICK_S, TICK_GAIN);
  }

  /** The commit sound: bypasses the rate limit (it must not be lost to the last tick) but counts for it. */
  settle(): void {
    if (!this.enabled || !this.ctx) return;
    this.last = this.now();
    this.blip(SETTLE_HZ * this.jitter(), TICK_S * 1.5, TICK_GAIN);
  }

  bonk(): void {
    this.blip(BONK_HZ, BONK_S, TICK_GAIN);
  }

  /** True when the click must be dropped; otherwise records it. */
  private limited(): boolean {
    if (!this.enabled || !this.ctx) return true;
    const t = this.now();
    if (t - this.last < MIN_CLICK_MS) return true;
    this.last = t;
    return false;
  }

  private jitter(): number {
    return 1 + (Math.random() * 2 - 1) * PITCH_JITTER;
  }

  private blip(freq: number, dur: number, gain: number): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx) return;
    try {
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur);
    } catch {
      /* audio is best-effort */
    }
  }
}
