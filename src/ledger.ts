import type { FetchMessageObject, MessageStructureObject, SearchObject } from "imapflow";
import type { ImapClient } from "./imap/client.js";
import type { FolderEntry } from "./imap/folders.js";
import { buildCompositeId } from "./imap/resolve.js";
import { isBlockedFolder } from "./blocked.js";
import { isJunkFolder } from "./junk.js";

/**
 * Mail index ("ledger"): one CSV row per message with header data only, written
 * to disk so that an agent can count and analyse mails with a script instead
 * of passing every listing through its context.
 */

export const LEDGER_COLUMNS = [
  "folder",
  "uid",
  "id", // composite id, usable with fetch_email_content / export_email
  "message_id",
  "date_utc", // Date header
  "date_berlin", // Date header in Europe/Berlin, with offset
  "internal_date_utc", // arrival date on the server
  "from",
  "from_name",
  "to",
  "cc",
  "subject",
  "in_reply_to",
  "references",
  "list_id",
  "auto_submitted",
  "flags",
  "has_attachment",
  "attachment_count",
  "attachments", // JSON array of {filename, contentType, size}
  "size",
] as const;

/** Header fields fetched in addition to the envelope. */
export const LEDGER_HEADERS = ["references", "list-id", "auto-submitted"];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** RFC 4180 cell: quote when needed, double inner quotes, drop control characters. */
export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const clean = text.replace(CONTROL_CHARS, " ");
  return /[",\r\n]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(",") + "\n";
}

export const LEDGER_HEADER_LINE = csvLine(LEDGER_COLUMNS);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const berlinFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function validDate(d: unknown): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
}

/** ISO-like local time with offset, e.g. "2026-11-18T13:32:35+01:00". "" if invalid. */
export function formatBerlin(d: Date | undefined): string {
  if (!validDate(d)) return "";
  const p: Record<string, string> = {};
  for (const part of berlinFormat.formatToParts(d)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  const offsetMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

function iso(d: Date | undefined): string {
  return validDate(d) ? d.toISOString() : "";
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/** Parse a raw header block into a lower-cased name → value map (folded lines joined). */
export function parseHeaderBlock(block: Buffer | string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!block) return out;
  const text = typeof block === "string" ? block : block.toString("utf8");
  const lines = text.split(/\r?\n/);
  let name: string | null = null;
  let value = "";
  const flush = () => {
    if (name !== null) out.set(name, value.replace(/\s+/g, " ").trim());
    name = null;
    value = "";
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name !== null) {
      value += " " + line;
    } else {
      flush();
      const idx = line.indexOf(":");
      if (idx > 0) {
        name = line.slice(0, idx).trim().toLowerCase();
        value = line.slice(idx + 1);
      }
    }
  }
  flush();
  return out;
}

export interface LedgerAttachment {
  filename: string;
  contentType: string;
  size: number;
}

/** Attachment parts (disposition "attachment") of a BODYSTRUCTURE, in document order. */
export function collectAttachments(structure: MessageStructureObject | undefined): LedgerAttachment[] {
  const found: LedgerAttachment[] = [];
  const walk = (node: MessageStructureObject | undefined) => {
    if (!node) return;
    if (node.disposition?.toLowerCase() === "attachment") {
      found.push({
        filename:
          node.dispositionParameters?.filename || node.parameters?.name || "unnamed",
        contentType: node.type || "application/octet-stream",
        size: node.size ?? 0,
      });
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(structure);
  return found;
}

const FLAG_NAMES: Record<string, string> = {
  "\\seen": "seen",
  "\\flagged": "flagged",
  "\\answered": "answered",
  "\\draft": "draft",
  "\\deleted": "deleted",
  "$forwarded": "forwarded",
};

/** Readable flag list: "seen;flagged;color:red". */
export function flagList(flags: Set<string> | undefined, flagColor?: string): string {
  const out: string[] = [];
  for (const f of flags ?? []) {
    const name = FLAG_NAMES[f.toLowerCase()];
    if (name) out.push(name);
  }
  if (flagColor) out.push(`color:${flagColor}`);
  return out.join(";");
}

interface EnvelopeAddress {
  name?: string;
  address?: string;
}

function addressList(list: EnvelopeAddress[] | undefined): string {
  return (list ?? [])
    .map((a) => a.address || "")
    .filter(Boolean)
    .join("; ");
}

/** One ledger row (values in LEDGER_COLUMNS order). */
export function ledgerRow(folder: string, msg: FetchMessageObject): string[] {
  const env = msg.envelope;
  const headers = parseHeaderBlock(msg.headers);
  const attachments = collectAttachments(msg.bodyStructure as MessageStructureObject | undefined);
  const date = validDate(env?.date) ? env!.date : undefined;
  const messageId = env?.messageId || "";
  const from = (env?.from as EnvelopeAddress[] | undefined)?.[0];

  return [
    folder,
    String(msg.uid),
    buildCompositeId(date || new Date(0), messageId),
    messageId,
    iso(date),
    formatBerlin(date),
    iso(msg.internalDate instanceof Date ? msg.internalDate : undefined),
    from?.address || "",
    from?.name || "",
    addressList(env?.to as EnvelopeAddress[] | undefined),
    addressList(env?.cc as EnvelopeAddress[] | undefined),
    env?.subject || "",
    env?.inReplyTo || "",
    headers.get("references") || "",
    headers.get("list-id") || "",
    headers.get("auto-submitted") || "",
    flagList(msg.flags, msg.flagColor),
    String(attachments.length > 0),
    String(attachments.length),
    attachments.length > 0 ? JSON.stringify(attachments) : "",
    String(msg.size ?? ""),
  ];
}

// ---------------------------------------------------------------------------
// Folder selection
// ---------------------------------------------------------------------------

export const ALL_FOLDERS = "*";

export interface FolderSelection {
  folders: string[];
  /** Blocked folders that were left out (never opened). */
  skippedBlocked: string[];
}

/**
 * Decide which folders an index run covers.
 * - "*": every folder except blocked ones and, unless includeJunk, Trash/Spam/Junk.
 * - a folder name: that folder, plus its subfolders when includeSubfolders.
 * Returns null if a named folder does not exist.
 */
export function selectFolders(
  all: readonly FolderEntry[],
  folder: string,
  opts: { includeSubfolders: boolean; includeJunk: boolean; blocked: readonly string[] }
): FolderSelection | null {
  let candidates: FolderEntry[];
  if (folder === ALL_FOLDERS) {
    candidates = all.filter((f) => opts.includeJunk || !isJunkFolder(f.path));
  } else {
    const root = all.find((f) => f.path === folder);
    if (!root) return null;
    candidates = opts.includeSubfolders
      ? all.filter((f) => f.path === root.path || f.path.startsWith(root.path + root.delimiter))
      : [root];
  }
  const skippedBlocked = candidates.filter((f) => isBlockedFolder(f.path, opts.blocked)).map((f) => f.path);
  const folders = candidates.filter((f) => !isBlockedFolder(f.path, opts.blocked)).map((f) => f.path);
  return { folders, skippedBlocked };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface LedgerSink {
  write(chunk: string): Promise<void>;
}

export interface FolderIndexResult {
  folder: string;
  /** Messages in the folder according to the server (EXISTS). */
  folder_total: number | null;
  /** Messages the server reports for this run (search result; equals folder_total without a date filter). */
  server_count: number;
  /** Rows actually written. */
  rows: number;
  first_date: string | null;
  last_date: string | null;
}

const FETCH_CHUNK = 500;

/**
 * Write the index rows of one folder to the sink. Opens the mailbox (read-only
 * in a read-only instance), searches the matching UIDs, fetches header data in
 * chunks and writes the rows in UID order.
 *
 * `after`/`before` use IMAP SEARCH SINCE/BEFORE, i.e. the arrival date on the
 * server (day granularity), not the Date header.
 */
export async function exportFolderIndex(
  imapClient: ImapClient,
  folder: string,
  opts: { after?: Date; before?: Date },
  sink: LedgerSink
): Promise<FolderIndexResult> {
  const lock = await imapClient.openMailbox(folder);
  try {
    const client = imapClient.getClient();
    const mailbox = client.mailbox;
    const folderTotal =
      mailbox && typeof mailbox === "object" && typeof mailbox.exists === "number"
        ? mailbox.exists
        : null;

    const query: SearchObject = {};
    if (opts.after) query.since = opts.after;
    if (opts.before) query.before = opts.before;
    if (!opts.after && !opts.before) query.all = true;

    const found = (await client.search(query, { uid: true })) || [];
    const uids = [...found].sort((a, b) => a - b);

    let rows = 0;
    let firstMs: number | null = null;
    let lastMs: number | null = null;

    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      const byUid = new Map<number, string[]>();
      for await (const msg of client.fetch(
        chunk.join(","),
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          headers: LEDGER_HEADERS,
        },
        { uid: true }
      )) {
        byUid.set(msg.uid, ledgerRow(folder, msg));
        const d = msg.envelope?.date;
        if (validDate(d)) {
          const t = d.getTime();
          if (firstMs === null || t < firstMs) firstMs = t;
          if (lastMs === null || t > lastMs) lastMs = t;
        }
      }
      let text = "";
      for (const uid of chunk) {
        const row = byUid.get(uid);
        if (row) {
          text += csvLine(row);
          rows++;
        }
      }
      if (text) await sink.write(text);
    }

    return {
      folder,
      folder_total: folderTotal,
      server_count: uids.length,
      rows,
      first_date: firstMs === null ? null : new Date(firstMs).toISOString(),
      last_date: lastMs === null ? null : new Date(lastMs).toISOString(),
    };
  } finally {
    lock.release();
  }
}
