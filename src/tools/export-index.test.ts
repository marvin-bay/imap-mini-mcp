import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall } from "./index.js";
import type { ImapClient } from "../imap/index.js";
import type { ToolEnvironment } from "../accounts.js";
import { LEDGER_COLUMNS } from "../ledger.js";
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/** Minimal RFC 4180 parser so the test checks the real file round trip. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  return rows;
}

const msg = (uid: number, subject = `Mail ${uid}`) => ({
  uid,
  flags: new Set(["\\Seen"]),
  internalDate: new Date("2026-11-18T12:40:00Z"),
  size: 100 + uid,
  envelope: {
    date: new Date(Date.UTC(2026, 10, 1, 8, 0, uid)),
    subject,
    messageId: `<${uid}@example.org>`,
    from: [{ name: "A", address: "a@example.org" }],
    to: [{ address: "me@example.org" }],
  },
  headers: Buffer.from(""),
  bodyStructure: { type: "text/plain" },
});

const FOLDERS: Record<string, any[]> = {
  INBOX: [msg(1, 'Code 112233, "wichtig"'), msg(2), msg(3)],
  Archiv: [msg(1), msg(2)],
  Sicherheit: [msg(1)],
  "Junk-E-Mail": [msg(1)],
  "Gelöschte Elemente": [msg(1), msg(2)],
  "Gelöschte Elemente/Archiv": [msg(1)],
  Kaputt: [],
};
const BROKEN = new Set(["Kaputt"]);
const opened: string[] = [];

function makeClient(): ImapClient {
  let current = "";
  const lockFor = (folder: string) => {
    if (BROKEN.has(folder)) throw new Error("Mailbox does not exist");
    current = folder;
    opened.push(folder);
    return { release: () => undefined };
  };
  const client = {
    list: async () =>
      Object.keys(FOLDERS).map((p) => ({ path: p, name: p.split("/").pop(), delimiter: "/" })),
    get mailbox() { return { exists: FOLDERS[current].length }; },
    search: async () => FOLDERS[current].map((m) => m.uid),
    fetch: (range: string) => {
      const wanted = new Set(range.split(",").map(Number));
      const items = FOLDERS[current];
      return (async function* () { for (const m of items) if (wanted.has(m.uid)) yield m; })();
    },
  };
  return {
    connect: async () => client,
    openMailbox: async (f: string) => lockFor(f),
    getClient: () => client,
  } as unknown as ImapClient;
}

const indexDir = mkdtempSync(path.join(tmpdir(), "mail-index-test-"));
const env: ToolEnvironment = {
  listAccounts: () => [{ id: "uni", user: "me@example.org" }],
  hasAccount: (id) => id === "uni",
  getClient: async () => makeClient(),
  blockedFolders: ["Sicherheit"],
  maxBodyChars: 4000,
  downloadDir: mkdtempSync(path.join(tmpdir(), "mail-dl-test-")),
  maxDownloadBytes: 1000,
  indexDir,
};

const call = (args: Record<string, unknown> = {}, e: ToolEnvironment = env) =>
  handleToolCall(e, "export_index", { account: "uni", ...args });
const data = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.content[0].text);

describe("export_index", () => {
  beforeEach(() => { opened.length = 0; });

  it("writes a CSV into <indexDir>/<account>/ and reports soll/ist without any mail content", async () => {
    const r = await call({ folder: "INBOX" });
    expect(r.isError).toBeUndefined();
    const d = data(r);

    expect(d.rows).toBe(3);
    expect(d.server_count).toBe(3);
    expect(d.complete).toBe(true);
    expect(d.folders).toEqual([{ folder: "INBOX", server_count: 3, rows: 3, folder_total: 3 }]);
    expect(path.dirname(d.path)).toBe(path.join(indexDir, "uni"));
    expect(path.basename(d.path)).toMatch(/^INBOX__\d{8}-\d{6}\.csv$/);
    expect(statSync(d.path).mode & 0o777).toBe(0o600);
    expect(d.sha256).toBe(createHash("sha256").update(readFileSync(d.path)).digest("hex"));
    // nothing from the mails in the tool result
    expect(r.content[0].text).not.toContain("112233");
    expect(r.content[0].text).not.toContain("wichtig");

    const rows = parseCsv(readFileSync(d.path, "utf8"));
    expect(rows[0]).toEqual([...LEDGER_COLUMNS]);
    expect(rows).toHaveLength(4);
    // file is NOT redacted and survives commas/quotes
    expect(rows[1][LEDGER_COLUMNS.indexOf("subject")]).toBe('Code 112233, "wichtig"');
    expect(rows.slice(1).map((x) => x[LEDGER_COLUMNS.indexOf("uid")])).toEqual(["1", "2", "3"]);
    for (const row of rows) expect(row).toHaveLength(LEDGER_COLUMNS.length);
  });

  it('"*" covers all folders except blocked and junk, and says what was left out', async () => {
    const d = data(await call({ folder: "*" }));
    expect(d.folders.map((f: any) => f.folder).sort()).toEqual(["Archiv", "INBOX"]);
    expect(d.skipped_folders).toEqual([{ folder: "Kaputt", error: "Mailbox does not exist" }]);
    expect(d.skipped_blocked).toEqual(["Sicherheit"]);
    expect(d.rows).toBe(5);
    expect(d.server_count).toBe(5);
    expect(d.complete).toBe(false); // one folder could not be opened
    expect(opened).not.toContain("Sicherheit");
    expect(opened).not.toContain("Junk-E-Mail");
    expect(opened).not.toContain("Gelöschte Elemente");
    expect(path.basename(d.path)).toMatch(/^ALL__/);
  });

  it('"*" with include_junk adds trash and its subfolders (still never blocked ones)', async () => {
    const d = data(await call({ folder: "*", include_junk: true }));
    const names = d.folders.map((f: any) => f.folder);
    expect(names).toEqual(expect.arrayContaining(["Junk-E-Mail", "Gelöschte Elemente", "Gelöschte Elemente/Archiv"]));
    expect(names).not.toContain("Sicherheit");
    expect(d.rows).toBe(3 + 2 + 1 + 2 + 1);
    const rows = parseCsv(readFileSync(d.path, "utf8")).slice(1);
    expect(rows).toHaveLength(d.rows);
    expect(new Set(rows.map((r) => r[0])).has("Gelöschte Elemente/Archiv")).toBe(true);
  });

  it("include_subfolders takes a named folder and its subfolders", async () => {
    const d = data(await call({ folder: "Gelöschte Elemente", include_subfolders: true }));
    expect(d.folders.map((f: any) => f.folder)).toEqual(["Gelöschte Elemente", "Gelöschte Elemente/Archiv"]);
    expect(d.rows).toBe(3);
    expect(path.basename(d.path)).toMatch(/-sub__/);

    const single = data(await call({ folder: "Gelöschte Elemente" }));
    expect(single.rows).toBe(2);
  });

  it("every run is a new file: repeated calls never overwrite an earlier ledger", async () => {
    const a = data(await call({ folder: "Archiv" }));
    const b = data(await call({ folder: "Archiv" }));
    expect(b.path).not.toBe(a.path);
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
  });

  it("refuses a blocked folder", async () => {
    const r = await call({ folder: "Sicherheit" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Ordner gesperrt");
    expect(opened).toEqual([]);
  });

  it("errors for an unknown folder without leaving a file behind", async () => {
    const before = readdirSync(path.join(indexDir, "uni")).length;
    const r = await call({ folder: "Gibts-nicht" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Folder not found");
    expect(readdirSync(path.join(indexDir, "uni")).length).toBe(before);
  });

  it("when no folder can be indexed it fails and removes the empty file", async () => {
    const before = readdirSync(path.join(indexDir, "uni")).length;
    await expect(call({ folder: "Kaputt" })).rejects.toThrow("Mailbox does not exist");
    expect(readdirSync(path.join(indexDir, "uni")).length).toBe(before);
  });

  it("echoes date filters and rejects invalid ones", async () => {
    const ok = data(await call({ folder: "Archiv", after: "2026-01-01", before: "2026-12-31" }));
    expect(ok.filter).toMatchObject({ basis: "arrival date on the server" });
    const bad = await call({ folder: "Archiv", after: "gestern" });
    expect(bad.isError).toBe(true);
  });

  it("works in a read-only instance", async () => {
    const d = data(await call({ folder: "Archiv" }, { ...env, readOnly: true }));
    expect(d.rows).toBe(2);
  });
});
