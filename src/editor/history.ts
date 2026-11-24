import type { Doc } from '../model/doc';

export interface Command { label: string; do(doc: Doc): void; undo(doc: Doc): void }

export class History {
  onChange?: () => void;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private limit = 200) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  exec(cmd: Command, doc: Doc): void {
    cmd.do(doc);
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }

  undo(doc: Doc): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo(doc);
    this.redoStack.push(cmd);
    this.onChange?.();
    return true;
  }

  redo(doc: Doc): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.do(doc);
    this.undoStack.push(cmd);
    this.onChange?.();
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange?.();
  }
}
