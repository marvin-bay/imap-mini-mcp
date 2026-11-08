import { describe, it, expect } from "vitest";
import { redactText } from "./redact.js";

const r = redactText;

describe("redactText — standalone numbers", () => {
  it.each([
    ["Ihr Code ist 482913.", "Ihr Code ist [CODE]."],
    ["PIN: 1234", "PIN: [CODE]"],
    ["12345678 ist die Nummer", "[CODE] ist die Nummer"],
    ["Code 123 456 eingeben", "Code [CODE] eingeben"],
    ["Code 123-456 eingeben", "Code [CODE] eingeben"],
    ["Code 1234 5678", "Code [CODE]"],
    ["(987654)", "([CODE])"],
    ["Zeile1\n654321\nZeile3", "Zeile1\n[CODE]\nZeile3"],
  ])("redacts %j", (input, expected) => expect(r(input)).toBe(expected));

  it.each([
    "123",
    "12",
    "123456789", // 9 digits: not a code by definition
    "Bestellung RE123456",
    "Artikel 123456a",
  ])("leaves %j alone", (s) => expect(r(s)).toBe(s));

  it("redacts numbers after a hyphen (ticket-id style), erring on the safe side", () => {
    expect(r("INC-123456")).toBe("INC-[CODE]");
  });

  it("keeps years 1900-2099 but not other 4-digit numbers", () => {
    expect(r("im Jahr 2026 und 1999")).toBe("im Jahr 2026 und 1999");
    expect(r("PIN 2100")).toBe("PIN [CODE]");
    expect(r("PIN 1899")).toBe("PIN [CODE]");
    expect(r("Schuljahr 2026-2027")).toBe("Schuljahr 2026-2027");
  });
});

describe("redactText — things that must survive", () => {
  it.each([
    "Am 2026-11-08 um 12:30",
    "Datum: 08.11.2026",
    "Datum: 8.11.26",
    "Date: 11/08/2026",
    "2026-11-08T12:30:00Z",
    "2026-11-08T12:30:00+01:00",
    "Uhrzeit 09:15:42",
    "Betrag: 12,99 EUR",
    "Betrag: 1.234,56 €",
    "Total: 1,234.56 USD",
    "Summe 1234,56",
    "Preis 99.99",
    "nur 1500 EUR",
    "€ 2500",
    "3000€",
    "$1500",
    "IBAN DE89370400440532013000",
    "IBAN DE89 3704 0044 0532 0130 00",
    "IBAN: AT61 1904 3002 3457 3201",
    "Version 10.2.12345.1",
    "IP 192.168.100.2000",
  ])("keeps %j", (s) => expect(r(s)).toBe(s));

  it("redacts a code next to a date without touching the date", () => {
    expect(r("Am 08.11.2026 Code 654321 gültig bis 12:45")).toBe(
      "Am 08.11.2026 Code [CODE] gültig bis 12:45"
    );
  });

  it("redacts a code next to an amount without touching the amount", () => {
    expect(r("Zahlung 12,99 EUR, TAN 445566")).toBe("Zahlung 12,99 EUR, TAN [CODE]");
  });

  it("is idempotent", () => {
    const once = r("Code 123456 und https://x.de/reset?t=1 am 2026-11-08");
    expect(r(once)).toBe(once);
  });

  it("handles empty input and stray private-use characters", () => {
    expect(r("")).toBe("");
    expect(r("aP0b")).toBe("aP0b");
  });
});

describe("redactText — alphanumeric tokens after keywords", () => {
  it.each([
    ["Ihr Code: A1B2C3", "Ihr Code: [CODE]"],
    ["code A1B2C3D4", "code [CODE]"],
    ["Verification code is X9Y8Z7W6", "Verification code is [CODE]"],
    ["Passwort: abc123def", "Passwort: [CODE]"],
    ["password abc123XYZ9", "password [CODE]"],
    ["Kennwort    Qw3rty99", "Kennwort    [CODE]"],
    ["Ihre TAN ist 8F3K2L", "Ihre TAN ist [CODE]"],
    ["OTP: 7G7G7G7G7G", "OTP: [CODE]"],
    ["PIN K4L9M2", "PIN [CODE]"],
    ["Bestätigung: Z8X7C6V5", "Bestätigung: [CODE]"],
    ["Bestätigungscode\nA1B2C3D4", "Bestätigungscode\n[CODE]"],
    ["Verification: 9ZZ9ZZ9ZZ", "Verification: [CODE]"],
  ])("redacts %j", (input, expected) => expect(r(input)).toBe(expected));

  it.each([
    "Code: ABCDEF", // letters only
    "Code: 12345678901", // too long
    "Code: A1B2", // too short
    "Code: A1B2C3D4E5F6", // too long
    "Das Wetter ist schön A1B2C3", // no keyword
    "Passwort wurde geändert. Mehr dazu unten in diesem langen Text A1B2C3D4",
  ])("leaves %j alone", (s) => expect(r(s)).toBe(s));

  it("only looks ~40 chars after the keyword", () => {
    const near = "Code" + " ".repeat(35) + "A1B2C3";
    const far = "Code" + " ".repeat(60) + "A1B2C3";
    expect(r(near)).toBe("Code" + " ".repeat(35) + "[CODE]");
    expect(r(far)).toBe(far);
  });

  it("does not use 'pin', 'tan' or 'otp' inside other words", () => {
    expect(r("Spinne A1B2C3 Instanz B2C3D4")).toBe("Spinne A1B2C3 Instanz B2C3D4");
  });

  it("does not touch an IBAN after 'Passwort' keyword context", () => {
    expect(r("Passwort IBAN DE89370400440532013000")).toBe("Passwort IBAN DE89370400440532013000");
  });
});

describe("redactText — URLs", () => {
  it.each([
    "https://example.com/reset-password?x=1",
    "https://example.com/a?token=abc",
    "https://example.com/verify/12345",
    "https://example.com/confirm-email",
    "https://example.com/magic/xyz",
    "https://example.com/login?next=/",
    "https://example.com/auth/callback",
    "https://example.com/x?otp=1",
    "https://example.com/redeem?code=ABC",
    "https://example.com/a?API_KEY=1",
    "https://example.com/dl?signature=abcd",
    "https://example.com/dl?sig=abcd&e=1",
    "https://example.com/p#access_token=zzz",
    "HTTPS://EXAMPLE.COM/RESET",
    "http://example.com/Verify",
  ])("replaces %s", (url) => {
    expect(r(`Klick hier: ${url} danke`)).toBe("Klick hier: [LINK] danke");
  });

  it("keeps trailing punctuation and handles brackets/angle brackets", () => {
    expect(r("Siehe https://a.de/reset.")).toBe("Siehe [LINK].");
    expect(r("Link [https://a.de/verify?x=1] ok")).toBe("Link [[LINK]] ok");
    expect(r("<https://a.de/login>")).toBe("<[LINK]>");
    expect(r("(https://a.de/confirm)")).toBe("([LINK])");
  });

  it("matches on path/query, not on host", () => {
    expect(r("https://login.example.com/home")).toBe("https://login.example.com/home");
    expect(r("https://keystone.de/")).toBe("https://keystone.de/");
  });

  it("keeps harmless URLs intact, including digits inside", () => {
    const u = "https://shop.example.com/produkt/123456?ref=789012";
    expect(r(`Mehr: ${u}`)).toBe(`Mehr: ${u}`);
    expect(r("www.example.com/seite/654321")).toBe("www.example.com/seite/654321");
  });

  it("redacts several URLs and numbers in one text", () => {
    expect(
      r("Code 123456\nhttps://a.de/reset?x=1\nhttps://a.de/news/2026\nDatum 2026-11-08")
    ).toBe("Code [CODE]\n[LINK]\nhttps://a.de/news/2026\nDatum 2026-11-08");
  });
});

describe("redactText — subjects", () => {
  it.each([
    ["Ihr Bestätigungscode: 482913", "Ihr Bestätigungscode: [CODE]"],
    ["123456 ist Ihr Google-Code", "[CODE] ist Ihr Google-Code"],
    ["Rechnung vom 08.11.2026 über 1.234,56 EUR", "Rechnung vom 08.11.2026 über 1.234,56 EUR"],
    ["Re: Termin am 2026-11-08", "Re: Termin am 2026-11-08"],
    ["Your code: A1B2C3", "Your code: [CODE]"],
  ])("%j", (input, expected) => expect(r(input)).toBe(expected));
});

describe("redactText — performance", () => {
  it("handles large inputs quickly", () => {
    const chunk = "Code Passwort abcdefghij 12 Lorem ipsum dolor sit amet 08.11.2026 12,99 EUR https://a.de/x\n";
    const big = chunk.repeat(3000);
    const t0 = Date.now();
    r(big);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
