import { createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Helpers for writing attachments and raw emails to a fixed download folder.
 *
 * The agent never chooses the target path: it only gets back the path that
 * this module picked. File names are sanitised, the resolved path must stay
 * inside the download folder, and existing files are never overwritten.
 */

export const DEFAULT_DOWNLOAD_DIR = "~/mail-triage-downloads";
export const DEFAULT_MAX_DOWNLOAD_MB = 25;

const MAX_NAME_LENGTH = 100;

/**
 * Reduce an arbitrary (attacker-controlled) file name to a safe base name:
 * no directories, no control characters, no leading dots, bounded length.
 * The extension is kept (lower-cased) so the file stays openable.
 */
export function sanitizeFilename(name: string, fallback = "datei"): string {
  const base = name
    .normalize("NFC")
    // take only the last path component, for both / and \
    .split(/[/\\]/)
    .pop()!
    // control chars, reserved characters on Windows/macOS, and NUL
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // no hidden files, no names that are only dots
    .replace(/^\.+/, "")
    .replace(/[ .]+$/, "");

  if (!base) return fallback;

  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (ext.length > 12) {
    // not a real extension: treat as part of the stem
    stem = base;
    ext = "";
  }
  if (stem.length > MAX_NAME_LENGTH) stem = stem.slice(0, MAX_NAME_LENGTH);
  return `${stem.trim() || fallback}${ext}`;
}

/** Make an arbitrary text (e.g. a subject) usable as the stem of a file name. */
export function slugify(text: string, fallback = "mail"): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Short stable hash, used to keep names unique and downloads idempotent. */
export function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 8);
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface WriteResult {
  /** Absolute path of the file. */
  path: string;
  /** True if an identical file (same size) already existed and was reused. */
  reused: boolean;
}

/**
 * Write `content` to `<baseDir>/<subdir>/<fileName>`.
 *
 * - `subdir` and `fileName` are re-sanitised here; the final path is verified
 *   to be inside `baseDir`.
 * - Directories are created with mode 0700, files with 0600.
 * - Existing files are never overwritten. If a file with the same name and
 *   size exists, it is reused (the name contains a hash of the mail id, so
 *   this means "same download again"). If the size differs, a numeric suffix
 *   is appended.
 */
export async function writeDownload(
  baseDir: string,
  subdir: string,
  fileName: string,
  content: Buffer
): Promise<WriteResult> {
  const root = path.resolve(baseDir);
  const dir = path.resolve(root, sanitizeFilename(subdir, "konto"));
  const safeName = sanitizeFilename(fileName);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);

  for (let n = 0; n < 100; n++) {
    const candidate = path.resolve(dir, n === 0 ? safeName : `${stem}-${n}${ext}`);
    if (!candidate.startsWith(dir + path.sep) || !candidate.startsWith(root + path.sep)) {
      throw new Error("Zielpfad liegt außerhalb des Download-Ordners.");
    }
    try {
      const handle = await open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return { path: candidate, reused: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = await stat(candidate);
      if (existing.isFile() && existing.size === content.length) {
        return { path: candidate, reused: true };
      }
    }
  }
  throw new Error("Zu viele gleichnamige Dateien im Download-Ordner.");
}
