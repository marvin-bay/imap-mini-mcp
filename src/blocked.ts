/** Error message returned for any access to a blocked folder. */
export const BLOCKED_MESSAGE = "Ordner gesperrt";

function segments(p: string): string[] {
  return p
    .normalize("NFC")
    .toLowerCase()
    .split(/[/.\\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True if the folder path is on the denylist. Matching is case-insensitive and
 * independent of the hierarchy delimiter ("/" or "."): a path is blocked when
 * the blocked name (itself possibly a multi-segment path) appears as a run of
 * path segments, so "Sicherheit" blocks "INBOX/Sicherheit", "INBOX.Sicherheit"
 * and also subfolders such as "INBOX/Sicherheit/Alt".
 */
export function isBlockedFolder(path: string, blocked: readonly string[]): boolean {
  const p = segments(path);
  if (p.length === 0) return false;
  for (const entry of blocked) {
    const b = segments(entry);
    if (b.length === 0 || b.length > p.length) continue;
    for (let i = 0; i + b.length <= p.length; i++) {
      if (b.every((seg, j) => p[i + j] === seg)) return true;
    }
  }
  return false;
}
