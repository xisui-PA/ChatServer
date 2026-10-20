import os from 'node:os';
import path from 'node:path';

/**
 * Returns the platform-appropriate per-user config folder.
 */
export function getDefaultConfigDir(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();

  switch (platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'chatserver');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'chatserver');
    default: {
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
      return path.join(configHome, 'chatserver');
    }
  }
}
