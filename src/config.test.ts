import { homedir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig, parseFolderList, passwordEnvName } from "./config.js";

const YAML = `
blocked_folders: Sicherheit, Geheim
accounts:
  - id: privat
    host: mxf000.netcup.net
    port: 993
    user: ich@example.de
  - id: arbeit-2
    host: mail.example.org
    user: me@example.org
    secure: false
    port: 143
`;

const reader = (text: string) => () => text;
const missing = () => {
  throw Object.assign(new Error("nope"), { code: "ENOENT" });
};

describe("loadConfig", () => {
  it("parses the YAML account file with defaults", () => {
    const cfg = loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/x/accounts.yaml" }, reader(YAML));
    expect(cfg.source).toBe("file");
    expect(cfg.accounts).toEqual([
      { id: "privat", host: "mxf000.netcup.net", port: 993, user: "ich@example.de", secure: true },
      { id: "arbeit-2", host: "mail.example.org", port: 143, user: "me@example.org", secure: false },
    ]);
    expect(cfg.blockedFolders).toEqual(["Sicherheit", "Geheim"]);
  });

  it("also accepts JSON", () => {
    const json = JSON.stringify({
      accounts: [{ id: "a", host: "h", user: "u" }],
    });
    const cfg = loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/x/a.json" }, reader(json));
    expect(cfg.accounts[0]).toMatchObject({ id: "a", port: 993, secure: true });
    expect(cfg.blockedFolders).toEqual(["Sicherheit"]);
  });

  it("env MAIL_TRIAGE_BLOCKED_FOLDERS overrides blocked_folders", () => {
    const cfg = loadConfig(
      { MAIL_TRIAGE_ACCOUNTS: "/x", MAIL_TRIAGE_BLOCKED_FOLDERS: "A, B" },
      reader(YAML)
    );
    expect(cfg.blockedFolders).toEqual(["A", "B"]);
  });

  it("rejects a bare list at top level", () => {
    expect(() =>
      loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/x" }, reader("- id: a\n  host: h\n  user: u\n"))
    ).toThrow(/Top-Level/);
  });

  it("rejects invalid ids, duplicates and ports", () => {
    const bad = (acc: string) =>
      loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/x" }, reader(`accounts:\n${acc}`));
    expect(() => bad("  - {id: Bad_ID, host: h, user: u}")).toThrow(/id/);
    expect(() => bad("  - {id: a, host: h, user: u}\n  - {id: a, host: h, user: u}")).toThrow(/doppelte/);
    expect(() => bad("  - {id: a, host: h, user: u, port: 0}")).toThrow(/port/);
    expect(() => bad("  - {id: a, host: h}")).toThrow(/user/);
  });

  it("errors if an explicitly configured file is missing", () => {
    expect(() => loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/x" }, missing)).toThrow(/konnte nicht gelesen/);
  });

  it("falls back to legacy IMAP_* env as account 'default'", () => {
    const cfg = loadConfig(
      { IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASS: "p", IMAP_PORT: "1143", IMAP_SECURE: "false" },
      missing
    );
    expect(cfg.source).toBe("env");
    expect(cfg.accounts).toEqual([
      {
        id: "default", host: "h", port: 1143, user: "u", secure: false,
        legacyPassword: "p", starttls: true, tlsRejectUnauthorized: true,
      },
    ]);
  });

  it("errors without file and without IMAP_HOST", () => {
    expect(() => loadConfig({}, missing)).toThrow(/Keine Account-Datei/);
  });

  it("parses MAIL_TRIAGE_MAX_BODY_CHARS", () => {
    const base = { MAIL_TRIAGE_ACCOUNTS: "/x" };
    expect(loadConfig(base, reader(YAML)).maxBodyChars).toBe(4000);
    expect(loadConfig({ ...base, MAIL_TRIAGE_MAX_BODY_CHARS: "100" }, reader(YAML)).maxBodyChars).toBe(100);
    expect(() => loadConfig({ ...base, MAIL_TRIAGE_MAX_BODY_CHARS: "x" }, reader(YAML))).toThrow();
  });
});

describe("download settings", () => {
  const base = { MAIL_TRIAGE_ACCOUNTS: "/x" };

  it("uses safe defaults", () => {
    const c = loadConfig(base, reader(YAML));
    expect(c.downloadDir).toBe(path.join(homedir(), "mail-triage-downloads"));
    expect(c.maxDownloadBytes).toBe(25 * 1024 * 1024);
  });

  it("reads MAIL_TRIAGE_DOWNLOAD_DIR and MAIL_TRIAGE_MAX_DOWNLOAD_MB", () => {
    const c = loadConfig(
      { ...base, MAIL_TRIAGE_DOWNLOAD_DIR: "~/Mails/Anhaenge", MAIL_TRIAGE_MAX_DOWNLOAD_MB: "1.5" },
      reader(YAML)
    );
    expect(c.downloadDir).toBe(path.join(homedir(), "Mails", "Anhaenge"));
    expect(c.maxDownloadBytes).toBe(Math.floor(1.5 * 1024 * 1024));
  });

  it.each(["0", "-1", "abc"])("rejects MAIL_TRIAGE_MAX_DOWNLOAD_MB=%s", (v) => {
    expect(() => loadConfig({ ...base, MAIL_TRIAGE_MAX_DOWNLOAD_MB: v }, reader(YAML))).toThrow(/MAX_DOWNLOAD_MB/);
  });

  it.each(["/", "~", homedir()])("rejects %s as download dir", (v) => {
    expect(() => loadConfig({ ...base, MAIL_TRIAGE_DOWNLOAD_DIR: v }, reader(YAML))).toThrow(/DOWNLOAD_DIR/);
  });
});

describe("helpers", () => {
  it("parseFolderList", () => {
    expect(parseFolderList(" a, ,b ")).toEqual(["a", "b"]);
    expect(parseFolderList(["x", " y "])).toEqual(["x", "y"]);
    expect(parseFolderList("")).toEqual([]);
  });
  it("passwordEnvName", () => {
    expect(passwordEnvName("privat-1")).toBe("MAIL_TRIAGE_PASS_PRIVAT_1");
  });
});

describe("accounts.example.yaml", () => {
  it("is a valid config", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = loadConfig({ MAIL_TRIAGE_ACCOUNTS: "/example" }, () =>
      readFileSync(new URL("../accounts.example.yaml", import.meta.url), "utf8")
    );
    expect(cfg.accounts.map((a) => a.id)).toEqual(["privat", "projekt-2"]);
    expect(cfg.blockedFolders).toEqual(["Sicherheit"]);
  });
});
