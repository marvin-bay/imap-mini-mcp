import { describe, it, expect } from "vitest";
import { isBlockedFolder } from "./blocked.js";

const B = ["Sicherheit"];

describe("isBlockedFolder", () => {
  it.each([
    "Sicherheit",
    "sicherheit",
    "SICHERHEIT",
    "INBOX/Sicherheit",
    "INBOX.Sicherheit",
    "INBOX.sicherheit",
    "INBOX/Sicherheit/Alt",
    "Archiv/Sicherheit",
  ])("blocks %s", (p) => expect(isBlockedFolder(p, B)).toBe(true));

  it.each(["INBOX", "INBOX/Rechnungen", "Sicherheitshinweise", "Unsicherheit", "INBOX.Sent", ""])(
    "allows %s",
    (p) => expect(isBlockedFolder(p, B)).toBe(false)
  );

  it("supports multi-segment entries and several entries", () => {
    expect(isBlockedFolder("INBOX/Bank/Codes", ["INBOX/Bank"])).toBe(true);
    expect(isBlockedFolder("Bank", ["INBOX/Bank"])).toBe(false);
    expect(isBlockedFolder("X/Geheim", ["A", "geheim"])).toBe(true);
  });

  it("blocks nothing with an empty list", () => {
    expect(isBlockedFolder("Sicherheit", [])).toBe(false);
  });
});
