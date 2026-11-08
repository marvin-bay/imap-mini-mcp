/**
 * Redaction of one-time codes, PINs and sensitive links from mail text.
 *
 * Goal: the triage agent can see what a mail is about, but not secrets
 * (verification codes, reset links, ...) that would let it (or an injected
 * prompt) take over an account. Over-redaction is acceptable, destroying
 * dates, times, amounts or IBANs is not.
 *
 * Pipeline:
 *  1. URLs: sensitive ones become [LINK], harmless ones are protected.
 *  2. Protect IBANs, dates, times and money amounts behind placeholders.
 *  3. Alphanumeric tokens (6-10 chars, letters AND digits) shortly after a
 *     code-like keyword become [CODE].
 *  4. Standalone 4-8 digit numbers (also "123 456" / "123-456") become
 *     [CODE]; years 1900-2099 are kept.
 *  5. Restore the protected parts.
 */

export const CODE_PLACEHOLDER = "[CODE]";
export const LINK_PLACEHOLDER = "[LINK]";

const PH_OPEN = "";
const PH_CLOSE = "";
const PH_RE = /P(\d+)/g;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`\]]+/gi;
const SENSITIVE_URL_RE = /token|reset|verify|confirm|magic|login|auth|otp|code|key|signature|sig=/i;
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;

// Letters are included in the placeholder so the digits never look like a
// standalone number to later steps.
function makeProtector() {
  const store: string[] = [];
  return {
    protect(value: string): string {
      store.push(value);
      return `${PH_OPEN}P${store.length - 1}${PH_CLOSE}`;
    },
    restore(text: string): string {
      // Placeholders can nest (e.g. none today, but be safe): loop to a fixpoint.
      let out = text;
      for (let i = 0; i < 5 && out.includes(PH_OPEN); i++) {
        out = out.replace(PH_RE, (_m, n: string) => store[Number(n)] ?? "");
      }
      return out;
    },
  };
}

function isSensitiveUrl(url: string): boolean {
  const rest = url.replace(/^(?:https?:\/\/)?[^/?#]*/i, "");
  return SENSITIVE_URL_RE.test(rest);
}

const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;

const DATE_TIME_RES: RegExp[] = [
  // ISO date, optionally with time: 2026-11-08, 2026-11-08T12:30:00(Z)
  /(?<![\d.\-/])\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d])/g,
  // 08.11.2026, 8.11.26, 08/11/2026, 11/08/2026
  /(?<![\d.\-/])\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})(?![\d])/g,
  // 12:30, 12:30:15
  /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g,
];

const AMOUNT_RES: RegExp[] = [
  // 1.234,56 / 1,234.56 / 12,99 / 1234,56 / 12.99
  /(?<![\d.,])(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{1,2}|\d+[.,]\d{1,2})(?![\d])/g,
  // integers directly attached to a currency: 1500 EUR, € 2500, 3000€
  /(?:[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|\$|£|EUR\b|Euro\b|USD\b|CHF\b))/g,
];

const CODE_KEYWORDS =
  "(?:\\b(?:pin|tan|otp)\\b|code|passwort|password|kennwort|verification|bestätigung)";
const CONTEXT_TOKEN_RE = new RegExp(
  `(?<=${CODE_KEYWORDS}[\\s\\S]{0,40})` +
    "(?<![A-Za-z0-9])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\\d)[A-Za-z0-9]{6,10}(?![A-Za-z0-9])",
  "gi"
);

const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_]|\\d[.,:/-])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_]|[.,:/-]\\d)";
const NUMBER_RE = new RegExp(
  `${NOT_WORD_BEFORE}(\\d{3,5}[ -]\\d{3,5}|\\d{3,8})${NOT_WORD_AFTER}`,
  "gu"
);

function isYear(s: string): boolean {
  return /^\d{4}$/.test(s) && Number(s) >= 1900 && Number(s) <= 2099;
}

function redactNumber(match: string): string {
  const parts = match.split(/[ -]/);
  const digits = parts.join("");
  if (digits.length < 4 || digits.length > 8) return match;
  if (parts.length === 1) return isYear(digits) ? match : CODE_PLACEHOLDER;
  // "2026-2027" style year ranges are not codes
  if (parts.every(isYear)) return match;
  return CODE_PLACEHOLDER;
}

/** Redact codes and sensitive links in free text (body or subject). */
export function redactText(input: string): string {
  if (!input) return input;
  const prot = makeProtector();
  let text = input.split(PH_OPEN).join("").split(PH_CLOSE).join("");

  // 1. URLs
  text = text.replace(URL_RE, (raw) => {
    const trail = raw.match(TRAILING_PUNCT_RE)?.[0] ?? "";
    const url = trail ? raw.slice(0, raw.length - trail.length) : raw;
    return (isSensitiveUrl(url) ? LINK_PLACEHOLDER : prot.protect(url)) + trail;
  });

  // 2. Things that look like numbers but must survive
  for (const re of [IBAN_RE, ...DATE_TIME_RES, ...AMOUNT_RES]) {
    text = text.replace(re, (m) => prot.protect(m));
  }

  // 3. Alphanumeric tokens after code-like keywords
  text = text.replace(CONTEXT_TOKEN_RE, CODE_PLACEHOLDER);

  // 4. Standalone numbers
  text = text.replace(NUMBER_RE, (m) => redactNumber(m));

  return prot.restore(text);
}
