export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export const MAX_INSTRUCTION_CHARS = 24_000;

export function shouldSubmitComposer(event: ComposerKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function instructionError(instruction: string): string | null {
  if (!instruction.trim()) return "Write a message first.";
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return `The message exceeds the ${MAX_INSTRUCTION_CHARS.toLocaleString()} character limit.`;
  }
  return null;
}
