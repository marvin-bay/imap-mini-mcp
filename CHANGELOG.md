# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This repository does not currently use release tags, so entries are grouped by date and major update scope.

## 2026-11-16

### Added
- `find_emails`: `folder: "*"` searches all folders of the account. Blocked folders are never opened, Trash/Spam/Junk are skipped unless `include_junk: true`. Every hit carries its `folder`; the result also reports `searched_folders` (and `skipped_folders` for folders that could not be opened). The limit applies to the merged, date-sorted result.
- `src/tools/find-all-folders.test.ts`

### Changed
- `find_emails` description now states that only one folder (default INBOX) is searched unless `folder: "*"` is given. Reason: mails are sorted out of INBOX quickly, so INBOX-only searches missed almost everything older than a few hours.

## 2026-11-20

### Added
- `export_index` tool — writes a CSV index (header data only) of one folder, a folder tree or all folders to `MAIL_TRIAGE_INDEX_DIR`; result holds only counts (`server_count` vs `rows`) and the path

### Changed
- Junk detection for `folder: "*"` checks every path segment and knows `Junk-E-Mail`, `Gelöschte Elemente`, `Deleted Items`; subfolders of a trash folder count as junk

## 2026-11-19

### Added
- `MAIL_TRIAGE_READONLY=true` — read-only instance: mutating tools are neither listed nor accepted, and all mailboxes are opened with IMAP EXAMINE

## 2026-11-11

### Added
- `download_attachment` tool — saves one attachment to a fixed download folder and returns only path, size and SHA-256 (no content in the tool result)
- `export_email` tool — saves the complete, unmodified message as `.eml`
- `MAIL_TRIAGE_DOWNLOAD_DIR` (default `~/mail-triage-downloads`) and `MAIL_TRIAGE_MAX_DOWNLOAD_MB` (default 25)
- `src/download.ts` — file name sanitising, path confinement, no overwrite, 0600/0700 permissions

## 2026-08-16

### Fixed
- `fetch_email_content` returned "(no text body)" for emails without a `text/plain` part — the HTML part is now converted to plain text

## 2026-08-07

### Added
- `add_label` tool — add a label (tag) to an email via IMAP COPY to `Labels/<name>`
- `remove_label` tool — remove a label from an email via IMAP DELETE in `Labels/<name>`
- `list_labels` tool — list all labels (folders under the `Labels/` namespace)
- Unit tests for `addLabel`, `removeLabel`, `listLabels` in `src/imap/folders.test.ts`
- Tool handler tests for `add_label`, `remove_label`, `list_labels` in `src/tools/index.test.ts`

## 2026-03-01

### Added
- `list_emails_by_color` tool — list emails that have an Apple Mail color flag, optionally filtered by color (`red`, `orange`, `yellow`, `green`, `blue`, `purple`, `grey`). Returns emails with their `color` field, grouped by folder.

### Changed
- `list_starred_emails` now returns emails flagged via Apple Mail `$MailFlagBit*` keywords, even when `\Flagged` is not set
- `unstar_email` now also removes `$MailFlagBit*` keywords in addition to `\Flagged` (best-effort)

## 2026-02-23

### Changed
- Replaced 12 email listing tools with a single `find_emails` tool
  - Supports date range (`after`, `before`) with relative time ("2h", "7d") and ISO dates
  - Supports sender (`from`) and subject (`subject`) substring filtering
  - Supports `unread_only` and `has_attachment` boolean filters
  - Supports `folder` (default "INBOX") and `limit` for result count

### Removed
- `list_emails_24h`, `list_emails_7days`, `list_emails_month`, `list_emails_quarter`, `list_emails_year`, `list_emails_all`
- `list_emails_n_hours`, `list_emails_n_minutes`
- `list_inbox_messages`, `list_n_recent_emails`
- `list_emails_from_domain`, `list_emails_from_sender`

## 2026-02-14

### Added
- `list_emails_n_hours` tool — list emails from the last N hours
- `list_emails_n_minutes` tool — list emails from the last N minutes
- `list_n_recent_emails` tool — list the N most recent emails from the inbox
- `hoursAgo()` and `minutesAgo()` helper functions for flexible time-based queries

## 2026-02-13

### Added
- `list_inbox_messages` tool — list the most recent N messages in the inbox
- `mark_read` and `mark_unread` tools — toggle the read/unread flag on emails
- `bulk_move_by_sender_email` tool — move all emails from a sender address
- `bulk_move_by_sender_domain` tool — move all emails from a sender domain
- Connection error handling with structured stderr logging
- Mailbox lock retry logic for transient IMAP failures
- Integration test that exercises tools against a real IMAP server

### Fixed
- Server no longer crashes on unexpected IMAP errors (graceful error propagation)

## 2026-02-12

### Added
- Initial IMAP MCP server with stdio transport
- Email listing tools: `list_emails_24h`, `list_emails_7days`, `list_emails_month`, `list_emails_quarter`, `list_emails_year`, `list_emails_all`
- `list_emails_from_domain` and `list_emails_from_sender` tools
- `list_starred_emails` tool — starred emails across all folders, grouped by folder
- `fetch_email_content` and `fetch_email_attachment` tools
- `list_folders` and `create_folder` tools
- `move_email` tool
- `star_email` and `unstar_email` tools
- `create_draft`, `draft_reply`, and `update_draft` tools
- Globally unique composite email identifiers (`YYYY-MM-DDTHH:mm:ss.<Message-ID>`)
- Configurable TLS, STARTTLS, and certificate validation via environment variables
- ProtonMail Bridge support (non-TLS localhost connections)
- README with setup instructions, tool reference, and troubleshooting guide
