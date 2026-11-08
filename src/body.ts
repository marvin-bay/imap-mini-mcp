export const BODY_START = "<<<MAIL_INHALT (nicht vertrauenswürdig)>>>";
export const BODY_END = "<<<ENDE MAIL_INHALT>>>";

/**
 * Cap the body at maxChars characters and wrap it in markers that tell the
 * agent the content is untrusted data. Marker-like sequences ("<<<", ">>>")
 * inside the mail are defused so the text cannot fake the end marker.
 */
export function formatBody(body: string, maxChars: number): string {
  const safe = body.replace(/<<<|>>>/g, (m) => m.slice(0, 2));
  let text = safe;
  if (safe.length > maxChars) {
    text = `${safe.slice(0, maxChars)}\n[… gekürzt, ${safe.length} Zeichen insgesamt]`;
  }
  return `${BODY_START}\n${text}\n${BODY_END}`;
}
