import { test, expect, vi } from 'vitest';
import { History, type Command } from '../../src/editor/history';
import { Doc } from '../../src/model/doc';
import { emptyLayout } from '../../src/model/types';

const counter = (): Command => ({ label: 'inc', do: (d) => { d.layout.settings.collisions = !d.layout.settings.collisions; }, undo: (d) => { d.layout.settings.collisions = !d.layout.settings.collisions; } });

test('exec/undo/redo', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(counter(), d);
  expect(d.layout.settings.collisions).toBe(false);
  expect(h.canUndo).toBe(true);
  expect(h.undo(d)).toBe(true);
  expect(d.layout.settings.collisions).toBe(true);
  expect(h.redo(d)).toBe(true);
  expect(d.layout.settings.collisions).toBe(false);
  expect(h.redo(d)).toBe(false);
});
test('exec after undo clears redo', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(counter(), d); h.undo(d);
  expect(h.canRedo).toBe(true);
  h.exec(counter(), d);
  expect(h.canRedo).toBe(false);
});
test('limit 200 drops oldest', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  for (let i = 0; i < 201; i++) h.exec(counter(), d);
  for (let i = 0; i < 200; i++) expect(h.undo(d)).toBe(true);
  expect(h.undo(d)).toBe(false);
});
test('onChange fires after exec/undo/redo/clear', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.onChange = vi.fn();
  h.exec(counter(), d); h.undo(d); h.redo(d); h.clear();
  expect(h.onChange).toHaveBeenCalledTimes(4);
  expect(h.canUndo).toBe(false);
});

test('a throwing undo or redo keeps the command on its stack', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  let fail = false;
  const cmd: Command = {
    label: 'flaky',
    do: () => { if (fail) throw new Error('redo boom'); },
    undo: () => { if (fail) throw new Error('undo boom'); },
  };
  h.exec(cmd, d);
  fail = true;
  expect(() => h.undo(d)).toThrow('undo boom');
  expect([h.canUndo, h.canRedo]).toEqual([true, false]);
  fail = false;
  h.undo(d);
  fail = true;
  expect(() => h.redo(d)).toThrow('redo boom');
  expect([h.canUndo, h.canRedo]).toEqual([false, true]);
  fail = false;
  expect(h.redo(d)).toBe(true);
});
