import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { ImapClient } from "./imap/index.js";
import { passwordEnvName, type AccountConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** What the tool layer needs from the account registry. */
export interface ToolEnvironment {
  listAccounts(): { id: string; user: string }[];
  hasAccount(id: string): boolean;
  getClient(id: string): Promise<ImapClient>;
  blockedFolders: string[];
  maxBodyChars: number;
  /** Fixed folder for downloaded attachments and exported .eml files. */
  downloadDir: string;
  maxDownloadBytes: number;
}

export type PasswordLookup = (account: AccountConfig) => Promise<string>;

/**
 * Resolve an account password: macOS Keychain first (service
 * "mail-triage/<id>", account = user), then env MAIL_TRIAGE_PASS_<ID>.
 * The password is never logged and never part of error messages.
 */
export async function lookupPassword(
  account: AccountConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = (f, a) =>
    execFileAsync(f, a)
): Promise<string> {
  if (account.legacyPassword) return account.legacyPassword;

  if (platform === "darwin") {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s",
        `mail-triage/${account.id}`,
        "-a",
        account.user,
        "-w",
      ]);
      const pw = stdout.replace(/\r?\n$/, "");
      if (pw) return pw;
    } catch {
      // fall through to env fallback
    }
  }

  const fromEnv = env[passwordEnvName(account.id)];
  if (fromEnv) return fromEnv;

  throw new Error(
    `Kein Passwort für Account "${account.id}" gefunden (Keychain-Eintrag mail-triage/${account.id} oder Env ${passwordEnvName(account.id)}).`
  );
}

export interface RegistryOptions {
  blockedFolders?: string[];
  maxBodyChars?: number;
  downloadDir?: string;
  maxDownloadBytes?: number;
  getPassword?: PasswordLookup;
  createClient?: (account: AccountConfig, password: string) => ImapClient;
}

/**
 * Holds the configured accounts and creates IMAP connections lazily.
 * At most one account is connected at a time: switching accounts closes the
 * previous connection first, so logins are strictly sequential.
 */
export class AccountRegistry implements ToolEnvironment {
  readonly blockedFolders: string[];
  readonly maxBodyChars: number;
  readonly downloadDir: string;
  readonly maxDownloadBytes: number;
  private accounts = new Map<string, AccountConfig>();
  private active: { id: string; client: ImapClient } | null = null;
  private getPassword: PasswordLookup;
  private createClient: (account: AccountConfig, password: string) => ImapClient;

  constructor(accounts: AccountConfig[], opts: RegistryOptions = {}) {
    for (const a of accounts) this.accounts.set(a.id, a);
    this.blockedFolders = opts.blockedFolders ?? [];
    this.maxBodyChars = opts.maxBodyChars ?? 4000;
    this.downloadDir = opts.downloadDir ?? path.join(homedir(), "mail-triage-downloads");
    this.maxDownloadBytes = opts.maxDownloadBytes ?? 25 * 1024 * 1024;
    this.getPassword = opts.getPassword ?? ((a) => lookupPassword(a));
    this.createClient =
      opts.createClient ??
      ((a, pass) =>
        new ImapClient({
          host: a.host,
          port: a.port,
          secure: a.secure,
          starttls: a.starttls ?? true,
          tlsRejectUnauthorized: a.tlsRejectUnauthorized ?? true,
          auth: { user: a.user, pass },
        }));
  }

  listAccounts(): { id: string; user: string }[] {
    return [...this.accounts.values()].map((a) => ({ id: a.id, user: a.user }));
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  async getClient(id: string): Promise<ImapClient> {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Unbekannter Account: "${id}".`);
    if (this.active?.id === id) return this.active.client;

    await this.disconnectAll();
    const password = await this.getPassword(account);
    const client = this.createClient(account, password);
    this.active = { id, client };
    return client;
  }

  async disconnectAll(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) await active.client.disconnect();
  }
}
