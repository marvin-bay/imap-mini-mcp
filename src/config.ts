import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** One IMAP account of the mail-triage setup. */
export interface AccountConfig {
  id: string;
  host: string;
  port: number;
  user: string;
  secure: boolean;
  /** Only used by the legacy single-account env config (IMAP_PASS). */
  legacyPassword?: string;
  starttls?: boolean;
  tlsRejectUnauthorized?: boolean;
}

export interface TriageConfig {
  accounts: AccountConfig[];
  source: "file" | "env";
}

export const DEFAULT_ACCOUNTS_PATH = "~/mail-triage/accounts.yaml";
const ID_PATTERN = /^[a-z0-9-]+$/;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Name of the fallback env var holding the password of an account. */
export function passwordEnvName(id: string): string {
  return `MAIL_TRIAGE_PASS_${id.toUpperCase().replace(/-/g, "_")}`;
}

function parseBoolean(value: unknown, field: string, def: boolean): boolean {
  if (value === undefined || value === null) return def;
  if (typeof value === "boolean") return value;
  throw new Error(`Konfiguration: "${field}" muss true oder false sein.`);
}

/** Parse a comma-separated string (or a YAML list) into trimmed, non-empty entries. */
export function parseFolderList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(",")
      : [];
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseAccount(raw: unknown, index: number): AccountConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Konfiguration: Account #${index + 1} ist kein Objekt.`);
  }
  const r = raw as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(
      `Konfiguration: Account #${index + 1}: "id" muss dem Muster [a-z0-9-]+ entsprechen.`
    );
  }
  if (typeof r.host !== "string" || !r.host.trim()) {
    throw new Error(`Konfiguration: Account "${id}": "host" fehlt.`);
  }
  if (typeof r.user !== "string" || !r.user.trim()) {
    throw new Error(`Konfiguration: Account "${id}": "user" fehlt.`);
  }
  const port = r.port === undefined || r.port === null ? 993 : r.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Konfiguration: Account "${id}": "port" ist ungültig.`);
  }
  return {
    id,
    host: r.host.trim(),
    port,
    user: r.user.trim(),
    secure: parseBoolean(r.secure, `${id}.secure`, true),
  };
}

export interface LoadedConfig extends TriageConfig {
  blockedFolders: string[];
  maxBodyChars: number;
}

export const DEFAULT_BLOCKED_FOLDERS = ["Sicherheit"];
export const DEFAULT_MAX_BODY_CHARS = 4000;

export function parseMaxBodyChars(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_BODY_CHARS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("MAIL_TRIAGE_MAX_BODY_CHARS muss eine positive ganze Zahl sein.");
  }
  return n;
}

/**
 * Load accounts from the YAML/JSON file in MAIL_TRIAGE_ACCOUNTS (default
 * ~/mail-triage/accounts.yaml). The file must be a top-level object:
 *
 *   blocked_folders: Sicherheit      # optional, comma list
 *   accounts:
 *     - id: privat
 *       host: ...
 *
 * If the default file does not exist and IMAP_HOST is set, the legacy
 * single-account env config is used as account "default".
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8")
): LoadedConfig {
  const explicit = env.MAIL_TRIAGE_ACCOUNTS?.trim();
  const filePath = expandHome(explicit || DEFAULT_ACCOUNTS_PATH);

  let text: string | null = null;
  try {
    text = readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" || explicit) {
      throw new Error(
        `Account-Datei ${filePath} konnte nicht gelesen werden (${code ?? "Fehler"}).`
      );
    }
  }

  let accounts: AccountConfig[];
  let fileBlocked: string[] | undefined;
  let source: "file" | "env" = "file";

  if (text !== null) {
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (err) {
      throw new Error(
        `Account-Datei ${filePath} ist kein gültiges YAML/JSON: ${(err as Error).message}`
      );
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(
        `Account-Datei ${filePath}: Top-Level muss ein Objekt mit "accounts"-Liste sein.`
      );
    }
    const d = doc as Record<string, unknown>;
    if (!Array.isArray(d.accounts) || d.accounts.length === 0) {
      throw new Error(`Account-Datei ${filePath}: "accounts" muss eine nichtleere Liste sein.`);
    }
    accounts = d.accounts.map(parseAccount);
    const ids = new Set<string>();
    for (const a of accounts) {
      if (ids.has(a.id)) throw new Error(`Konfiguration: doppelte Account-id "${a.id}".`);
      ids.add(a.id);
    }
    if (d.blocked_folders !== undefined && d.blocked_folders !== null) {
      fileBlocked = parseFolderList(d.blocked_folders);
    }
  } else if (env.IMAP_HOST) {
    source = "env";
    if (!env.IMAP_USER) throw new Error("IMAP_USER environment variable is required");
    if (!env.IMAP_PASS) throw new Error("IMAP_PASS environment variable is required");
    accounts = [
      {
        id: "default",
        host: env.IMAP_HOST,
        port: parseInt(env.IMAP_PORT || "993", 10),
        user: env.IMAP_USER,
        secure: env.IMAP_SECURE !== "false",
        legacyPassword: env.IMAP_PASS,
        starttls: env.IMAP_STARTTLS !== "false",
        tlsRejectUnauthorized: env.IMAP_TLS_REJECT_UNAUTHORIZED !== "false",
      },
    ];
  } else {
    throw new Error(
      `Keine Account-Datei unter ${filePath} und kein IMAP_HOST gesetzt. ` +
        "Setze MAIL_TRIAGE_ACCOUNTS oder lege die Datei an."
    );
  }

  const envBlocked = env.MAIL_TRIAGE_BLOCKED_FOLDERS;
  const blockedFolders =
    envBlocked !== undefined
      ? parseFolderList(envBlocked)
      : (fileBlocked ?? DEFAULT_BLOCKED_FOLDERS);

  return {
    accounts,
    source,
    blockedFolders,
    maxBodyChars: parseMaxBodyChars(env.MAIL_TRIAGE_MAX_BODY_CHARS),
  };
}
