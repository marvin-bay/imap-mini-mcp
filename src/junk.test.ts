import { describe, it, expect } from "vitest";
import { isJunkFolder } from "./junk.js";

describe("isJunkFolder", () => {
  it.each([
    "Trash", "INBOX/Trash", "INBOX.Spam", "Junk", "Papierkorb", "[Gmail]/Trash",
    "Junk-E-Mail", "Gelöschte Elemente", "Deleted Items", "gelöschte elemente",
    "Gelöschte Elemente/Archiv", "Gelöschte Elemente/Unbenannter Ordner 1",
  ])("treats %s as junk", (p) => expect(isJunkFolder(p)).toBe(true));

  it.each([
    "INBOX", "Gesendete Elemente", "Archiv", "Anschaffung/2022-003_Trockenschrank",
    "EX/📆 Termine", "Junkyard", "Spamtrap-Analyse", "Notizen",
  ])("keeps %s", (p) => expect(isJunkFolder(p)).toBe(false));
});
