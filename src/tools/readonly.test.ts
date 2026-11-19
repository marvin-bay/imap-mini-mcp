import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall, getTools, tools, MUTATING_TOOLS } from "./index.js";
import type { ImapClient } from "../imap/index.js";
import type { ToolEnvironment } from "../accounts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../imap/index.js", async () => {
  const actual = await vi.importActual<typeof import("../imap/index.js")>("../imap/index.js");
  return {
    ...actual,
    findEmails: vi.fn(),
    fetchEmailContent: vi.fn(),
    resolveEmailId: vi.fn(),
    moveEmail: vi.fn(),
    createFolder: vi.fn(),
    starEmail: vi.fn(),
    unstarEmail: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    bulkMoveBySender: vi.fn(),
    folderExists: vi.fn(),
  };
});

import * as imap from "../imap/index.js";

const baseEnv = {
  listAccounts: () => [{ id: "uni", user: "me@uni.example" }],
  hasAccount: (id: string) => id === "uni",
  getClient: async () => ({}) as ImapClient,
  blockedFolders: [],
  maxBodyChars: 4000,
  downloadDir: mkdtempSync(path.join(tmpdir(), "mail-export-test-")),
  maxDownloadBytes: 1000,
};
const readOnlyEnv: ToolEnvironment = { ...baseEnv, readOnly: true };
const normalEnv: ToolEnvironment = { ...baseEnv, readOnly: false };

const MUTATING_ARGS: Record<string, Record<string, unknown>> = {
  create_folder: { path: "X" },
  move_email: { id: "i", destination_folder: "X" },
  star_email: { id: "i" },
  unstar_email: { id: "i" },
  mark_read: { id: "i" },
  mark_unread: { id: "i" },
  bulk_move_by_sender_email: { sender: "a@b.de", source_folder: "A", destination_folder: "B" },
  bulk_move_by_sender_domain: { domain: "b.de", source_folder: "A", destination_folder: "B" },
};

describe("read-only mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every mutating tool in MUTATING_TOOLS and no others", () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(Object.keys(MUTATING_ARGS).sort());
    for (const name of MUTATING_TOOLS) expect(tools.map((t) => t.name)).toContain(name);
  });

  it("offers all tools in normal mode", () => {
    expect(getTools(normalEnv)).toEqual(tools);
    expect(getTools({ ...baseEnv } as ToolEnvironment)).toEqual(tools); // flag unset
  });

  it("hides exactly the mutating tools in read-only mode", () => {
    const names = getTools(readOnlyEnv).map((t) => t.name);
    for (const name of MUTATING_TOOLS) expect(names).not.toContain(name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_accounts", "find_emails", "fetch_email_content", "list_folders",
        "list_starred_emails", "list_emails_by_color", "download_attachment", "export_email",
      ])
    );
    expect(names).toHaveLength(tools.length - MUTATING_TOOLS.size);
  });

  it.each(Object.keys(MUTATING_ARGS))("refuses %s without touching IMAP", async (name) => {
    const result = await handleToolCall(readOnlyEnv, name, { account: "uni", ...MUTATING_ARGS[name] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Schreibgeschützt");
    for (const fn of [
      imap.moveEmail, imap.createFolder, imap.starEmail, imap.unstarEmail,
      imap.markRead, imap.markUnread, imap.bulkMoveBySender, imap.resolveEmailId, imap.folderExists,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("refuses even when the account is unknown (no information leak, no IMAP login)", async () => {
    const getClient = vi.fn();
    const result = await handleToolCall({ ...readOnlyEnv, getClient }, "move_email", { account: "uni", id: "i", destination_folder: "X" });
    expect(result.isError).toBe(true);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("still allows reading", async () => {
    vi.mocked(imap.findEmails).mockResolvedValue([
      { id: "x", subject: "Hallo", from: "a@b.de", date: "2026-01-01T00:00:00.000Z" },
    ]);
    const result = await handleToolCall(readOnlyEnv, "find_emails", { account: "uni" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).count).toBe(1);
  });

  it("normal mode still performs mutations", async () => {
    vi.mocked(imap.resolveEmailId).mockResolvedValue({ uid: 1, mailbox: "INBOX" });
    vi.mocked(imap.markRead).mockResolvedValue(undefined as never);
    const result = await handleToolCall(normalEnv, "mark_read", { account: "uni", id: "i" });
    expect(result.isError).toBeUndefined();
    expect(imap.markRead).toHaveBeenCalled();
  });
});
