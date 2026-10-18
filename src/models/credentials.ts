import { execFile, spawn } from 'node:child_process';

/**
 * Service name used for every credential this project stores, keeping ChatServer keys
 * separate from anything else in the OS credential manager.
 */
export const CREDENTIAL_SERVICE = 'chatserver-models';

/**
 * Raised when credentials cannot be read from or written to the OS credential manager.
 */
export class CredentialError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * Stores and retrieves secrets in the operating system's credential manager.
 */
export interface CredentialStore {
  /** Human-readable backend name, used in logs and errors. */
  readonly name: string;
  /** Returns the secret for `account`, or undefined when nothing is stored. */
  get(account: string): Promise<string | undefined>;
  /** Creates or replaces the secret for `account`. */
  set(account: string, secret: string): Promise<void>;
  /** Removes the secret for `account`, ignoring entries that do not exist. */
  delete(account: string): Promise<void>;
}

/**
 * Runs a command and resolves with its standard output.
 */
function run(
  command: string,
  args: string[],
  environment?: NodeJS.ProcessEnv
): Promise<string> {
  const env = environment === undefined ? process.env : { ...process.env, ...environment };

  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', env }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Runs a command, writing `input` to its standard input.
 */
function runWithInput(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`));
    });

    child.stdin.end(input);
  });
}

/**
 * Removes a single trailing newline without touching other whitespace in a secret.
 */
function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

/**
 * Escapes a value for use inside a single-quoted PowerShell string.
 */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * macOS backend built on the `security` command (Keychain).
 */
class MacOsKeychainStore implements CredentialStore {
  public readonly name = 'macOS Keychain';

  public async get(account: string): Promise<string | undefined> {
    try {
      const stdout = await run('security', [
        'find-generic-password',
        '-s',
        CREDENTIAL_SERVICE,
        '-a',
        account,
        '-w'
      ]);
      return stripTrailingNewline(stdout) || undefined;
    } catch {
      // The item does not exist, or the user denied access.
      return undefined;
    }
  }

  public async set(account: string, secret: string): Promise<void> {
    try {
      await run('security', [
        'add-generic-password',
        '-s',
        CREDENTIAL_SERVICE,
        '-a',
        account,
        '-w',
        secret,
        '-U'
      ]);
    } catch (error) {
      throw new CredentialError(
        `Unable to store the API key in the ${this.name}: ${(error as Error).message}`
      );
    }
  }

  public async delete(account: string): Promise<void> {
    try {
      await run('security', [
        'delete-generic-password',
        '-s',
        CREDENTIAL_SERVICE,
        '-a',
        account
      ]);
    } catch {
      // Nothing stored: nothing to remove.
    }
  }
}

/**
 * Linux backend built on `secret-tool` from libsecret (GNOME Keyring, KWallet, ...).
 */
class SecretServiceStore implements CredentialStore {
  public readonly name = 'Secret Service (secret-tool)';

  public async get(account: string): Promise<string | undefined> {
    try {
      const stdout = await run('secret-tool', [
        'lookup',
        'service',
        CREDENTIAL_SERVICE,
        'account',
        account
      ]);
      return stripTrailingNewline(stdout) || undefined;
    } catch {
      return undefined;
    }
  }

  public async set(account: string, secret: string): Promise<void> {
    try {
      await runWithInput(
        'secret-tool',
        [
          'store',
          '--label',
          `ChatServer model ${account}`,
          'service',
          CREDENTIAL_SERVICE,
          'account',
          account
        ],
        secret
      );
    } catch (error) {
      throw new CredentialError(
        `Unable to store the API key in the ${this.name}. ` +
          `Install libsecret and make sure a keyring is running. ${(error as Error).message}`
      );
    }
  }

  public async delete(account: string): Promise<void> {
    try {
      await run('secret-tool', [
        'clear',
        'service',
        CREDENTIAL_SERVICE,
        'account',
        account
      ]);
    } catch {
      // Nothing stored: nothing to remove.
    }
  }
}

/**
 * Windows backend using the CredentialManager PowerShell module.
 *
 * The module is not part of Windows, so the error explains how to install it.
 */
class WindowsCredentialStore implements CredentialStore {
  public readonly name = 'Windows Credential Manager';

  public async get(account: string): Promise<string | undefined> {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Import-Module CredentialManager -ErrorAction Stop',
      `$cred = Get-StoredCredential -Target ${powerShellQuote(this.target(account))}`,
      'if ($null -eq $cred) { exit 3 }',
      '[Console]::Out.Write($cred.GetNetworkCredential().Password)'
    ].join('; ');

    try {
      const stdout = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      return stdout || undefined;
    } catch (error) {
      if ((error as { code?: number }).code === 3) {
        return undefined;
      }
      throw new CredentialError(this.installHint(error));
    }
  }

  public async set(account: string, secret: string): Promise<void> {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Import-Module CredentialManager -ErrorAction Stop',
      `New-StoredCredential -Target ${powerShellQuote(this.target(account))} ` +
        `-UserName ${powerShellQuote(account)} -Password $env:CHATSERVER_SECRET ` +
        '-Persist LocalMachine | Out-Null'
    ].join('; ');

    try {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        CHATSERVER_SECRET: secret
      });
    } catch (error) {
      throw new CredentialError(this.installHint(error));
    }
  }

  public async delete(account: string): Promise<void> {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Import-Module CredentialManager -ErrorAction Stop',
      `Remove-StoredCredential -Target ${powerShellQuote(this.target(account))} | Out-Null`
    ].join('; ');

    try {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    } catch {
      // Nothing stored: nothing to remove.
    }
  }

  private target(account: string): string {
    return `${CREDENTIAL_SERVICE}:${account}`;
  }

  private installHint(error: unknown): string {
    return (
      `Unable to use the ${this.name}. Install the CredentialManager PowerShell module ` +
      `(Install-Module CredentialManager -Scope CurrentUser). ${(error as Error).message}`
    );
  }
}

/**
 * Returns the credential manager integration for the current platform.
 */
export function createCredentialStore(platform: NodeJS.Platform = process.platform): CredentialStore {
  switch (platform) {
    case 'darwin':
      return new MacOsKeychainStore();
    case 'linux':
      return new SecretServiceStore();
    case 'win32':
      return new WindowsCredentialStore();
    default:
      throw new CredentialError(
        `No credential manager integration for platform "${platform}". ` +
          'Set CHATSERVER_MODEL_API_KEY or OPENAI_API_KEY instead.'
      );
  }
}

/** Reads a provider API key, allowing the same override as the model CLI. */
export async function getModelApiKey(provider: string): Promise<string> {
  const override = process.env.CHATSERVER_MODEL_API_KEY;
  if (override !== undefined && override !== '') {
    return override;
  }
  const credentials = createCredentialStore();
  const stored = await credentials.get(provider);
  if (stored === undefined || stored === '') {
    throw new CredentialError(
      `No API key found in the ${credentials.name} for provider "${provider}". ` +
        'Run "chatserver-models add" or "chatserver-models update --api-key" to store one, ' +
        'or set CHATSERVER_MODEL_API_KEY.'
    );
  }
  return stored;
}
