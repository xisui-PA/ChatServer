import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Optional operator-written background shared by pipelines using a registered messager. */
export class MessagerContextFile {
  public readonly path: string;

  public constructor(configDir: string, messagerName: string) {
    this.path = path.join(configDir, `${messagerName}_context`);
  }

  /** Read each turn so additions, edits, and deletion apply without creating any files. */
  public async load(): Promise<string | undefined> {
    try {
      return (await fs.readFile(this.path, 'utf8')).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[context] unable to read ${this.path}; continuing without additional context:`,
          error instanceof Error ? error.message : String(error));
      }
      return undefined;
    }
  }
}
