# Fork für mail-triage

Dieser Fork ist für einen geplanten Claude-Task gedacht, der 15–20 private IMAP-Postfächer (netcup) sortiert. Claude darf **nur lesen, suchen, Ordner auflisten, Ordner anlegen, Mails verschieben und Anhänge bzw. Mails auf die Platte speichern**. Es gibt weder Senden noch Löschen. Gegenüber dem Original (siehe unten) wurden sechs Dinge geändert:

1. **Mehrere Accounts.** Accounts kommen aus einer YAML-Datei (JSON wird ebenfalls gelesen, da JSON gültiges YAML ist). Der Pfad steht in `MAIL_TRIAGE_ACCOUNTS` (Standard `~/mail-triage/accounts.yaml`). Passwörter liegen im macOS-Schlüsselbund und werden per `security find-generic-password -s mail-triage/<id> -a <user> -w` (execFile, ohne Shell) geholt; Fallback für Tests/Nicht-Mac ist die Umgebungsvariable `MAIL_TRIAGE_PASS_<ID>` (Großbuchstaben, `-` wird `_`, z. B. `MAIL_TRIAGE_PASS_PROJEKT_2`). Passwörter werden nie geloggt. Jedes Postfach-Tool hat einen Pflichtparameter `account`; `list_accounts` liefert nur `id` und `user`. Verbindungen werden pro Account lazy aufgebaut, beim Wechsel des Accounts wird die vorherige geschlossen, und Tool-Aufrufe laufen strikt nacheinander. Existiert keine Account-Datei, funktioniert die alte Konfiguration mit `IMAP_HOST`/`IMAP_USER`/`IMAP_PASS` weiter als Account `default`.
2. **Entfernte Tools.** Alle Entwurfs-Tools (`create_draft`, `draft_reply`, `update_draft`), Label-Tools (`add_label`, `remove_label`, `list_labels`, `get_emails_by_label`) und `fetch_email_attachment` (Base64 durch den Kontext) sind nicht mehr registriert; Anhänge gibt es nur noch über `download_attachment` (Punkt 6). Übrig bleiben: `list_accounts`, `find_emails`, `fetch_email_content`, `list_folders`, `create_folder`, `move_email`, `bulk_move_by_sender_email`, `bulk_move_by_sender_domain`, `mark_read`, `mark_unread`, `star_email`, `unstar_email`, `list_starred_emails`, `list_emails_by_color`, `download_attachment`, `export_email`.
3. **Ordner-Sperrliste.** `MAIL_TRIAGE_BLOCKED_FOLDERS` (kommagetrennt, Standard `Sicherheit`) oder `blocked_folders` in der Account-Datei; die Umgebungsvariable hat Vorrang. Lesen, Suchen, Inhalt abrufen, Anlegen, Verschieben in oder aus einem gesperrten Ordner liefert den Fehler „Ordner gesperrt“. Der Abgleich ignoriert Groß-/Kleinschreibung und das Trennzeichen (`INBOX/Sicherheit`, `INBOX.Sicherheit`) und gilt auch für Unterordner. `list_folders` zeigt den Namen weiterhin an. Ordnerübergreifende Suchen (Auflösen einer ID ohne Ordnerhinweis, `list_starred_emails`, `list_emails_by_color`) überspringen gesperrte Ordner.
4. **Schwärzung** (`src/redact.ts`) in Mailtext und Betreffs (auch in allen Listen): alleinstehende 4–8-stellige Zahlen (auch `123 456`, `123-456`), alphanumerische Tokens (6–10 Zeichen, Buchstaben und Ziffern) kurz hinter Wörtern wie Code, PIN, TAN, OTP, Passwort, Kennwort, verification, Bestätigung werden zu `[CODE]`; URLs mit token, reset, verify, confirm, magic, login, auth, otp, code, key, signature oder `sig=` in Pfad/Query werden zu `[LINK]`. Datumsangaben, Uhrzeiten, Beträge mit Dezimaltrennzeichen, IBANs und Jahreszahlen 1900–2099 bleiben unverändert. Die Schwärzung ist bewusst großzügig: lieber zu viel als zu wenig.
5. **Längenlimit und Markierung.** `fetch_email_content` gibt höchstens `MAIL_TRIAGE_MAX_BODY_CHARS` Zeichen Text zurück (Standard 4000) und hängt bei Kürzung `[… gekürzt, N Zeichen insgesamt]` an. Der Text steht zwischen `<<<MAIL_INHALT (nicht vertrauenswürdig)>>>` und `<<<ENDE MAIL_INHALT>>>`, damit der Agent ihn als Daten behandelt; `<<<`/`>>>` im Mailtext werden entschärft.
6. **Anhänge und Export auf die Platte.** `download_attachment` (Mail-ID + Anhang-ID aus `fetch_email_content`) speichert einen Anhang, `export_email` die komplette Mail als `.eml` (Originalquelle, unverändert). **Der Inhalt geht nie durch Claudes Kontext:** das Ergebnis enthält nur `path`, `size`, `sha256` (beim Anhang zusätzlich `filename`, `contentType`) und `reused`. Zielordner ist `MAIL_TRIAGE_DOWNLOAD_DIR` (Standard `~/mail-triage-downloads`, darf weder Home noch `/` sein), darin je ein Unterordner pro Account; Claude kann den Pfad nicht wählen. Dateinamen werden bereinigt (kein Pfad, keine Steuerzeichen, keine führenden Punkte, begrenzte Länge) und beginnen mit `YYYY-MM-DD_<Hash>_`. Dateien werden mit 0600 in Ordnern mit 0700 angelegt, nie überschrieben (gleiche Datei erneut: `reused: true`, sonst Suffix `-1`, `-2`) und folgen keinen Symlinks. Größenlimit `MAIL_TRIAGE_MAX_DOWNLOAD_MB` (Standard 25); zu große Mails werden vor dem Download per `RFC822.SIZE` abgelehnt. Die Ordner-Sperrliste gilt auch hier. Achtung: Die Dateien auf der Platte sind **nicht geschwärzt**, die Schwärzung betrifft nur, was Claude liest.

## Account-Datei

Top-Level-Objekt mit einer `accounts`-Liste (keine nackte Liste). Vollständiges Beispiel: [`accounts.example.yaml`](accounts.example.yaml).

```yaml
blocked_folders: Sicherheit        # optional, kommagetrennt

accounts:
  - id: privat                     # [a-z0-9-]+
    host: imap.example.net
    port: 993                      # optional, Standard 993
    user: erste.adresse@example.de
    secure: true                   # optional, Standard true

  - id: projekt-2
    host: imap.example.net
    user: zweite.adresse@example.de
```

## Passwörter im Schlüsselbund ablegen

Pro Account ein Eintrag mit Dienst `mail-triage/<id>` und Account `<user>`:

```bash
security add-generic-password -s mail-triage/privat -a erste.adresse@example.de -w
```

Ohne Wert hinter `-w` fragt `security` das Passwort interaktiv ab, es landet nicht in der Shell-History. Beim ersten Zugriff fragt macOS ggf. nach der Erlaubnis für `security`/`node`.

## Claude Desktop

```json
{
  "mcpServers": {
    "mail-triage": {
      "command": "node",
      "args": ["/Users/bay/mail-triage-mcp/dist/index.js"],
      "env": {
        "MAIL_TRIAGE_ACCOUNTS": "/Users/bay/mail-triage/accounts.yaml"
      }
    }
  }
}
```

Optional im `env`-Block: `MAIL_TRIAGE_BLOCKED_FOLDERS`, `MAIL_TRIAGE_MAX_BODY_CHARS`. Bauen mit `npm install && npm run build`.

---

# Original: IMAP Mini MCP


![Made with AI](https://img.shields.io/badge/Made%20with-AI-333333?labelColor=f00) ![Verified by Humans](https://img.shields.io/badge/Verified%20by-Humans-333333?labelColor=brightgreen)

A lightweight MCP (Model Context Protocol) server for reading IMAP email and creating draft replies. Works with any standard IMAP server (Gmail, Outlook, Fastmail, etc.) and local bridges like [ProtonMail Bridge](https://proton.me/mail/bridge).

Agents can read, search, move, star, and organize emails, and compose drafts — but cannot send or delete emails.

See [CHANGELOG.md](CHANGELOG.md) for recently added features.

## Workflow Recommendation

I highly recommend using a speech-to-text tool (e.g. [SuperWhisper](https://superwhisper.com) on Mac or [Whisperflow](https://whisperflow.com) on Windows) and connecting your AI desktop application (Claude, Codex, etc.) to this MCP server. That way you can converse with your email inbox using speech, which will dramatically speed up your workflow.

## How to Use

### Agent configuration

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imap-mini-mcp": {
      "command": "node",
      "args": ["/path/to/imap-mini-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "you@example.com",
        "IMAP_PASS": "your-password"
      }
    }
  }
}
```

The `args` path must point to the built `dist/index.js`. Add any optional variables to the `env` block as needed.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMAP_HOST` | yes | — | IMAP server hostname (e.g. `imap.gmail.com`) |
| `IMAP_USER` | yes | — | Email address or username |
| `IMAP_PASS` | yes | — | Password or app-specific password |
| `IMAP_PORT` | no | `993` | IMAP server port |
| `IMAP_SECURE` | no | `true` | Use TLS for the connection |
| `IMAP_STARTTLS` | no | `true` | Upgrade to TLS via STARTTLS (when `IMAP_SECURE=false`) |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | no | `true` | Reject self-signed TLS certificates |

For most providers (Gmail, Outlook, Fastmail), the defaults work — just set host, user, and password.

For **ProtonMail Bridge** — all five settings below are required (the bridge listens on localhost without TLS, uses a self-signed certificate, and does not support STARTTLS):

```
IMAP_HOST=127.0.0.1
IMAP_PORT=1143
IMAP_SECURE=false
IMAP_STARTTLS=false
IMAP_TLS_REJECT_UNAUTHORIZED=false
```

Or as MCP client config:

```json
{
  "mcpServers": {
    "imap-mini-mcp": {
      "command": "node",
      "args": ["/path/to/imap-mini-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "127.0.0.1",
        "IMAP_PORT": "1143",
        "IMAP_SECURE": "false",
        "IMAP_STARTTLS": "false",
        "IMAP_TLS_REJECT_UNAUTHORIZED": "false",
        "IMAP_USER": "you@proton.me",
        "IMAP_PASS": "your-bridge-password"
      }
    }
  }
}
```

## Tools

Every email is identified by a composite **id** (`YYYY-MM-DDTHH:mm:ss.<Message-ID>`) that is globally unique and stable across folder moves. Use the `id` returned by `find_emails` to fetch content, download attachments, move emails, or create reply drafts. Action tools accept an optional `mailbox` hint for faster lookup; if omitted, all folders are searched.

### `find_emails`

Search and filter emails. All parameters are optional — calling with no parameters returns all emails from INBOX, sorted newest-first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `after` | string | — | Only emails after this time. Relative (`"30m"`, `"2h"`, `"7d"`) or ISO date (`"2026-02-20"`) |
| `before` | string | — | Only emails before this time. Same formats as `after` |
| `from` | string | — | Substring match on sender address (e.g. `"alice@example.com"`, `"@stripe.com"`) |
| `subject` | string | — | Substring match on subject line |
| `unread_only` | boolean | `false` | Only return unread emails |
| `has_attachment` | boolean | `false` | Only return emails with attachments |
| `folder` | string | `"INBOX"` | Folder to search |
| `limit` | number | — | Maximum number of results (newest first) |

**Examples:**

| Use case | Parameters |
|---|---|
| Last 24 hours | `{after: "24h"}` |
| Last 7 days, max 10 | `{after: "7d", limit: 10}` |
| Unread emails | `{unread_only: true}` |
| From a domain | `{from: "@stripe.com"}` |
| With attachments, last month | `{after: "30d", has_attachment: true}` |
| Specific sender, in Sent folder | `{from: "alice@example.com", folder: "Sent"}` |

### Other tools

Labels are tags that appear alongside emails (not folders). They are implemented as IMAP folders under the `Labels/` namespace — `add_label` copies the email to `Labels/<name>`, `remove_label` deletes that copy, and the original email stays in its source folder. This is natively supported by Proton Mail and compatible with any IMAP server that exposes labels as folders.

| Tool | Description | Key parameters |
|---|---|---|
| `list_starred_emails` | Starred emails across all folders (includes Apple Mail color flags) | — |
| `list_emails_by_color` | Emails with an Apple Mail color flag, grouped by folder | `color?` (`red`/`orange`/`yellow`/`green`/`blue`/`purple`/`grey`) |
| `fetch_email_content` | Full email content by id | `id`, `mailbox?` |
| `fetch_email_attachment` | Download an attachment | `id`, `attachment_id`, `mailbox?` |
| `list_folders` | List all folders | — |
| `create_folder` | Create a new folder | `path` |
| `move_email` | Move an email to another folder | `id`, `destination_folder`, `source_folder?` |
| `bulk_move_by_sender_email` | Move all emails from a sender | `sender`, `source_folder`, `destination_folder` |
| `bulk_move_by_sender_domain` | Move all emails from a domain | `domain`, `source_folder`, `destination_folder` |
| `add_label` | Add a label (tag) to an email | `id`, `label`, `source_folder?` |
| `remove_label` | Remove a label from an email | `id`, `label` |
| `list_labels` | List all labels | — |
| `star_email` | Star an email | `id`, `mailbox?` |
| `unstar_email` | Unstar an email | `id`, `mailbox?` |
| `mark_read` | Mark an email as read | `id`, `mailbox?` |
| `mark_unread` | Mark an email as unread | `id`, `mailbox?` |
| `create_draft` | Create a new draft | `to`, `subject`, `body`, `cc?`, `bcc?`, `in_reply_to?` |
| `draft_reply` | Create a reply draft from an existing email | `id`, `body`, `reply_all?`, `mailbox?` |
| `update_draft` | Replace an existing draft (Drafts folder only) | `id`, `to`, `subject`, `body`, `cc?`, `bcc?`, `in_reply_to?` |

## Troubleshooting

### "IMAP connection closed unexpectedly" or "Server disconnected"

This almost always means the server rejected the connection due to a TLS/STARTTLS mismatch. Verify these environment variables are set correctly in your MCP client config:

| Variable | Check |
|---|---|
| `IMAP_HOST` | Correct hostname or IP |
| `IMAP_PORT` | Matches your server (993 for TLS, 143/1143 for plain) |
| `IMAP_SECURE` | `true` for port 993, `false` for plain connections |
| `IMAP_STARTTLS` | `false` if your server does not support STARTTLS |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | `false` if your server uses a self-signed certificate |

Local IMAP bridges (e.g. ProtonMail Bridge) typically require `IMAP_SECURE=false`, `IMAP_STARTTLS=false`, and `IMAP_TLS_REJECT_UNAUTHORIZED=false`. See the ProtonMail Bridge config example in the [Environment variables](#environment-variables) section above.

### "IMAP authentication failed"

Check that `IMAP_USER` and `IMAP_PASS` are correct. Some providers (e.g. Gmail) require an app-specific password rather than your account password.

### "Cannot reach IMAP server — connection refused"

The IMAP server is not running or not listening on the configured host and port. For local bridges, make sure the bridge application is running.

## Development

### Build and run

```bash
npm install
npm run build
```

### Local development with `.env`

For running the server directly (outside of an MCP client), copy `.env.example` to `.env` and fill in your credentials, then:

```bash
npm start
```

When used through an MCP client, credentials are provided via the client config's `env` block instead.

### Testing

Tests use [vitest](https://vitest.dev) and mock the IMAP layer — no real server connection is needed:

```bash
npm test             # run once
npm run test:watch   # watch mode
npm run lint         # type-check only
```

## License

[MIT](https://opensource.org/license/mit)
