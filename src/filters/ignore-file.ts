import { promises as fsp } from 'node:fs';

/**
 * Supplies the sender IDs a filter should match against.
 *
 * Implementations may read from memory or from a file, so the list can be refreshed
 * without recreating the filter.
 */
export interface SenderIdSource {
  getSenderIds(): ReadonlySet<string> | Promise<ReadonlySet<string>>;
}

export interface IgnoreFileOptions {
  /**
   * How often to check the file for changes, in milliseconds.
   * Defaults to 1000. Set to 0 to check on every lookup.
   */
  reloadIntervalMs?: number;
}

/**
 * Parses an ignore list file.
 *
 * Entries are comma separated. Newlines also separate entries, so one ID per line works
 * too. Blank entries are skipped and lines starting with `#` are treated as comments.
 */
export function parseIgnoreList(contents: string): Set<string> {
  const senderIds = new Set<string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    for (const entry of line.split(',')) {
      const senderId = entry.trim();
      if (senderId !== '') {
        senderIds.add(senderId);
      }
    }
  }

  return senderIds;
}

/**
 * Reads sender IDs from a file and reloads them when the file changes.
 *
 * A missing or unreadable file yields an empty list, so the filter simply abstains.
 */
export class IgnoreFile implements SenderIdSource {
  public readonly path: string;

  private readonly reloadIntervalMs: number;
  private senderIds: ReadonlySet<string> = new Set();
  private lastModifiedMs = -1;
  private lastCheckedMs = 0;
  private warned = false;
  private pending?: Promise<void>;

  public constructor(filePath: string, options: IgnoreFileOptions = {}) {
    this.path = filePath;
    this.reloadIntervalMs = options.reloadIntervalMs ?? 1000;
  }

  /**
   * Reads the file once, so startup can log what was picked up.
   */
  public async load(): Promise<void> {
    await this.refreshIfChanged();
  }

  public async getSenderIds(): Promise<ReadonlySet<string>> {
    await this.refreshIfChanged();
    return this.senderIds;
  }

  /**
   * Reads the file when its modification time changed since the last check.
   * Concurrent callers share one in-flight read.
   */
  private async refreshIfChanged(): Promise<void> {
    if (this.pending === undefined) {
      this.pending = this.readIfChanged().finally(() => {
        this.pending = undefined;
      });
    }
    await this.pending;
  }

  private async readIfChanged(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheckedMs < this.reloadIntervalMs) {
      return;
    }
    this.lastCheckedMs = now;

    let modifiedMs: number;
    try {
      modifiedMs = (await fsp.stat(this.path)).mtimeMs;
    } catch {
      // Missing file: nothing to ignore.
      this.senderIds = new Set();
      this.lastModifiedMs = -1;
      return;
    }

    if (modifiedMs === this.lastModifiedMs) {
      return;
    }

    try {
      this.senderIds = parseIgnoreList(await fsp.readFile(this.path, 'utf8'));
      this.lastModifiedMs = modifiedMs;
      console.log(`[filter] ignore list loaded from ${this.path} (${this.senderIds.size} sender(s))`);
    } catch (error) {
      if (!this.warned) {
        console.warn(`[filter] unable to read ignore list ${this.path}: ${(error as Error).message}`);
        this.warned = true;
      }
    }
  }
}
