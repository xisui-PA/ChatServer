import {
  DEFAULT_MEMORY_TOKEN_LIMIT,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_ID_CHARS,
  MAX_MEMORY_TOKEN_LIMIT,
  MEMORY_CLEANUP_INTERVAL_MS,
  MEMORY_NOTE_TOKENS,
  MEMORY_RETENTION_MS,
  MIN_MEMORY_TOKEN_LIMIT
} from '../limit';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConversationMessage, OutgoingMessage } from '../messagers/interface';
import { countTokens, limitTextTokens } from '../models/tokens';
import { ConversationMemory, MemoryNote, MemoryNoteKind, MemoryUpdates, SentReply } from './interface';

interface MemoryFile extends ConversationMemory {
  version: 1;
}

/** Checks disk data before it can become prompt context. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Parses only supported fields; expiry is always derived from source time. */
function parseFile(value: unknown): ConversationMemory {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.notes) || !Array.isArray(value.replies)) {
    throw new Error('Expected a version 1 conversation memory file.');
  }
  const notes = value.notes.map((note: unknown): MemoryNote => {
    if (!isRecord(note) || typeof note.id !== 'string' || note.id.length > MAX_MEMORY_ID_CHARS ||
      typeof note.kind !== 'string' || !['summary', 'fact', 'question', 'inference'].includes(note.kind) ||
      typeof note.text !== 'string' || !isTimestamp(note.sourceTimestamp)) {
      throw new Error('Invalid stored memory note.');
    }
    return {
      id: note.id,
      kind: note.kind as MemoryNoteKind,
      text: note.text,
      sourceTimestamp: note.sourceTimestamp,
      expiresAt: new Date(Date.parse(note.sourceTimestamp) + MEMORY_RETENTION_MS).toISOString()
    };
  });
  const replies = value.replies.map((reply: unknown): SentReply => {
    if (!isRecord(reply) || typeof reply.id !== 'string' || reply.id.length > MAX_MEMORY_ID_CHARS ||
      typeof reply.text !== 'string' || !isTimestamp(reply.sentAt) ||
      (reply.channel !== undefined && typeof reply.channel !== 'string') ||
      (reply.direct !== undefined && typeof reply.direct !== 'boolean')) {
      throw new Error('Invalid stored sent reply.');
    }
    return {
      id: reply.id,
      text: reply.text,
      sentAt: reply.sentAt,
      expiresAt: new Date(Date.parse(reply.sentAt) + MEMORY_RETENTION_MS).toISOString(),
      channel: reply.channel,
      direct: reply.direct
    };
  });
  return { notes, replies };
}

/** Removes expired entries, then evicts oldest context to meet the shared budget. */
function prune(memory: ConversationMemory, now: number, tokenLimit: number): ConversationMemory {
  const notes = memory.notes.filter((note) =>
    Date.parse(note.sourceTimestamp) <= now && Date.parse(note.expiresAt) > now);
  const replies = memory.replies.filter((reply) =>
    Date.parse(reply.sentAt) <= now && Date.parse(reply.expiresAt) > now);
  notes.sort((a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp));
  replies.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  while (countTokens(JSON.stringify({ notes, replies })) > tokenLimit) {
    if (notes.length > 0 && (replies.length === 0 ||
      Date.parse(notes[0].sourceTimestamp) <= Date.parse(replies[0].sentAt))) {
      notes.shift();
    } else if (replies.length > 0) {
      replies.shift();
    } else {
      break;
    }
  }
  return { notes, replies };
}

/** Owns per-conversation memory files and serializes pruning with atomic writes. */
export class ConversationMemoryStore {
  private readonly directory: string;
  private operations: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly tokenLimits = new Map<string, number>();

  public constructor(configDir: string) {
    this.directory = path.join(configDir, 'conversations');
  }

  /** Prunes inactive conversations too, including those not seen since restart. */
  public async start(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup().catch((error: unknown) => console.error('[memory] cleanup failed:', error));
    }, MEMORY_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  public async close(): Promise<void> {
    clearInterval(this.timer);
    await this.operations;
  }

  /** Loads and prunes context before any model can see it. */
  public load(key: string, tokenLimit = DEFAULT_MEMORY_TOKEN_LIMIT): Promise<ConversationMemory> {
    return this.run(async () => {
      const filePath = this.registerLimit(key, tokenLimit);
      const previous = await this.read(filePath);
      const memory = prune(previous, Date.now(), tokenLimit);
      if (JSON.stringify(memory) !== JSON.stringify(previous)) {
        await this.write(filePath, memory);
      }
      return memory;
    });
  }

  /** Applies model proposals while deriving every expiry from validated sources. */
  public update(key: string, updates: MemoryUpdates, messages: readonly ConversationMessage[], tokenLimit = DEFAULT_MEMORY_TOKEN_LIMIT): Promise<void> {
    return this.run(async () => {
      const now = Date.now();
      const filePath = this.registerLimit(key, tokenLimit);
      const memory = prune(await this.read(filePath), now, tokenLimit);
      const sources = new Map<string, number>();
      for (const note of memory.notes) {
        sources.set(note.id, Date.parse(note.sourceTimestamp));
      }
      for (const reply of memory.replies) {
        sources.set(reply.id, Date.parse(reply.sentAt));
      }
      for (const message of messages) {
        if (message.id !== undefined && isTimestamp(message.timestamp)) {
          sources.set(message.id, Math.min(now, Date.parse(message.timestamp)));
        }
      }
      const forgotten = new Set(updates.forget);
      const notes = memory.notes.filter((note) => !forgotten.has(note.id));
      for (const proposal of updates.notes) {
        const timestamps = proposal.sourceIds.map((id) => sources.get(id));
        if (timestamps.length === 0 || timestamps.some((timestamp) => timestamp === undefined)) {
          console.warn('[memory] discarded note with unknown sources.');
          continue;
        }
        const sourceTime = Math.min(...timestamps as number[]);
        if (sourceTime + MEMORY_RETENTION_MS <= now) {
          continue;
        }
        const text = limitTextTokens(proposal.text, MEMORY_NOTE_TOKENS);
        const duplicate = notes.find((note) => note.kind === proposal.kind && note.text === text) ??
          memory.notes.find((note) => note.kind === proposal.kind && note.text === text);
        // Repeated snapshots cannot refresh an identical note's original age.
        const originalTime = Math.min(sourceTime, duplicate ? Date.parse(duplicate.sourceTimestamp) : sourceTime);
        const note: MemoryNote = {
          id: duplicate?.id ?? `note:${randomUUID()}`,
          kind: proposal.kind,
          text,
          sourceTimestamp: new Date(originalTime).toISOString(),
          expiresAt: new Date(originalTime + MEMORY_RETENTION_MS).toISOString()
        };
        const index = duplicate === undefined ? -1 : notes.indexOf(duplicate);
        if (index >= 0) {
          notes[index] = note;
        } else {
          notes.push(note);
        }
      }
      await this.write(filePath, prune({ notes, replies: memory.replies }, now, tokenLimit));
    });
  }

  /** Called only after the adapter confirms successful delivery. */
  public recordReply(key: string, reply: OutgoingMessage, tokenLimit = DEFAULT_MEMORY_TOKEN_LIMIT): Promise<void> {
    return this.run(async () => {
      const now = Date.now();
      const filePath = this.registerLimit(key, tokenLimit);
      const memory = prune(await this.read(filePath), now, tokenLimit);
      const sent: SentReply = {
        id: `reply:${randomUUID()}`,
        text: reply.text,
        sentAt: new Date(now).toISOString(),
        expiresAt: new Date(now + MEMORY_RETENTION_MS).toISOString(),
        channel: reply.channel,
        direct: reply.direct
      };
      await this.write(filePath, prune({ notes: memory.notes, replies: [...memory.replies, sent] }, now, tokenLimit));
    });
  }

  private filePath(key: string): string {
    return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /** Runtime conversation identity selects its pipeline's budget, not a global limit. */
  private registerLimit(key: string, tokenLimit: number): string {
    if (!Number.isInteger(tokenLimit) || tokenLimit < MIN_MEMORY_TOKEN_LIMIT || tokenLimit > MAX_MEMORY_TOKEN_LIMIT) {
      throw new RangeError(`Memory token limit must be between ${MIN_MEMORY_TOKEN_LIMIT} and ${MAX_MEMORY_TOKEN_LIMIT}.`);
    }
    const filePath = this.filePath(key);
    this.tokenLimits.set(filePath, tokenLimit);
    return filePath;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    this.operations = task.then(() => {}, () => {});
    return task;
  }

  private async read(filePath: string): Promise<ConversationMemory> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_MEMORY_FILE_BYTES) {
        throw new Error(`Conversation memory file exceeds ${MAX_MEMORY_FILE_BYTES / 1024} KiB.`);
      }
      return parseFile(JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { notes: [], replies: [] };
      }
      throw error;
    }
  }

  /** Same-directory rename prevents readers from seeing a partially written JSON file. */
  private async write(filePath: string, memory: ConversationMemory): Promise<void> {
    if (memory.notes.length === 0 && memory.replies.length === 0) {
      await fs.rm(filePath, { force: true });
      return;
    }
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    const payload: MemoryFile = { version: 1, ...memory };
    try {
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private cleanup(): Promise<void> {
    return this.run(async () => {
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) {
          const filePath = path.join(this.directory, entry.name);
          try {
            const previous = await this.read(filePath);
            // Hashed filenames do not reveal their pipeline before the first turn.
            // Preserve larger memories at startup; enforce the owning limit on load.
            const memory = prune(previous, Date.now(), this.tokenLimits.get(filePath) ?? MAX_MEMORY_TOKEN_LIMIT);
            if ((memory.notes.length === 0 && memory.replies.length === 0) ||
              JSON.stringify(memory) !== JSON.stringify(previous)) {
              await this.write(filePath, memory);
            }
          } catch (error) {
            // Preserve malformed files for inspection; one bad file cannot stop startup.
            console.warn(`[memory] unable to prune ${filePath}:`, error);
          }
        }
      }
    });
  }
}
