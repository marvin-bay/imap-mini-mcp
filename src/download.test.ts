import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeFilename, slugify, shortHash, sha256, writeDownload } from "./download.js";

describe("sanitizeFilename", () => {
  it("keeps normal names and lower-cases the extension", () => {
    expect(sanitizeFilename("Rechnung 2026.PDF")).toBe("Rechnung 2026.pdf");
    expect(sanitizeFilename("müller_äöü.docx")).toBe("müller_äöü.docx");
  });

  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\evil.exe", "evil.exe"],
    ["/abs/path/file.txt", "file.txt"],
    [".htaccess", "htaccess"],
    ["...", "datei"],
    ["", "datei"],
    ["a\u0000b\nc.txt", "a_b_c.txt"],
    ['we<ir>d:"na|me?*.txt', "we_ir_d__na_me__.txt"],
    ["trailing dots...", "trailing dots"],
  ])("neutralises %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("never contains path separators or leading dots", () => {
    for (const evil of ["a/b", "a\\b", "./x", "../x", ".../x", "%2e%2e/x"]) {
      const out = sanitizeFilename(evil);
      expect(out).not.toMatch(/[/\\]/);
      expect(out.startsWith(".")).toBe(false);
    }
  });

  it("bounds the length but keeps the extension", () => {
    const out = sanitizeFilename("x".repeat(500) + ".pdf");
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(104);
  });

  it("treats an overlong 'extension' as part of the name", () => {
    expect(sanitizeFilename("archive.thisisnotanextension")).toBe("archive.thisisnotanextension");
  });

  it("uses the fallback", () => {
    expect(sanitizeFilename("///", "konto")).toBe("konto");
  });
});

describe("slugify / hashes", () => {
  it("slugifies subjects", () => {
    expect(slugify("Ihre Rechnung Nr. 12/2026 – Müller & Söhne")).toBe("Ihre-Rechnung-Nr-12-2026-Muller-Sohne");
    expect(slugify("!!!")).toBe("mail");
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("hashes are stable and short", () => {
    expect(shortHash("a", "b")).toBe(shortHash("a", "b"));
    expect(shortHash("a", "b")).not.toBe(shortHash("ab"));
    expect(shortHash("x")).toMatch(/^[0-9a-f]{8}$/);
    expect(sha256(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("writeDownload", () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "dl-test-"));

  it("writes with restrictive permissions inside <base>/<subdir>", async () => {
    const base = tmp();
    const r = await writeDownload(base, "privat", "a.txt", Buffer.from("hi"));
    expect(r.path).toBe(path.join(base, "privat", "a.txt"));
    expect(readFileSync(r.path, "utf8")).toBe("hi");
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(r.path)).mode & 0o777).toBe(0o700);
  });

  it("re-sanitises subdir and file name so the path cannot escape", async () => {
    const base = tmp();
    const r = await writeDownload(base, "../outside", "../../x.txt", Buffer.from("x"));
    expect(r.path.startsWith(base + path.sep)).toBe(true);
    expect(path.relative(base, r.path).split(path.sep)).toHaveLength(2);
  });

  it("reuses an identical file and never overwrites a different one", async () => {
    const base = tmp();
    const first = await writeDownload(base, "k", "a.txt", Buffer.from("one"));
    const again = await writeDownload(base, "k", "a.txt", Buffer.from("one"));
    expect(again).toEqual({ path: first.path, reused: true });

    const other = await writeDownload(base, "k", "a.txt", Buffer.from("different"));
    expect(other.reused).toBe(false);
    expect(path.basename(other.path)).toBe("a-1.txt");
    expect(readFileSync(first.path, "utf8")).toBe("one");
    expect(readdirSync(path.join(base, "k")).sort()).toEqual(["a-1.txt", "a.txt"]);
  });

  it("does not write through a pre-existing symlink", async () => {
    const base = tmp();
    const target = path.join(tmp(), "victim.txt");
    writeFileSync(target, "original-and-longer");
    await writeDownload(base, "k", "seed.txt", Buffer.from("s"));
    symlinkSync(target, path.join(base, "k", "link.txt"));

    const r = await writeDownload(base, "k", "link.txt", Buffer.from("new"));
    expect(readFileSync(target, "utf8")).toBe("original-and-longer");
    expect(r.path).not.toBe(path.join(base, "k", "link.txt"));
  });
});
