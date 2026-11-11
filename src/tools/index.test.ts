import { describe, it, expect, vi, beforeEach } from "vitest";
import { tools, handleToolCall } from "./index.js";
import type { ImapClient } from "../imap/index.js";
import type { ToolEnvironment } from "../accounts.js";
import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock the imap module so we don't need real IMAP connections
// ---------------------------------------------------------------------------

vi.mock("../imap/index.js", async () => {
  const actual = await vi.importActual<typeof import("../imap/index.js")>(
    "../imap/index.js"
  );
  return {
    ...actual,
    fetchEmailContent: vi.fn(),
    fetchEmailAttachmentBuffer: vi.fn(),
    fetchRawEmail: vi.fn(),
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    moveEmail: vi.fn(),
    folderExists: vi.fn(),
    bulkMoveBySender: vi.fn(),
    starEmail: vi.fn(),
    unstarEmail: vi.fn(),
    listStarredEmails: vi.fn(),
    resolveEmailId: vi.fn(),
    resolveInMailbox: vi.fn(),
    findEmails: vi.fn(),
    listAllEmailsByColor: vi.fn(),
    listAllStarredEmails: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
  };
});

import {
  fetchEmailContent,
  fetchEmailAttachmentBuffer,
  fetchRawEmail,
  TooLargeError,
  listFolders,
  createFolder,
  moveEmail,
  folderExists,
  bulkMoveBySender,
  starEmail,
  unstarEmail,
  listStarredEmails,
  resolveEmailId,
  resolveInMailbox,
  findEmails,
  listAllEmailsByColor,
  listAllStarredEmails,
  markRead,
  markUnread,
} from "../imap/index.js";

const mockFetchContent = vi.mocked(fetchEmailContent);
const mockFetchAttachment = vi.mocked(fetchEmailAttachmentBuffer);
const mockFetchRaw = vi.mocked(fetchRawEmail);
const mockListFolders = vi.mocked(listFolders);
const mockCreateFolder = vi.mocked(createFolder);
const mockMoveEmail = vi.mocked(moveEmail);
const mockFolderExists = vi.mocked(folderExists);
const mockBulkMoveBySender = vi.mocked(bulkMoveBySender);
const mockStarEmail = vi.mocked(starEmail);
const mockUnstarEmail = vi.mocked(unstarEmail);
const mockListStarredEmails = vi.mocked(listStarredEmails);
const mockResolveEmailId = vi.mocked(resolveEmailId);
const mockResolveInMailbox = vi.mocked(resolveInMailbox);
const mockFindEmails = vi.mocked(findEmails);
const mockListAllEmailsByColor = vi.mocked(listAllEmailsByColor);
const mockListAllStarredEmails = vi.mocked(listAllStarredEmails);
const mockMarkRead = vi.mocked(markRead);
const mockMarkUnread = vi.mocked(markUnread);
const mockImapClient = {} as ImapClient;
const mockEnv: ToolEnvironment = {
  listAccounts: () => [{ id: "acc", user: "me@example.de" }],
  hasAccount: (id) => id === "acc",
  getClient: async () => mockImapClient,
  blockedFolders: ["Sicherheit"],
  maxBodyChars: 4000,
  downloadDir: mkdtempSync(path.join(tmpdir(), "mail-triage-test-")),
  maxDownloadBytes: 1000,
};

/** Call a tool on the mocked account "acc". */
function call(name: string, args: Record<string, unknown> = {}) {
  return handleToolCall(mockEnv, name, { account: "acc", ...args });
}

const TEST_ID = "2026-02-01T10:00:00.<msg@example.com>";

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  it("exposes exactly 16 tools", () => {
    expect(tools).toHaveLength(16);
  });

  it("has the expected tool names", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "list_accounts",
      "find_emails",
      "fetch_email_content",
      "list_folders",
      "create_folder",
      "move_email",
      "star_email",
      "unstar_email",
      "mark_read",
      "mark_unread",
      "list_starred_emails",
      "list_emails_by_color",
      "bulk_move_by_sender_email",
      "bulk_move_by_sender_domain",
      "download_attachment",
      "export_email",
    ]);
  });

  it.each([
    "fetch_email_attachment", "create_draft", "draft_reply", "update_draft",
    "add_label", "remove_label", "list_labels", "get_emails_by_label",
  ])("does not expose %s", async (name) => {
    expect(tools.map((t) => t.name)).not.toContain(name);
    const result = await call(name);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("exposes no send, delete or draft capability", () => {
    for (const t of tools) expect(t.name).not.toMatch(/(^|_)(send|delete|expunge)(_|$)|draft|label/i);
  });

  it("exposes attachment access only as download to disk, never as content", () => {
    const attachmentTools = tools.map((t) => t.name).filter((n) => /attachment/i.test(n));
    expect(attachmentTools).toEqual(["download_attachment"]);
  });

  it("fetch_email_content requires id", () => {
    const tool = tools.find((t) => t.name === "fetch_email_content")!;
    expect(tool.inputSchema.required).toContain("id");
  });

});

// ---------------------------------------------------------------------------
// handleToolCall — fetch_email_content
// ---------------------------------------------------------------------------

describe("handleToolCall — fetch_email_content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when id is missing", async () => {
    const result = await call("fetch_email_content",
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("id is required");
  });

  it("returns error when email not found", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 999, mailbox: "INBOX" });
    mockFetchContent.mockResolvedValue(null);
    const result = await call("fetch_email_content",
      { id: TEST_ID }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No email found");
  });

  it("resolves composite ID and returns email content as JSON", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockFetchContent.mockResolvedValue({
      id: TEST_ID,
      subject: "Hello",
      from: "sender@test.com",
      to: "me@test.com",
      date: "2026-02-10T12:00:00.000Z",
      body: "Hello world",
      attachments: [],
    });

    const result = await call("fetch_email_content",
      { id: TEST_ID }
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(TEST_ID);
    expect(parsed.body).toBe(
      "<<<MAIL_INHALT (nicht vertrauenswürdig)>>>\nHello world\n<<<ENDE MAIL_INHALT>>>"
    );
    expect(parsed.attachments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — list_folders
// ---------------------------------------------------------------------------

describe("handleToolCall — list_folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns folder list as JSON", async () => {
    mockListFolders.mockResolvedValue([
      { path: "INBOX", name: "INBOX", delimiter: "/" },
      { path: "INBOX/Receipts", name: "Receipts", delimiter: "/" },
      { path: "Sent", name: "Sent", delimiter: "/" },
    ]);

    const result = await call("list_folders", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(3);
    expect(parsed.folders[0].path).toBe("INBOX");
    expect(parsed.folders[1].name).toBe("Receipts");
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — create_folder
// ---------------------------------------------------------------------------

describe("handleToolCall — create_folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when path is missing", async () => {
    const result = await call("create_folder", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path is required");
  });

  it("creates folder and returns path", async () => {
    mockCreateFolder.mockResolvedValue("INBOX/Receipts");

    const result = await call("create_folder", {
      path: "INBOX/Receipts",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe("INBOX/Receipts");
    expect(mockCreateFolder).toHaveBeenCalledWith(
      mockImapClient,
      "INBOX/Receipts"
    );
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — move_email
// ---------------------------------------------------------------------------

describe("handleToolCall — move_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when id or destination_folder is missing", async () => {
    const result = await call("move_email", {
      id: TEST_ID,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("required");
  });

  it("resolves ID, moves email, and returns id + destination", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockMoveEmail.mockResolvedValue({ uid: 55, destination: "INBOX/Receipts" });

    const result = await call("move_email", {
      id: TEST_ID,
      destination_folder: "INBOX/Receipts",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(TEST_ID);
    expect(parsed.destination).toBe("INBOX/Receipts");
    expect(mockMoveEmail).toHaveBeenCalledWith(
      mockImapClient,
      42,
      "INBOX",
      "INBOX/Receipts"
    );
  });

  it("uses source_folder as hint", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 7, mailbox: "Sent" });
    mockMoveEmail.mockResolvedValue({ uid: 10, destination: "Archive" });

    await call("move_email", {
      id: TEST_ID,
      source_folder: "Sent",
      destination_folder: "Archive",
    });
    expect(mockResolveEmailId).toHaveBeenCalledWith(
      mockImapClient,
      TEST_ID,
      "Sent",
      ["Sicherheit"]
    );
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — star_email / unstar_email
// ---------------------------------------------------------------------------

describe("handleToolCall — star_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when id is missing", async () => {
    const result = await call("star_email", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("id is required");
  });

  it("resolves ID and stars the email", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockStarEmail.mockResolvedValue({ uid: 42, starred: true });

    const result = await call("star_email", {
      id: TEST_ID,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(TEST_ID);
    expect(parsed.starred).toBe(true);
  });
});

describe("handleToolCall — unstar_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves ID and unstars the email", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockUnstarEmail.mockResolvedValue({ uid: 42, starred: false });

    const result = await call("unstar_email", {
      id: TEST_ID,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(TEST_ID);
    expect(parsed.starred).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — bulk_move_by_sender_email
// ---------------------------------------------------------------------------

describe("handleToolCall — bulk_move_by_sender_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires sender, source_folder, and destination_folder", () => {
    const tool = tools.find((t) => t.name === "bulk_move_by_sender_email")!;
    expect(tool.inputSchema.required).toContain("sender");
    expect(tool.inputSchema.required).toContain("source_folder");
    expect(tool.inputSchema.required).toContain("destination_folder");
  });

  it("returns error when required params are missing", async () => {
    const result = await call("bulk_move_by_sender_email",
      { sender: "alice@example.com" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("required");
  });

  it("returns error when source folder not found", async () => {
    mockFolderExists.mockResolvedValueOnce(false);
    const result = await call("bulk_move_by_sender_email",
      {
        sender: "alice@example.com",
        source_folder: "NonExistent",
        destination_folder: "Archive",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Source folder not found");
  });

  it("returns error when destination folder not found", async () => {
    mockFolderExists.mockResolvedValueOnce(true);
    mockFolderExists.mockResolvedValueOnce(false);
    const result = await call("bulk_move_by_sender_email",
      {
        sender: "alice@example.com",
        source_folder: "INBOX",
        destination_folder: "NonExistent",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Destination folder not found");
  });

  it("returns error when no emails match", async () => {
    mockFolderExists.mockResolvedValue(true);
    mockBulkMoveBySender.mockResolvedValue(0);
    const result = await call("bulk_move_by_sender_email",
      {
        sender: "nobody@example.com",
        source_folder: "INBOX",
        destination_folder: "Archive",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No emails from");
  });

  it("calls bulkMoveBySender and returns moved count", async () => {
    mockFolderExists.mockResolvedValue(true);
    mockBulkMoveBySender.mockResolvedValue(5);

    const result = await call("bulk_move_by_sender_email",
      {
        sender: "alice@example.com",
        source_folder: "INBOX",
        destination_folder: "Archive",
      }
    );

    expect(mockBulkMoveBySender).toHaveBeenCalledWith(
      mockImapClient,
      "INBOX",
      "Archive",
      "alice@example.com"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.moved).toBe(5);
    expect(parsed.source_folder).toBe("INBOX");
    expect(parsed.destination_folder).toBe("Archive");
    expect(parsed.sender).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — bulk_move_by_sender_domain
// ---------------------------------------------------------------------------

describe("handleToolCall — bulk_move_by_sender_domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires domain, source_folder, and destination_folder", () => {
    const tool = tools.find((t) => t.name === "bulk_move_by_sender_domain")!;
    expect(tool.inputSchema.required).toContain("domain");
    expect(tool.inputSchema.required).toContain("source_folder");
    expect(tool.inputSchema.required).toContain("destination_folder");
  });

  it("returns error when required params are missing", async () => {
    const result = await call("bulk_move_by_sender_domain",
      { domain: "example.com" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("required");
  });

  it("returns error when source folder not found", async () => {
    mockFolderExists.mockResolvedValueOnce(false);
    const result = await call("bulk_move_by_sender_domain",
      {
        domain: "example.com",
        source_folder: "NonExistent",
        destination_folder: "Archive",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Source folder not found");
  });

  it("returns error when destination folder not found", async () => {
    mockFolderExists.mockResolvedValueOnce(true);
    mockFolderExists.mockResolvedValueOnce(false);
    const result = await call("bulk_move_by_sender_domain",
      {
        domain: "example.com",
        source_folder: "INBOX",
        destination_folder: "NonExistent",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Destination folder not found");
  });

  it("returns error when no emails match", async () => {
    mockFolderExists.mockResolvedValue(true);
    mockBulkMoveBySender.mockResolvedValue(0);
    const result = await call("bulk_move_by_sender_domain",
      {
        domain: "nobody.com",
        source_folder: "INBOX",
        destination_folder: "Archive",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No emails from");
  });

  it("calls bulkMoveBySender with @domain prefix and returns moved count", async () => {
    mockFolderExists.mockResolvedValue(true);
    mockBulkMoveBySender.mockResolvedValue(12);

    const result = await call("bulk_move_by_sender_domain",
      {
        domain: "example.com",
        source_folder: "INBOX",
        destination_folder: "Promotions",
      }
    );

    expect(mockBulkMoveBySender).toHaveBeenCalledWith(
      mockImapClient,
      "INBOX",
      "Promotions",
      "@example.com"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.moved).toBe(12);
    expect(parsed.source_folder).toBe("INBOX");
    expect(parsed.destination_folder).toBe("Promotions");
    expect(parsed.domain).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — find_emails
// ---------------------------------------------------------------------------

describe("handleToolCall — find_emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies a default limit and folder INBOX when no params given", async () => {
    mockFindEmails.mockResolvedValue([]);
    await call("find_emails", {});
    expect(mockFindEmails).toHaveBeenCalledWith(mockImapClient, {
      folder: "INBOX",
      limit: 50,
    });
  });

  it("clamps an oversized limit to the maximum", async () => {
    mockFindEmails.mockResolvedValue([]);
    await call("find_emails", { limit: 5000 });
    const opts = mockFindEmails.mock.calls[0][1];
    expect(opts.limit).toBe(200);
  });

  it("parses relative after param", async () => {
    mockFindEmails.mockResolvedValue([]);
    const before = Date.now();
    await call("find_emails", { after: "2h" });

    const opts = mockFindEmails.mock.calls[0][1];
    expect(opts.after).toBeInstanceOf(Date);
    const diffH = (before - opts.after!.getTime()) / (1000 * 60 * 60);
    expect(diffH).toBeGreaterThanOrEqual(1.99);
    expect(diffH).toBeLessThanOrEqual(2.01);
  });

  it("parses ISO before param", async () => {
    mockFindEmails.mockResolvedValue([]);
    await call("find_emails", {
      before: "2026-02-20T00:00:00Z",
    });
    const opts = mockFindEmails.mock.calls[0][1];
    expect(opts.before).toEqual(new Date("2026-02-20T00:00:00Z"));
  });

  it("passes from, subject, unread_only, has_attachment, limit", async () => {
    mockFindEmails.mockResolvedValue([]);
    await call("find_emails", {
      from: "@stripe.com",
      subject: "invoice",
      unread_only: true,
      has_attachment: true,
      folder: "Sent",
      limit: 5,
    });
    expect(mockFindEmails).toHaveBeenCalledWith(mockImapClient, {
      from: "@stripe.com",
      subject: "invoice",
      unreadOnly: true,
      hasAttachment: true,
      folder: "Sent",
      limit: 5,
    });
  });

  it("returns error for invalid after value", async () => {
    const result = await call("find_emails", {
      after: "xyz",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid time parameter");
  });

  it("returns count and emails", async () => {
    mockFindEmails.mockResolvedValue([
      { id: TEST_ID, subject: "Hello", from: "a@b.com", date: "2026-02-20T00:00:00.000Z" },
    ]);
    const result = await call("find_emails", { after: "7d" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.emails[0].subject).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — list_emails_by_color
// ---------------------------------------------------------------------------

describe("handleToolCall — list_emails_by_color", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restricts color to the Apple Mail palette and has no required params", () => {
    const tool = tools.find((t) => t.name === "list_emails_by_color")!;
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.color.enum).toEqual([
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "grey",
    ]);
    expect(tool.inputSchema.required).toEqual(["account"]);
  });

  it("lists all colors when no color is given", async () => {
    mockListAllEmailsByColor.mockResolvedValue([]);

    await call("list_emails_by_color", {});

    expect(mockListAllEmailsByColor).toHaveBeenCalledWith(mockImapClient, undefined, ["Sicherheit"]);
  });

  it("passes the color filter through", async () => {
    mockListAllEmailsByColor.mockResolvedValue([]);

    await call("list_emails_by_color", { color: "red" });

    expect(mockListAllEmailsByColor).toHaveBeenCalledWith(mockImapClient, "red", ["Sicherheit"]);
  });

  it("returns totalCount summed across folders plus the folder groups", async () => {
    const email = (n: number, color: string) => ({
      id: `${TEST_ID}${n}`,
      subject: `Mail ${n}`,
      from: "a@example.com",
      date: "2026-02-01T10:00:00.000Z",
      color,
    });
    mockListAllEmailsByColor.mockResolvedValue([
      { folder: "INBOX", count: 2, emails: [email(1, "red"), email(2, "blue")] },
      { folder: "Sent", count: 1, emails: [email(3, "red")] },
    ]);

    const result = await call("list_emails_by_color", {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalCount).toBe(3);
    expect(parsed.folders).toHaveLength(2);
    expect(parsed.folders[0].folder).toBe("INBOX");
    expect(parsed.folders[1].emails[0].color).toBe("red");
  });

  it("returns totalCount 0 when nothing is color-flagged", async () => {
    mockListAllEmailsByColor.mockResolvedValue([]);

    const result = await call("list_emails_by_color", {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ totalCount: 0, folders: [] });
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — mark_read / mark_unread
// ---------------------------------------------------------------------------

describe("handleToolCall — mark_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an error when id is missing", async () => {
    const result = await call("mark_read", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("id is required");
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("resolves the id and marks the email as read", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockMarkRead.mockResolvedValue({ uid: 42, read: true });

    const result = await call("mark_read", { id: TEST_ID });

    expect(mockMarkRead).toHaveBeenCalledWith(mockImapClient, 42, "INBOX");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: TEST_ID, read: true });
  });

  it("passes the mailbox hint to the id resolver", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 7, mailbox: "Archive" });
    mockMarkRead.mockResolvedValue({ uid: 7, read: true });

    await call("mark_read", { id: TEST_ID, mailbox: "Archive" });

    expect(mockResolveEmailId).toHaveBeenCalledWith(mockImapClient, TEST_ID, "Archive", ["Sicherheit"]);
    expect(mockMarkRead).toHaveBeenCalledWith(mockImapClient, 7, "Archive");
  });
});

describe("handleToolCall — mark_unread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an error when id is missing", async () => {
    const result = await call("mark_unread", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("id is required");
    expect(mockMarkUnread).not.toHaveBeenCalled();
  });

  it("resolves the id and marks the email as unread", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 42, mailbox: "INBOX" });
    mockMarkUnread.mockResolvedValue({ uid: 42, read: false });

    const result = await call("mark_unread", { id: TEST_ID });

    expect(mockMarkUnread).toHaveBeenCalledWith(mockImapClient, 42, "INBOX");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: TEST_ID, read: false });
  });

  it("passes the mailbox hint to the id resolver", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 7, mailbox: "Archive" });
    mockMarkUnread.mockResolvedValue({ uid: 7, read: false });

    await call("mark_unread", { id: TEST_ID, mailbox: "Archive" });

    expect(mockResolveEmailId).toHaveBeenCalledWith(mockImapClient, TEST_ID, "Archive", ["Sicherheit"]);
    expect(mockMarkUnread).toHaveBeenCalledWith(mockImapClient, 7, "Archive");
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — list_starred_emails
// ---------------------------------------------------------------------------

describe("handleToolCall — list_starred_emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns totalCount summed across folders plus the folder groups", async () => {
    const email = (n: number) => ({
      id: `${TEST_ID}${n}`,
      subject: `Starred ${n}`,
      from: "a@example.com",
      date: "2026-02-01T10:00:00.000Z",
    });
    mockListAllStarredEmails.mockResolvedValue([
      { folder: "INBOX", count: 2, emails: [email(1), email(2)] },
      { folder: "Sent", count: 1, emails: [email(3)] },
    ]);

    const result = await call("list_starred_emails", {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalCount).toBe(3);
    expect(parsed.folders.map((g: { folder: string }) => g.folder)).toEqual(["INBOX", "Sent"]);
  });

  it("returns totalCount 0 when nothing is starred", async () => {
    mockListAllStarredEmails.mockResolvedValue([]);

    const result = await call("list_starred_emails", {});

    expect(JSON.parse(result.content[0].text)).toEqual({ totalCount: 0, folders: [] });
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — unknown tool
// ---------------------------------------------------------------------------

describe("handleToolCall — accounts", () => {
  it("list_accounts returns ids and users only", async () => {
    const result = await handleToolCall(mockEnv, "list_accounts", {});
    expect(JSON.parse(result.content[0].text)).toEqual({
      accounts: [{ id: "acc", user: "me@example.de" }],
    });
  });

  it("requires the account parameter", async () => {
    const result = await handleToolCall(mockEnv, "list_folders", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("account is required");
  });

  it("rejects unknown accounts", async () => {
    const result = await handleToolCall(mockEnv, "list_folders", { account: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown account");
  });

  it("marks account as required in every mailbox tool schema", () => {
    for (const t of tools.filter((t) => t.name !== "list_accounts")) {
      expect(t.inputSchema.required, t.name).toContain("account");
      expect(t.inputSchema.properties, t.name).toHaveProperty("account");
    }
  });

  it("serializes concurrent calls", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockListFolders.mockImplementationOnce(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return [];
    });
    mockListFolders.mockImplementationOnce(async () => {
      order.push("second-start");
      return [];
    });
    const a = call("list_folders");
    const b = call("list_folders");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("handleToolCall — blocked folders", () => {
  const BLOCKED = "Ordner gesperrt";

  async function expectBlocked(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(BLOCKED);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEmailId.mockResolvedValue({ uid: 1, mailbox: "INBOX" });
  });

  it("find_emails refuses blocked folders (any spelling)", async () => {
    for (const folder of ["Sicherheit", "INBOX/Sicherheit", "INBOX.sicherheit"]) {
      await expectBlocked("find_emails", { folder });
    }
    expect(mockFindEmails).not.toHaveBeenCalled();
  });

  it("fetch_email_content refuses a blocked mailbox hint", async () => {
    await expectBlocked("fetch_email_content", { id: TEST_ID, mailbox: "INBOX.Sicherheit" });
    expect(mockFetchContent).not.toHaveBeenCalled();
  });

  it("refuses when an unhinted id resolves into a blocked folder", async () => {
    mockResolveEmailId.mockResolvedValue({ uid: 1, mailbox: "INBOX/Sicherheit" });
    await expectBlocked("fetch_email_content", { id: TEST_ID });
    expect(mockFetchContent).not.toHaveBeenCalled();
    await expectBlocked("move_email", { id: TEST_ID, destination_folder: "Archive" });
    expect(mockMoveEmail).not.toHaveBeenCalled();
  });

  it("passes the denylist to the id resolver so searches skip blocked folders", async () => {
    mockFetchContent.mockResolvedValue(null);
    await call("fetch_email_content", { id: TEST_ID });
    expect(mockResolveEmailId).toHaveBeenCalledWith(mockImapClient, TEST_ID, undefined, ["Sicherheit"]);
  });

  it("move_email refuses blocked source and destination", async () => {
    await expectBlocked("move_email", { id: TEST_ID, source_folder: "Sicherheit", destination_folder: "Archive" });
    await expectBlocked("move_email", { id: TEST_ID, destination_folder: "INBOX/Sicherheit" });
    expect(mockMoveEmail).not.toHaveBeenCalled();
  });

  it("bulk moves refuse blocked source and destination", async () => {
    for (const [tool, extra] of [
      ["bulk_move_by_sender_email", { sender: "a@b.de" }],
      ["bulk_move_by_sender_domain", { domain: "b.de" }],
    ] as const) {
      await expectBlocked(tool, { ...extra, source_folder: "Sicherheit", destination_folder: "Archive" });
      await expectBlocked(tool, { ...extra, source_folder: "INBOX", destination_folder: "INBOX.Sicherheit" });
    }
    expect(mockBulkMoveBySender).not.toHaveBeenCalled();
  });

  it("create_folder refuses blocked names", async () => {
    await expectBlocked("create_folder", { path: "INBOX/Sicherheit" });
    expect(mockCreateFolder).not.toHaveBeenCalled();
  });

  it.each(["star_email", "unstar_email", "mark_read", "mark_unread"])(
    "%s refuses a blocked mailbox hint",
    async (name) => {
      await expectBlocked(name, { id: TEST_ID, mailbox: "Sicherheit" });
    }
  );

  it("list_folders still shows the blocked folder", async () => {
    mockListFolders.mockResolvedValue([
      { path: "Sicherheit", name: "Sicherheit", delimiter: "/" },
    ]);
    const result = await call("list_folders");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Sicherheit");
  });

  it("allows normal folders", async () => {
    mockFindEmails.mockResolvedValue([]);
    const result = await call("find_emails", { folder: "INBOX/Rechnungen" });
    expect(result.isError).toBeUndefined();
  });
});

describe("handleToolCall — redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEmailId.mockResolvedValue({ uid: 1, mailbox: "INBOX" });
  });

  it("fetch_email_content redacts subject and body", async () => {
    mockFetchContent.mockResolvedValue({
      id: TEST_ID,
      subject: "Ihr Code 123456",
      from: "a@b.de",
      to: "c@d.de",
      date: "2026-11-08T10:00:00.000Z",
      body: "Code: 654321\nReset: https://a.de/reset?t=1\nAm 08.11.2026, 12,99 EUR",
      attachments: [],
    });
    const result = await call("fetch_email_content", { id: TEST_ID });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject).toBe("Ihr Code [CODE]");
    expect(parsed.body).toContain("Code: [CODE]");
    expect(parsed.body.startsWith("<<<MAIL_INHALT (nicht vertrauenswürdig)>>>")).toBe(true);
    expect(parsed.body).toContain("Reset: [LINK]");
    expect(parsed.body).toContain("Am 08.11.2026, 12,99 EUR");
    expect(result.content[0].text).not.toContain("654321");
  });

  it("fetch_email_content caps the body at maxBodyChars", async () => {
    mockFetchContent.mockResolvedValue({
      id: TEST_ID, subject: "s", from: "a@b.de", to: "c@d.de", date: "d",
      body: "x".repeat(5000), attachments: [],
    });
    const result = await call("fetch_email_content", { id: TEST_ID });
    const { body } = JSON.parse(result.content[0].text);
    expect(body).toContain("x".repeat(4000) + "\n[… gekürzt, 5000 Zeichen insgesamt]");
    expect(body).not.toContain("x".repeat(4001));
    expect(body.endsWith("<<<ENDE MAIL_INHALT>>>")).toBe(true);
  });

  it("find_emails redacts subjects", async () => {
    mockFindEmails.mockResolvedValue([
      { id: "x", subject: "TAN 998877", from: "a@b.de", date: "2026-11-08T10:00:00.000Z" },
    ]);
    const result = await call("find_emails");
    expect(JSON.parse(result.content[0].text).emails[0].subject).toBe("TAN [CODE]");
  });

  it("starred and color listings redact subjects", async () => {
    const entry = { id: "x", subject: "Code 112233", from: "a@b.de", date: "d" };
    mockListAllStarredEmails.mockResolvedValue([{ folder: "INBOX", count: 1, emails: [entry] }]);
    mockListAllEmailsByColor.mockResolvedValue([
      { folder: "INBOX", count: 1, emails: [{ ...entry, color: "red" }] },
    ]);
    for (const tool of ["list_starred_emails", "list_emails_by_color"]) {
      const result = await call(tool);
      expect(result.content[0].text).toContain("Code [CODE]");
      expect(result.content[0].text).not.toContain("112233");
    }
  });
});

describe("handleToolCall — unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const result = await call("nonexistent_tool",
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });
});


// ---------------------------------------------------------------------------
// download_attachment / export_email
// ---------------------------------------------------------------------------

describe("download_attachment", () => {
  beforeEach(() => {
    mockResolveEmailId.mockResolvedValue({ uid: 7, mailbox: "INBOX" });
  });

  it("writes the file into the download folder and returns only metadata", async () => {
    mockFetchAttachment.mockResolvedValue({
      id: "attachment-0",
      filename: "../../etc/Rechnung 11.PDF",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-fake"),
      size: 9,
    });
    const result = await call("download_attachment", { id: TEST_ID, attachment_id: "attachment-0" });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.path.startsWith(path.join(mockEnv.downloadDir, "acc") + path.sep)).toBe(true);
    expect(path.basename(data.path)).toMatch(/^2026-02-01_[0-9a-f]{8}_Rechnung 11\.pdf$/);
    expect(readFileSync(data.path, "utf8")).toBe("%PDF-fake");
    expect(statSync(data.path).mode & 0o777).toBe(0o600);
    expect(data.filename).toBe("Rechnung 11.pdf");
    expect(data.size).toBe(9);
    expect(data.reused).toBe(false);
    // content must not travel through the tool result
    expect(result.content[0].text).not.toContain("%PDF");
    expect(result.content[0].text).not.toContain("contentBase64");
    expect(mockFetchAttachment).toHaveBeenCalledWith(mockImapClient, 7, "attachment-0", "INBOX", 1000);
  });

  it("is idempotent: the same download again reuses the file", async () => {
    mockFetchAttachment.mockResolvedValue({
      id: "attachment-1", filename: "a.txt", contentType: "text/plain",
      content: Buffer.from("hello"), size: 5,
    });
    const first = JSON.parse((await call("download_attachment", { id: TEST_ID, attachment_id: "attachment-1" })).content[0].text);
    const second = JSON.parse((await call("download_attachment", { id: TEST_ID, attachment_id: "attachment-1" })).content[0].text);
    expect(second.path).toBe(first.path);
    expect(second.reused).toBe(true);
  });

  it("reports too-large attachments as an error", async () => {
    mockFetchAttachment.mockRejectedValue(new TooLargeError(5000, 1000));
    const result = await call("download_attachment", { id: TEST_ID, attachment_id: "attachment-0" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Zu groß");
  });

  it("errors when the attachment does not exist", async () => {
    mockFetchAttachment.mockResolvedValue(null);
    const result = await call("download_attachment", { id: TEST_ID, attachment_id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No attachment");
  });

  it("requires id and attachment_id", async () => {
    const result = await call("download_attachment", { id: TEST_ID });
    expect(result.isError).toBe(true);
  });

  it("refuses blocked folders without touching the mail", async () => {
    mockFetchAttachment.mockClear();
    const hint = await call("download_attachment", { id: TEST_ID, attachment_id: "a", mailbox: "INBOX.Sicherheit" });
    expect(hint.isError).toBe(true);
    expect(hint.content[0].text).toBe("Ordner gesperrt");

    mockResolveEmailId.mockResolvedValue({ uid: 7, mailbox: "Sicherheit/Alt" });
    const resolved = await call("download_attachment", { id: TEST_ID, attachment_id: "a" });
    expect(resolved.content[0].text).toBe("Ordner gesperrt");
    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });
});

describe("export_email", () => {
  beforeEach(() => {
    mockResolveEmailId.mockResolvedValue({ uid: 9, mailbox: "INBOX" });
  });

  it("writes the unmodified source as .eml and redacts codes in the file name", async () => {
    const source = Buffer.from("From: a@b.de\r\nSubject: TAN 998877 für Rechnung\r\n\r\nBody 998877\r\n");
    mockFetchRaw.mockResolvedValue({
      source, subject: "TAN 998877 für Rechnung", date: "2026-02-01T10:00:00.000Z", id: TEST_ID,
    });
    const result = await call("export_email", { id: TEST_ID });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(path.extname(data.path)).toBe(".eml");
    expect(path.basename(data.path)).toMatch(/^2026-02-01_[0-9a-f]{8}_TAN-CODE-fur-Rechnung\.eml$/);
    expect(readFileSync(data.path)).toEqual(source); // original, not redacted
    expect(data.size).toBe(source.length);
    expect(result.content[0].text).not.toContain("Body");
    expect(mockFetchRaw).toHaveBeenCalledWith(mockImapClient, 9, "INBOX", 1000);
  });

  it("reports too-large mails and missing mails as errors", async () => {
    mockFetchRaw.mockRejectedValueOnce(new TooLargeError(9999, 1000));
    expect((await call("export_email", { id: TEST_ID })).content[0].text).toContain("Zu groß");

    mockFetchRaw.mockResolvedValueOnce(null);
    const missing = await call("export_email", { id: TEST_ID });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("No email found");
  });

  it("refuses blocked folders", async () => {
    mockFetchRaw.mockClear();
    mockResolveEmailId.mockResolvedValue({ uid: 9, mailbox: "INBOX/Sicherheit" });
    const result = await call("export_email", { id: TEST_ID });
    expect(result.content[0].text).toBe("Ordner gesperrt");
    expect(mockFetchRaw).not.toHaveBeenCalled();
  });

  it("keeps accounts in separate subfolders", async () => {
    mockFetchRaw.mockResolvedValue({ source: Buffer.from("x"), subject: "s", date: "", id: TEST_ID });
    await call("export_email", { id: TEST_ID });
    expect(readdirSync(mockEnv.downloadDir)).toContain("acc");
  });
});
