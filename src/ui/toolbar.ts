import { MAX_LEVEL, type StyleId } from '../model/types';
import { STYLES } from '../render/style';
import type { App } from './app';

function button(label: string, action: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.action = action;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'tl-sep';
  return s;
}

function checkbox(label: string, action: string, onChange: (v: boolean) => void): { wrap: HTMLLabelElement; box: HTMLInputElement } {
  const wrap = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.action = action;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, label);
  return { wrap, box };
}

/** The top toolbar (spec §5.12): file, history, style, level, settings, view and play controls. */
export function buildToolbar(app: App, el: HTMLElement): void {
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void f.text().then((t) => app.openText(t));
  });

  const undo = button('Undo', 'undo', () => app.undo(), 'Undo (Ctrl-Z)');
  const redo = button('Redo', 'redo', () => app.redo(), 'Redo (Ctrl-Shift-Z / Ctrl-Y)');

  const style = document.createElement('select');
  style.dataset.action = 'style';
  style.title = 'Style';
  for (const s of Object.values(STYLES)) style.add(new Option(s.name, s.id));
  style.addEventListener('change', () => { app.style = style.value as StyleId; });

  const level = document.createElement('select');
  level.dataset.action = 'level';
  level.title = 'Level for loose pieces';
  for (let l = 0; l <= MAX_LEVEL; l++) level.add(new Option('Level ' + l, String(l)));
  level.addEventListener('change', () => { app.level = Number(level.value); app.notify(); });

  const collide = checkbox('Collisions', 'collisions', (v) => { app.doc.layout.settings.collisions = v; app.changed(); });
  const hills = checkbox('Hills', 'hills', (v) => { app.doc.layout.settings.hillEffect = v; app.changed(); });
  const grid = button('Grid', 'grid', () => {
    app.doc.layout.settings.gridVisible = !app.doc.layout.settings.gridVisible;
    app.changed();
  }, 'Show or hide the grid');
  const fit = button('Fit', 'fit', () => app.fit(), 'Fit the layout in view');
  const play = button('', 'play', () => app.togglePlay());

  el.append(
    button('New', 'new', () => app.newLayout()),
    button('Open', 'open', () => file.click()),
    button('Save', 'save', () => app.save()),
    file, sep(), undo, redo, sep(), style, level, sep(), collide.wrap, hills.wrap, sep(), grid, fit, sep(), play,
  );

  const update = (): void => {
    undo.disabled = !app.history.canUndo;
    redo.disabled = !app.history.canRedo;
    style.value = app.style;
    level.value = String(app.level);
    collide.box.checked = app.doc.layout.settings.collisions;
    hills.box.checked = app.doc.layout.settings.hillEffect;
    grid.setAttribute('aria-pressed', String(app.doc.layout.settings.gridVisible));
    play.textContent = app.sim.paused ? '▶ Play' : '⏸ Pause';
  };
  app.onChange(update);
  update();
}
