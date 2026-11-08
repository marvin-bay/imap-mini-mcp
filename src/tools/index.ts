/**
 * MCP Tool definitions for the IMAP email server.
 *
 * Each tool co-locates its schema and handler in a single registration object.
 * Adding a new tool means adding a new entry to the registry — no dispatch
 * logic needs to change (OCP). Schema and handler live together (SRP).
 */

import type { ImapClient } from "../imap/index.js";
import type { ToolEnvironment } from "../accounts.js";
import { BLOCKED_MESSAGE, isBlockedFolder } from "../blocked.js";
import {
  fetchEmailContent,
  listFolders,
  createFolder,
  moveEmail,
  folderExists,
  bulkMoveBySender,
  starEmail,
  unstarEmail,
  markRead,
  markUnread,
  listAllStarredEmails,
  listAllEmailsByColor,
  resolveEmailId,
  findEmails,
  parseTimeParam,
} from "../imap/index.js";

// ---------------------------------------------------------------------------
// Tool registry types and helpers
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
  [key: string]: unknown;
}

interface ToolRegistration {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
  handler: (
    imapClient: ImapClient,
    args: Record<string, unknown>,
    env: ToolEnvironment
  ) => Promise<ToolResult>;
}

const ACCOUNT_SCHEMA = {
  account: {
    type: "string",
    description: "Account id (see list_accounts).",
  },
};

function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

class BlockedFolderError extends Error {
  constructor() {
    super(BLOCKED_MESSAGE);
  }
}

/** Throws (reported as "Ordner gesperrt") if any given folder is on the denylist. */
function assertAllowed(env: ToolEnvironment, ...folders: (string | undefined)[]) {
  for (const f of folders) {
    if (f && isBlockedFolder(f, env.blockedFolders)) throw new BlockedFolderError();
  }
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Shared schema and description helpers
// ---------------------------------------------------------------------------

const LIST_DESCRIPTION_SUFFIX =
  "Returns an array of {id, subject, from, date} objects sorted newest-first. " +
  "The id is a globally unique identifier — use it with fetch_email_content to read the full email.";

const MAILBOX_HINT_SCHEMA = {
  mailbox: {
    type: "string",
    description:
      "Optional folder hint for faster lookup. If omitted, searches all folders.",
  },
};

// Default and hard-cap result counts for find_emails. Without a cap, a bare
// call returns the entire mailbox in a single tool result (hundreds of KB /
// 100K+ tokens), which overwhelms the MCP client and surfaces as a timeout.
const FIND_EMAILS_DEFAULT_LIMIT = 50;
const FIND_EMAILS_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const registry: ToolRegistration[] = [
  {
    name: "find_emails",
    description:
      "Search and filter emails. All parameters are optional — calling with no parameters " +
      "returns the most recent emails from INBOX (default 50, max 200). " +
      LIST_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        after: {
          type: "string",
          description:
            'Only emails after this time. Relative ("30m", "2h", "7d") or ISO date.',
        },
        before: {
          type: "string",
          description:
            'Only emails before this time. Relative ("30m", "2h", "7d") or ISO date.',
        },
        from: {
          type: "string",
          description:
            'Substring match on sender address (e.g. "alice@example.com", "@stripe.com").',
        },
        subject: {
          type: "string",
          description: "Substring match on subject line.",
        },
        unread_only: {
          type: "boolean",
          description: "Only return unread emails. Default: false.",
        },
        has_attachment: {
          type: "boolean",
          description: "Only return emails with attachments. Default: false.",
        },
        folder: {
          type: "string",
          description: 'Folder to search. Default: "INBOX".',
        },
        limit: {
          type: "number",
          description:
            "Maximum number of results to return (newest first). Default 50, max 200.",
        },
      },
      required: ["account"],
    },
    handler: async (imapClient, args, env) => {
      const opts: any = {
        folder: (args.folder as string) || "INBOX",
      };

      try {
        if (args.after) {
          opts.after = parseTimeParam(args.after as string);
        }
        if (args.before) {
          opts.before = parseTimeParam(args.before as string);
        }
      } catch (err: any) {
        return errorResult(err.message);
      }

      if (args.from) opts.from = args.from as string;
      if (args.subject) opts.subject = args.subject as string;
      if (args.unread_only) opts.unreadOnly = true;
      if (args.has_attachment) opts.hasAttachment = true;
      if (args.limit !== undefined) {
        const limit = args.limit as number;
        if (limit < 1) return errorResult("Error: limit must be a positive number.");
        opts.limit = Math.min(limit, FIND_EMAILS_MAX_LIMIT);
      } else {
        opts.limit = FIND_EMAILS_DEFAULT_LIMIT;
      }

      assertAllowed(env, opts.folder);
      const emails = await findEmails(imapClient, opts);
      return jsonResult({ count: emails.length, emails });
    },
  },

  {
    name: "fetch_email_content",
    description:
      "Fetch the full content of a single email by its id. " +
      "Returns {id, subject, from, to, date, body, attachments}. " +
      "The attachments array contains metadata only (id, filename, contentType, size); " +
      "attachment contents cannot be downloaded. " +
      "Use an id obtained from any of the list_emails_* tools.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier from list results.",
        },
        ...MAILBOX_HINT_SCHEMA,
      },
      required: ["account", "id"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const mailboxHint = args.mailbox as string | undefined;

      if (!id) return errorResult("Error: id is required.");

      assertAllowed(env, mailboxHint);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        mailboxHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      const email = await fetchEmailContent(imapClient, uid, mailbox);
      if (!email)
        return errorResult(`No email found for id "${id}".`);

      return jsonResult(email);
    },
  },

  {
    name: "list_folders",
    description:
      "List all folders in the email account. " +
      "Returns an array of {path, name, delimiter} objects. " +
      "Use the path value when specifying a folder in other tools.",
    inputSchema: {
      type: "object",
      properties: { ...ACCOUNT_SCHEMA },
      required: ["account"],
    },
    handler: async (imapClient, _args, env) => {
      const folders = await listFolders(imapClient);
      return jsonResult({ count: folders.length, folders });
    },
  },

  {
    name: "create_folder",
    description:
      "Create a new folder. Use a path with the server's delimiter for subfolders " +
      '(e.g. "INBOX/Receipts" or "Projects/2024"). ' +
      "Use list_folders first to discover the delimiter if unsure.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        path: {
          type: "string",
          description:
            'Full path of the folder to create (e.g. "INBOX/Receipts").',
        },
      },
      required: ["account", "path"],
    },
    handler: async (imapClient, args, env) => {
      const path = args.path as string;
      if (!path) return errorResult("Error: path is required.");

      assertAllowed(env, path);
      const created = await createFolder(imapClient, path);
      return jsonResult({ created });
    },
  },

  {
    name: "move_email",
    description:
      "Move an email from one folder to another. " +
      "Requires the email's id (from list_emails_* or fetch_email_content) " +
      "and the destination folder to move it to. " +
      "Returns {id, destination}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier.",
        },
        source_folder: {
          type: "string",
          description:
            "Optional folder hint for faster lookup. If omitted, searches all folders.",
        },
        destination_folder: {
          type: "string",
          description: "Folder to move the email to.",
        },
      },
      required: ["account", "id", "destination_folder"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const sourceHint = args.source_folder as string | undefined;
      const destinationFolder = args.destination_folder as string;

      if (!id || !destinationFolder)
        return errorResult(
          "Error: id and destination_folder are required."
        );

      assertAllowed(env, sourceHint, destinationFolder);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        sourceHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      assertAllowed(env, destinationFolder);
      const result = await moveEmail(
        imapClient,
        uid,
        mailbox,
        destinationFolder
      );
      return jsonResult({ id, destination: result.destination });
    },
  },


  {
    name: "star_email",
    description:
      "Add a star (flag) to an email. " +
      "Requires the email's id (from list_emails_* or fetch_email_content). " +
      "Returns {id, starred: true}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier to star.",
        },
        ...MAILBOX_HINT_SCHEMA,
      },
      required: ["account", "id"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const mailboxHint = args.mailbox as string | undefined;

      if (!id) return errorResult("Error: id is required.");

      assertAllowed(env, mailboxHint);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        mailboxHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      await starEmail(imapClient, uid, mailbox);
      return jsonResult({ id, starred: true });
    },
  },

  {
    name: "unstar_email",
    description:
      "Remove the star (flag) from an email. " +
      "Requires the email's id (from list_emails_* or fetch_email_content). " +
      "Returns {id, starred: false}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier to unstar.",
        },
        ...MAILBOX_HINT_SCHEMA,
      },
      required: ["account", "id"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const mailboxHint = args.mailbox as string | undefined;

      if (!id) return errorResult("Error: id is required.");

      assertAllowed(env, mailboxHint);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        mailboxHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      await unstarEmail(imapClient, uid, mailbox);
      return jsonResult({ id, starred: false });
    },
  },

  {
    name: "mark_read",
    description:
      "Mark an email as read (adds the \\Seen flag). " +
      "Requires the email's id (from list_emails_* or fetch_email_content). " +
      "Returns {id, read: true}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier to mark as read.",
        },
        ...MAILBOX_HINT_SCHEMA,
      },
      required: ["account", "id"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const mailboxHint = args.mailbox as string | undefined;

      if (!id) return errorResult("Error: id is required.");

      assertAllowed(env, mailboxHint);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        mailboxHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      await markRead(imapClient, uid, mailbox);
      return jsonResult({ id, read: true });
    },
  },

  {
    name: "mark_unread",
    description:
      "Mark an email as unread (removes the \\Seen flag). " +
      "Requires the email's id (from list_emails_* or fetch_email_content). " +
      "Returns {id, read: false}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        id: {
          type: "string",
          description: "The email identifier to mark as unread.",
        },
        ...MAILBOX_HINT_SCHEMA,
      },
      required: ["account", "id"],
    },
    handler: async (imapClient, args, env) => {
      const id = args.id as string;
      const mailboxHint = args.mailbox as string | undefined;

      if (!id) return errorResult("Error: id is required.");

      assertAllowed(env, mailboxHint);
      const { uid, mailbox } = await resolveEmailId(
        imapClient,
        id,
        mailboxHint,
        env.blockedFolders
      );
      assertAllowed(env, mailbox);
      await markUnread(imapClient, uid, mailbox);
      return jsonResult({ id, read: false });
    },
  },

  {
    name: "list_starred_emails",
    description:
      "List all starred (flagged) emails across all folders, grouped by folder. " +
      LIST_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { ...ACCOUNT_SCHEMA },
      required: ["account"],
    },
    handler: async (imapClient, _args, env) => {
      const groups = await listAllStarredEmails(imapClient, env.blockedFolders);
      const totalCount = groups.reduce((sum, g) => sum + g.count, 0);
      return jsonResult({ totalCount, folders: groups });
    },
  },

  {
    name: "list_emails_by_color",
    description:
      "List emails that have an Apple Mail color flag (red, orange, yellow, green, blue, purple, grey). " +
      "Optionally filter by a specific color. Returns emails grouped by folder; each email object includes " +
      "{id, subject, from, date, color} sorted newest-first. " +
      "The id is a globally unique identifier — use it with fetch_email_content to read the full email.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        color: {
          type: "string",
          enum: ["red", "orange", "yellow", "green", "blue", "purple", "grey"],
          description: "Filter to emails with this color flag. Omit to return all color-flagged emails.",
        },
      },
      required: ["account"],
    },
    handler: async (imapClient, args, env) => {
      const color = args.color as string | undefined;
      const groups = await listAllEmailsByColor(imapClient, color, env.blockedFolders);
      const totalCount = groups.reduce((sum, g) => sum + g.count, 0);
      return jsonResult({ totalCount, folders: groups });
    },
  },

  {
    name: "bulk_move_by_sender_email",
    description:
      "Move all emails from a specific sender email address in a source folder to a destination folder. " +
      "Returns {moved, source_folder, destination_folder, sender}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        sender: {
          type: "string",
          description:
            'The sender email address to match (e.g. "alice@example.com").',
        },
        source_folder: {
          type: "string",
          description: "Folder to search for matching emails.",
        },
        destination_folder: {
          type: "string",
          description: "Folder to move matching emails to.",
        },
      },
      required: ["account", "sender", "source_folder", "destination_folder"],
    },
    handler: async (imapClient, args, env) => {
      const sender = args.sender as string;
      const sourceFolder = args.source_folder as string;
      const destinationFolder = args.destination_folder as string;

      if (!sender || !sourceFolder || !destinationFolder)
        return errorResult(
          "Error: sender, source_folder, and destination_folder are required."
        );

      assertAllowed(env, sourceFolder, destinationFolder);
      if (!(await folderExists(imapClient, sourceFolder)))
        return errorResult(`Source folder not found: "${sourceFolder}".`);
      if (!(await folderExists(imapClient, destinationFolder)))
        return errorResult(
          `Destination folder not found: "${destinationFolder}".`
        );

      const moved = await bulkMoveBySender(
        imapClient,
        sourceFolder,
        destinationFolder,
        sender
      );

      if (moved === 0)
        return errorResult(
          `No emails from "${sender}" found in "${sourceFolder}".`
        );

      return jsonResult({
        moved,
        source_folder: sourceFolder,
        destination_folder: destinationFolder,
        sender,
      });
    },
  },

  {
    name: "bulk_move_by_sender_domain",
    description:
      "Move all emails from a specific sender domain in a source folder to a destination folder. " +
      "Returns {moved, source_folder, destination_folder, domain}.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_SCHEMA,
        domain: {
          type: "string",
          description:
            'The sender domain to match (e.g. "example.com"). Do not include the @ sign.',
        },
        source_folder: {
          type: "string",
          description: "Folder to search for matching emails.",
        },
        destination_folder: {
          type: "string",
          description: "Folder to move matching emails to.",
        },
      },
      required: ["account", "domain", "source_folder", "destination_folder"],
    },
    handler: async (imapClient, args, env) => {
      const domain = args.domain as string;
      const sourceFolder = args.source_folder as string;
      const destinationFolder = args.destination_folder as string;

      if (!domain || !sourceFolder || !destinationFolder)
        return errorResult(
          "Error: domain, source_folder, and destination_folder are required."
        );

      assertAllowed(env, sourceFolder, destinationFolder);
      if (!(await folderExists(imapClient, sourceFolder)))
        return errorResult(`Source folder not found: "${sourceFolder}".`);
      if (!(await folderExists(imapClient, destinationFolder)))
        return errorResult(
          `Destination folder not found: "${destinationFolder}".`
        );

      const moved = await bulkMoveBySender(
        imapClient,
        sourceFolder,
        destinationFolder,
        "@" + domain
      );

      if (moved === 0)
        return errorResult(
          `No emails from "@${domain}" found in "${sourceFolder}".`
        );

      return jsonResult({
        moved,
        source_folder: sourceFolder,
        destination_folder: destinationFolder,
        domain,
      });
    },
  },



];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Tool schemas for MCP ListTools response. */
export const tools = [
  {
    name: "list_accounts",
    description:
      "List the configured mail accounts. Returns {accounts: [{id, user}]}. " +
      "Use the id as the required `account` parameter of all other tools.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  ...registry.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
];

/** Map-based dispatch — open for extension, closed for modification. */
const handlerMap = new Map(
  registry.map((t) => [t.name, t.handler])
);

// Tool calls run strictly one after another so that no two IMAP logins
// (or accounts) are ever active in parallel.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function handleToolCall(
  env: ToolEnvironment,
  name: string,
  args: Record<string, unknown>
) {
  if (name === "list_accounts") {
    return jsonResult({ accounts: env.listAccounts() });
  }
  const handler = handlerMap.get(name);
  if (!handler)
    return errorResult(`Unknown tool: ${name}`);

  const account = args.account;
  if (typeof account !== "string" || !account)
    return errorResult("Error: account is required (see list_accounts).");
  if (!env.hasAccount(account))
    return errorResult(`Error: unknown account "${account}" (see list_accounts).`);

  return serialize(async () => {
    try {
      const imapClient = await env.getClient(account);
      return await handler(imapClient, args, env);
    } catch (err) {
      if (err instanceof BlockedFolderError) return errorResult(BLOCKED_MESSAGE);
      throw err;
    }
  });
}
