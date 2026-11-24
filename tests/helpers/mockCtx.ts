export interface Call {
  name: string; args: unknown[];
  fillStyle: unknown; strokeStyle: unknown; globalAlpha: unknown; lineWidth: unknown;
}

/** A Proxy canvas context: records every method call (with the paint state at that moment) and accepts any property. */
export function mockContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let state: Record<string | symbol, unknown> = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, lineWidth: 1 };
  const stack: Array<Record<string | symbol, unknown>> = [];
  // Whatever a method returns (gradients, etc.) accepts any further call.
  const anything = (): unknown => new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop in state) return state[prop];
      return (...args: unknown[]) => {
        calls.push({
          name: String(prop), args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle,
          globalAlpha: state.globalAlpha, lineWidth: state.lineWidth,
        });
        if (prop === 'save') stack.push({ ...state });
        if (prop === 'restore') state = stack.pop() ?? state;
        return anything();
      };
    },
    set(_t, prop, v) { state[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
