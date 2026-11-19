import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall, tools } from "./index.js";
import type { ImapClient } from "../imap/index.js";
import type { ToolEnvironment } from "../accounts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../imap/index.js", async () => {
  const actual = await vi.importActual<typeof import("../imap/index.js")>(
    "../imap/index.js"
  );
  return { ...actual, listFolders: vi.fn(), findEmails: vi.fn() };
});

import { listFolders, findEmails } from "../imap/index.js";

const mockListFolders = vi.mocked(listFolders);
const mockFindEmails = vi.mocked(findEmails);
const mockImapClient = {} as ImapClient;
const env: ToolEnvironment = {
  listAccounts: () => [{ id: "acc", user: "me@example.de" }],
  hasAccount: (id) => id === "acc",
  getClient: async () => mockImapClient,
  blockedFolders: ["Sicherheit", "Lizenzen"],
  maxBodyChars: 4000,
  downloadDir: mkdtempSync(path.join(tmpdir(), "mail-triage-test-")),
  maxDownloadBytes: 1000,
  indexDir: mkdtempSync(path.join(tmpdir(), "mail-index-test-")),
};

function call(args: Record<string, unknown> = {}) {
  return handleToolCall(env, "find_emails", { account: "acc", ...args });
}

const folder = (p: string) => ({ path: p, name: p.split("/").pop()!, delimiter: "/" });
const mail = (id: string, date: string, subject = "s") => ({
  id,
  subject,
  from: "a@b.de",
  date,
});

describe('find_emails — folder "*"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("documents the all-folders mode and include_junk", () => {
    const tool = tools.find((t) => t.name === "find_emails")!;
    expect(tool.description).toContain('folder "*"');
    expect(tool.inputSchema.properties).toHaveProperty("include_junk");
  });

  it("searches every folder except blocked ones and junk, and tags hits with their folder", async () => {
    mockListFolders.mockResolvedValue([
      folder("INBOX"),
      folder("Reisen"),
      folder("Sicherheit"),
      folder("INBOX/Sicherheit"),
      folder("Lizenzen"),
      folder("Trash"),
      folder("Spam"),
      folder("Archiv/Spam-Verdacht"),
    ]);
    mockFindEmails.mockImplementation(async (_c, opts) => {
      if (opts.folder === "Reisen") return [mail("r1", "2026-11-11T12:23:45.000Z")];
      if (opts.folder === "Archiv/Spam-Verdacht") return [mail("s1", "2026-11-15T10:00:00.000Z")];
      return [];
    });

    const result = await call({ subject: "FA IV", folder: "*" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    const searched = mockFindEmails.mock.calls.map((c) => c[1].folder);
    expect(searched).toEqual(["INBOX", "Reisen", "Archiv/Spam-Verdacht"]);
    expect(parsed.searched_folders).toBe(3);
    expect(parsed.skipped_folders).toBeUndefined();
    expect(parsed.count).toBe(2);
    // newest first, with folder
    expect(parsed.emails.map((e: any) => [e.id, e.folder])).toEqual([
      ["s1", "Archiv/Spam-Verdacht"],
      ["r1", "Reisen"],
    ]);
    // filters are passed on to every folder search
    expect(mockFindEmails.mock.calls[1][1].subject).toBe("FA IV");
  });

  it("never opens blocked folders (also not as subfolders)", async () => {
    mockListFolders.mockResolvedValue([
      folder("INBOX"),
      folder("Sicherheit"),
      folder("INBOX/Sicherheit"),
      folder("Sicherheit/Alt"),
      folder("Lizenzen"),
    ]);
    mockFindEmails.mockResolvedValue([]);
    await call({ folder: "*", include_junk: true });
    expect(mockFindEmails.mock.calls.map((c) => c[1].folder)).toEqual(["INBOX"]);
  });

  it("include_junk also searches Trash and Spam", async () => {
    mockListFolders.mockResolvedValue([folder("INBOX"), folder("Trash"), folder("Spam")]);
    mockFindEmails.mockResolvedValue([]);
    await call({ folder: "*", include_junk: true });
    expect(mockFindEmails.mock.calls.map((c) => c[1].folder)).toEqual(["INBOX", "Trash", "Spam"]);
  });

  it("applies the limit to the merged result, newest first", async () => {
    mockListFolders.mockResolvedValue([folder("A"), folder("B")]);
    mockFindEmails.mockImplementation(async (_c, opts) =>
      opts.folder === "A"
        ? [mail("a1", "2026-11-01T00:00:00.000Z"), mail("a2", "2026-11-03T00:00:00.000Z")]
        : [mail("b1", "2026-11-02T00:00:00.000Z"), mail("b2", "2026-11-04T00:00:00.000Z")]
    );
    const result = await call({ folder: "*", limit: 3 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.emails.map((e: any) => e.id)).toEqual(["b2", "a2", "b1"]);
    expect(parsed.count).toBe(3);
  });

  it("redacts subjects of hits", async () => {
    mockListFolders.mockResolvedValue([folder("INBOX")]);
    mockFindEmails.mockResolvedValue([mail("x", "2026-11-11T00:00:00.000Z", "Buchung 26-4cd5f85f TAN 998877")]);
    const result = await call({ folder: "*" });
    expect(result.content[0].text).not.toContain("998877");
  });

  it("skips folders that cannot be opened and reports them", async () => {
    mockListFolders.mockResolvedValue([folder("INBOX/Amazon"), folder("Reisen")]);
    mockFindEmails.mockImplementation(async (_c, opts) => {
      if (opts.folder === "INBOX/Amazon") throw new Error("NONEXISTENT");
      return [mail("r1", "2026-11-11T12:23:45.000Z")];
    });
    const parsed = JSON.parse((await call({ folder: "*" })).content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.searched_folders).toBe(1);
    expect(parsed.skipped_folders).toEqual(["INBOX/Amazon"]);
  });

  it("throws when no folder could be searched at all", async () => {
    mockListFolders.mockResolvedValue([folder("INBOX")]);
    mockFindEmails.mockRejectedValue(new Error("connection lost"));
    await expect(call({ folder: "*" })).rejects.toThrow("connection lost");
  });

  it('a single folder still works as before (no folder field, no listing)', async () => {
    mockFindEmails.mockResolvedValue([mail("x", "2026-11-11T00:00:00.000Z")]);
    const parsed = JSON.parse((await call({ folder: "Reisen" })).content[0].text);
    expect(mockListFolders).not.toHaveBeenCalled();
    expect(parsed.emails[0].folder).toBeUndefined();
    expect(parsed.searched_folders).toBeUndefined();
  });
});
