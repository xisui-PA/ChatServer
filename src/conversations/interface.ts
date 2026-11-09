import {
  MAX_MEMORY_FORGET_IDS,
  MAX_MEMORY_ID_CHARS,
  MAX_MEMORY_NOTES_PER_UPDATE,
  MAX_MEMORY_NOTE_CHARS,
  MAX_MEMORY_SOURCE_IDS
} from '../limit';
import { isRecord, isString } from '../type-guards';
/** Model-written context, distinguished from confirmed chat delivery history. */
export type MemoryNoteKind = 'summary' | 'fact' | 'question' | 'inference';

export interface MemoryNote {
  id: string;
  kind: MemoryNoteKind;
  text: string;
  /** Earliest original source time; summarization never refreshes it. */
  sourceTimestamp: string;
  expiresAt: string;
}

export interface SentReply {
  id: string;
  text: string;
  /** Generated cache IDs remain available even when older labels leave the prompt budget. */
  imageIds?: readonly string[];
  sentAt: string;
  expiresAt: string;
  channel?: string;
  direct?: boolean;
}

/** Bounded context supplied to filters and repliers as untrusted data. */
export interface ConversationMemory {
  notes: readonly MemoryNote[];
  replies: readonly SentReply[];
}

/** Proposed notes cite snapshot messages or existing memory entries. */
export interface MemoryUpdates {
  notes: readonly { kind: MemoryNoteKind; text: string; sourceIds: readonly string[] }[];
  forget: readonly string[];
}

/** Validates model output before any memory changes can reach the filesystem. */
export function parseMemoryUpdates(value: unknown): MemoryUpdates {
  if (!isRecord(value) ||
    !('notes' in value) || !Array.isArray(value.notes) || value.notes.length > MAX_MEMORY_NOTES_PER_UPDATE ||
    !('forget' in value) || !Array.isArray(value.forget) || value.forget.length > MAX_MEMORY_FORGET_IDS ||
    !value.forget.every((id: unknown) => isString(id) && id.length <= MAX_MEMORY_ID_CHARS)) {
    throw new Error('Reply model memoryUpdates must contain notes and forget arrays.');
  }
  const notes = value.notes.map((note: unknown) => {
    if (!isRecord(note) ||
      !('kind' in note) || !isString(note.kind) ||
      !['summary', 'fact', 'question', 'inference'].includes(note.kind) ||
      !('text' in note) || !isString(note.text) || !note.text.trim() || note.text.length > MAX_MEMORY_NOTE_CHARS ||
      !('sourceIds' in note) || !Array.isArray(note.sourceIds) ||
      note.sourceIds.length === 0 || note.sourceIds.length > MAX_MEMORY_SOURCE_IDS ||
      !note.sourceIds.every((id: unknown) => isString(id) && id.length > 0 && id.length <= MAX_MEMORY_ID_CHARS)) {
      throw new Error('Each memory note needs a kind, nonempty text, and valid sourceIds.');
    }
    return {
      kind: note.kind as MemoryNoteKind,
      text: note.text.trim(),
      sourceIds: note.sourceIds as string[]
    };
  });
  return { notes, forget: value.forget as string[] };
}
