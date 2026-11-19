/**
 * Folder names that count as junk (Trash/Spam) when searching or indexing all
 * folders. Matching is case-insensitive and works on every path segment, so
 * subfolders of a trash folder ("Gelöschte Elemente/Archiv") count as junk too.
 * Includes the German and English names used by common providers and Exchange.
 */
const JUNK_FOLDER_NAMES = new Set([
  "trash",
  "spam",
  "junk",
  "papierkorb",
  "junk-e-mail",
  "gelöschte elemente",
  "deleted items",
  "deleted messages",
]);

export function isJunkFolder(path: string): boolean {
  return path
    .normalize("NFC")
    .toLowerCase()
    .split(/[/.\\]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((segment) => JUNK_FOLDER_NAMES.has(segment));
}
