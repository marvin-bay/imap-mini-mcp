import { describe, it, expect, vi } from "vitest";
import {
  LEDGER_COLUMNS, LEDGER_HEADER_LINE, csvCell, csvLine, formatBerlin, parseHeaderBlock,
  collectAttachments, flagList, ledgerRow, selectFolders, exportFolderIndex,
} from "./ledger.js";
import type { ImapClient } from "./imap/client.js";

describe("csv", () => {
  it("quotes only when needed and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("drops control characters", () => {
    expect(csvCell("a\u0000b\u0007c")).toBe("a b c");
  });

  it("header line has one cell per column", () => {
    expect(LEDGER_HEADER_LINE.trim().split(",")).toEqual([...LEDGER_COLUMNS]);
    expect(csvLine(["a", "b,c"])).toBe('a,"b,c"\n');
  });
});

describe("formatBerlin", () => {
  it("uses +01:00 in winter and +02:00 in summer", () => {
    expect(formatBerlin(new Date("2026-11-18T12:32:35Z"))).toBe("2026-11-18T13:32:35+01:00");
    expect(formatBerlin(new Date("2026-07-01T10:00:00Z"))).toBe("2026-07-01T12:00:00+02:00");
  });

  it("handles the day boundary and DST switch days", () => {
    expect(formatBerlin(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01T00:30:00+01:00");
    expect(formatBerlin(new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29T01:30:00+01:00");
    expect(formatBerlin(new Date("2026-03-29T01:30:00Z"))).toBe("2026-03-29T03:30:00+02:00");
  });

  it("returns an empty string for missing or invalid dates", () => {
    expect(formatBerlin(undefined)).toBe("");
    expect(formatBerlin(new Date("nope"))).toBe("");
  });
});

describe("parseHeaderBlock", () => {
  it("unfolds continuation lines and lower-cases names", () => {
    const m = parseHeaderBlock(
      Buffer.from("References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nList-Id: Foo <foo.example.org>\r\nAuto-Submitted: auto-generated\r\n\r\n")
    );
    expect(m.get("references")).toBe("<a@x> <b@x> <c@x>");
    expect(m.get("list-id")).toBe("Foo <foo.example.org>");
    expect(m.get("auto-submitted")).toBe("auto-generated");
  });

  it("copes with empty input", () => {
    expect(parseHeaderBlock(undefined).size).toBe(0);
    expect(parseHeaderBlock(Buffer.from("")).size).toBe(0);
  });
});

describe("collectAttachments", () => {
  it("finds nested attachment parts with their names, types and sizes", () => {
    const structure: any = {
      type: "multipart/mixed",
      childNodes: [
        { type: "text/plain", size: 10 },
        {
          type: "multipart/related",
          childNodes: [
            { type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "Rechnung.pdf" }, size: 65447 },
            { type: "image/png", disposition: "inline", size: 5 },
          ],
        },
        { type: "application/zip", disposition: "ATTACHMENT", parameters: { name: "a.zip" }, size: 7 },
        { type: "application/octet-stream", disposition: "attachment", size: 1 },
      ],
    };
    expect(collectAttachments(structure)).toEqual([
      { filename: "Rechnung.pdf", contentType: "application/pdf", size: 65447 },
      { filename: "a.zip", contentType: "application/zip", size: 7 },
      { filename: "unnamed", contentType: "application/octet-stream", size: 1 },
    ]);
    expect(collectAttachments(undefined)).toEqual([]);
  });
});

describe("flagList", () => {
  it("names the standard flags and appends the Apple Mail color", () => {
    expect(flagList(new Set(["\\Seen", "\\Flagged", "$MailFlagBit0", "$Junk"]), "red")).toBe("seen;flagged;color:red");
    expect(flagList(new Set(["\\Answered", "$Forwarded"]))).toBe("answered;forwarded");
    expect(flagList(undefined)).toBe("");
  });
});

const message = (uid: number, over: Record<string, unknown> = {}): any => ({
  uid,
  flags: new Set(["\\Seen"]),
  internalDate: new Date("2026-11-18T12:40:00Z"),
  size: 1234,
  envelope: {
    date: new Date("2026-11-18T12:32:35Z"),
    subject: 'Re: "Angebot", Teil 1',
    messageId: `<m${uid}@example.org>`,
    inReplyTo: "<m0@example.org>",
    from: [{ name: "Lisa Schmidtfall", address: "lisa@example.org" }],
    to: [{ address: "a@example.org" }, { address: "b@example.org" }],
    cc: [{ address: "c@example.org" }],
  },
  headers: Buffer.from("References: <m0@example.org>\r\nList-Id: pr <pr.example.org>\r\n\r\n"),
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [{ type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "a.pdf" }, size: 99 }],
  },
  ...over,
});

describe("ledgerRow", () => {
  it("maps a message to the documented columns", () => {
    const row = ledgerRow("INBOX/Sub", message(7));
    const get = (c: (typeof LEDGER_COLUMNS)[number]) => row[LEDGER_COLUMNS.indexOf(c)];
    expect(row).toHaveLength(LEDGER_COLUMNS.length);
    expect(get("folder")).toBe("INBOX/Sub");
    expect(get("uid")).toBe("7");
    expect(get("id")).toBe("2026-11-18T12:32:35.<m7@example.org>");
    expect(get("message_id")).toBe("<m7@example.org>");
    expect(get("date_utc")).toBe("2026-11-18T12:32:35.000Z");
    expect(get("date_berlin")).toBe("2026-11-18T13:32:35+01:00");
    expect(get("internal_date_utc")).toBe("2026-11-18T12:40:00.000Z");
    expect(get("from")).toBe("lisa@example.org");
    expect(get("from_name")).toBe("Lisa Schmidtfall");
    expect(get("to")).toBe("a@example.org; b@example.org");
    expect(get("cc")).toBe("c@example.org");
    expect(get("subject")).toBe('Re: "Angebot", Teil 1');
    expect(get("in_reply_to")).toBe("<m0@example.org>");
    expect(get("references")).toBe("<m0@example.org>");
    expect(get("list_id")).toBe("pr <pr.example.org>");
    expect(get("auto_submitted")).toBe("");
    expect(get("flags")).toBe("seen");
    expect(get("has_attachment")).toBe("true");
    expect(get("attachment_count")).toBe("1");
    expect(JSON.parse(get("attachments"))).toEqual([{ filename: "a.pdf", contentType: "application/pdf", size: 99 }]);
    expect(get("size")).toBe("1234");
  });

  it("survives a nearly empty message and keeps the uid to tell mails apart", () => {
    const row = ledgerRow("INBOX", { uid: 3 } as any);
    expect(row).toHaveLength(LEDGER_COLUMNS.length);
    expect(row[LEDGER_COLUMNS.indexOf("uid")]).toBe("3");
    expect(row[LEDGER_COLUMNS.indexOf("has_attachment")]).toBe("false");
    expect(row[LEDGER_COLUMNS.indexOf("date_utc")]).toBe("");
  });

  it("a subject with a comma and quotes survives the csv round trip", () => {
    const line = csvLine(ledgerRow("INBOX", message(1)));
    expect(line).toContain('"Re: ""Angebot"", Teil 1"');
  });
});

describe("selectFolders", () => {
  const f = (path: string) => ({ path, name: path.split("/").pop()!, delimiter: "/" });
  const all = [
    f("INBOX"), f("Archiv"), f("Sicherheit"), f("Junk-E-Mail"), f("Gelöschte Elemente"),
    f("Gelöschte Elemente/Archiv"), f("Anschaffung"), f("Anschaffung/2022"), f("Anschaffung/Sicherheit"), f("AnschaffungX"),
  ];
  const base = { includeSubfolders: false, includeJunk: false, blocked: ["Sicherheit"] };

  it('"*" skips blocked and junk folders (and reports the blocked ones)', () => {
    const sel = selectFolders(all, "*", base)!;
    expect(sel.folders).toEqual(["INBOX", "Archiv", "Anschaffung", "Anschaffung/2022", "AnschaffungX"]);
    expect(sel.skippedBlocked).toEqual(["Sicherheit", "Anschaffung/Sicherheit"]);
  });

  it('"*" with include_junk also covers trash and its subfolders, but never blocked ones', () => {
    const sel = selectFolders(all, "*", { ...base, includeJunk: true })!;
    expect(sel.folders).toEqual(expect.arrayContaining(["Junk-E-Mail", "Gelöschte Elemente", "Gelöschte Elemente/Archiv"]));
    expect(sel.folders).not.toContain("Sicherheit");
  });

  it("a named folder alone, or with subfolders (prefix match on the delimiter only)", () => {
    expect(selectFolders(all, "Anschaffung", base)!.folders).toEqual(["Anschaffung"]);
    const sub = selectFolders(all, "Anschaffung", { ...base, includeSubfolders: true })!;
    expect(sub.folders).toEqual(["Anschaffung", "Anschaffung/2022"]);
    expect(sub.skippedBlocked).toEqual(["Anschaffung/Sicherheit"]);
  });

  it("an explicitly named trash folder is indexed without include_junk", () => {
    expect(selectFolders(all, "Gelöschte Elemente", { ...base, includeSubfolders: true })!.folders)
      .toEqual(["Gelöschte Elemente", "Gelöschte Elemente/Archiv"]);
  });

  it("returns null for an unknown folder", () => {
    expect(selectFolders(all, "Nope", base)).toBeNull();
  });
});

function mockClient(opts: { messages: any[]; exists?: number; dropUids?: Set<number>; failFetch?: boolean }) {
  const lock = { release: vi.fn() };
  const search = vi.fn(async () => opts.messages.map((m) => m.uid).reverse());
  const fetch = vi.fn((range: string) => {
    const wanted = new Set(range.split(",").map(Number));
    if (opts.failFetch) throw new Error("boom");
    return (async function* () {
      for (const m of opts.messages) if (wanted.has(m.uid) && !opts.dropUids?.has(m.uid)) yield m;
    })();
  });
  const imapClient = {
    openMailbox: vi.fn(async () => lock),
    getClient: () => ({ mailbox: { exists: opts.exists ?? opts.messages.length }, search, fetch }),
  } as unknown as ImapClient;
  return { imapClient, lock, search, fetch };
}

const collect = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: async (c: string) => void chunks.push(c) } };
};

describe("exportFolderIndex", () => {
  it("writes every mail exactly once, in UID order, across several fetch chunks", async () => {
    const messages = Array.from({ length: 1203 }, (_, i) => message(i + 1));
    const { imapClient, fetch, lock } = mockClient({ messages });
    const { chunks, sink } = collect();
    const res = await exportFolderIndex(imapClient, "INBOX", {}, sink);

    expect(res.server_count).toBe(1203);
    expect(res.rows).toBe(1203);
    expect(res.folder_total).toBe(1203);
    expect(fetch).toHaveBeenCalledTimes(3); // 500 + 500 + 203
    const lines = chunks.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(1203);
    expect(lines.map((l) => Number(l.split(",")[1]))).toEqual(Array.from({ length: 1203 }, (_, i) => i + 1));
    expect(res.first_date).toBe("2026-11-18T12:32:35.000Z");
    expect(lock.release).toHaveBeenCalled();
  });

  it("makes a missing fetch result visible as rows < server_count instead of hiding it", async () => {
    const messages = [message(1), message(2), message(3)];
    const { imapClient } = mockClient({ messages, dropUids: new Set([2]) });
    const res = await exportFolderIndex(imapClient, "INBOX", {}, collect().sink);
    expect(res.server_count).toBe(3);
    expect(res.rows).toBe(2);
  });

  it("uses SEARCH ALL without filters and SINCE/BEFORE with them", async () => {
    const a = mockClient({ messages: [message(1)] });
    await exportFolderIndex(a.imapClient, "INBOX", {}, collect().sink);
    expect(a.search).toHaveBeenCalledWith({ all: true }, { uid: true });

    const b = mockClient({ messages: [message(1)] });
    const after = new Date("2026-01-01"), before = new Date("2026-02-01");
    await exportFolderIndex(b.imapClient, "INBOX", { after, before }, collect().sink);
    expect(b.search).toHaveBeenCalledWith({ since: after, before }, { uid: true });
  });

  it("an empty folder yields zero rows and still reports folder_total", async () => {
    const { imapClient } = mockClient({ messages: [], exists: 0 });
    const res = await exportFolderIndex(imapClient, "Leer", {}, collect().sink);
    expect(res).toMatchObject({ rows: 0, server_count: 0, folder_total: 0, first_date: null, last_date: null });
  });

  it("releases the mailbox lock when fetching fails", async () => {
    const { imapClient, lock } = mockClient({ messages: [message(1)], failFetch: true });
    await expect(exportFolderIndex(imapClient, "INBOX", {}, collect().sink)).rejects.toThrow("boom");
    expect(lock.release).toHaveBeenCalled();
  });
});
