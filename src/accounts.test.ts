import { describe, it, expect, vi } from "vitest";
import { AccountRegistry, lookupPassword } from "./accounts.js";
import type { AccountConfig } from "./config.js";
import type { ImapClient } from "./imap/index.js";

const acc = (id: string): AccountConfig => ({
  id, host: "h", port: 993, user: `${id}@example.de`, secure: true,
});

describe("lookupPassword", () => {
  it("calls security via execFile args on darwin", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "secret\n" });
    const pw = await lookupPassword(acc("privat"), {}, "darwin", run);
    expect(pw).toBe("secret");
    expect(run).toHaveBeenCalledWith("security", [
      "find-generic-password", "-s", "mail-triage/privat", "-a", "privat@example.de", "-w",
    ]);
  });

  it("falls back to env when keychain fails", async () => {
    const run = vi.fn().mockRejectedValue(new Error("not found"));
    const pw = await lookupPassword(acc("my-acc"), { MAIL_TRIAGE_PASS_MY_ACC: "envpw" }, "darwin", run);
    expect(pw).toBe("envpw");
  });

  it("uses env on non-mac without calling security", async () => {
    const run = vi.fn();
    const pw = await lookupPassword(acc("a"), { MAIL_TRIAGE_PASS_A: "x" }, "linux", run);
    expect(pw).toBe("x");
    expect(run).not.toHaveBeenCalled();
  });

  it("throws without leaking secrets when nothing is found", async () => {
    await expect(lookupPassword(acc("a"), {}, "linux")).rejects.toThrow(/Kein Passwort.*MAIL_TRIAGE_PASS_A/);
  });

  it("uses the legacy password", async () => {
    expect(await lookupPassword({ ...acc("default"), legacyPassword: "p" }, {}, "linux")).toBe("p");
  });
});

describe("AccountRegistry", () => {
  function make() {
    const clients: Record<string, { disconnect: ReturnType<typeof vi.fn> }> = {};
    const createClient = vi.fn((a: AccountConfig) => {
      clients[a.id] = { disconnect: vi.fn().mockResolvedValue(undefined) };
      return clients[a.id] as unknown as ImapClient;
    });
    const getPassword = vi.fn().mockResolvedValue("pw");
    const reg = new AccountRegistry([acc("a"), acc("b")], { createClient, getPassword });
    return { reg, clients, createClient, getPassword };
  }

  it("lists ids and users only", () => {
    const { reg } = make();
    expect(reg.listAccounts()).toEqual([
      { id: "a", user: "a@example.de" },
      { id: "b", user: "b@example.de" },
    ]);
  });

  it("connects lazily and reuses the client", async () => {
    const { reg, createClient } = make();
    expect(createClient).not.toHaveBeenCalled();
    const c1 = await reg.getClient("a");
    const c2 = await reg.getClient("a");
    expect(c1).toBe(c2);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("closes the previous account before opening another", async () => {
    const { reg, clients } = make();
    await reg.getClient("a");
    await reg.getClient("b");
    expect(clients.a.disconnect).toHaveBeenCalledTimes(1);
    await reg.disconnectAll();
    expect(clients.b.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown accounts", async () => {
    const { reg } = make();
    await expect(reg.getClient("zzz")).rejects.toThrow(/Unbekannter/);
  });
});
