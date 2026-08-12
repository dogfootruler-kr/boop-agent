export const HIDDEN_PHONE_LABEL = "[phone number hidden]";
export const HIDDEN_EMAIL_LABEL = "[email hidden]";

const PHONE_CANDIDATE_RE = /(^|[^\w@])(\+?\d[\d\s().-]{8,}\d)(?=$|[^\w@])/g;

export function redactPhoneNumbers(value: string): string {
  return value.replace(PHONE_CANDIDATE_RE, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return match;
    return `${prefix}${HIDDEN_PHONE_LABEL}`;
  });
}

/**
 * Formatting markers a reader never sees.
 *
 * Markdown emphasis and WhatsApp emphasis both live in this set, as does the
 * inline-code backtick. A marker sitting between two digits is invisible to
 * the person reading the message, so the number is whole as far as they are
 * concerned even when `PHONE_CANDIDATE_RE` cannot see it.
 */
const MARKUP_CHARS = new Set(["*", "_", "~", "`"]);

/**
 * Redact phone numbers, including one that formatting markers run through.
 *
 * `redactPhoneNumbers` reads the text exactly as written, so `+1 555 **000**
 * 0101` defeats it: `*` is not a character a phone number is made of. Per-
 * channel formatting then removes or rewrites those markers and hands the
 * Gateway the digits, whole. This reads the text the way its reader will
 * instead, matching against a marker-free view of it and redacting the whole
 * span - markers and all - back in the original.
 *
 * The match itself is still `PHONE_CANDIDATE_RE` and its digit-count check.
 * Widening that character class to admit markers was considered and rejected:
 * it would change what counts as a phone number everywhere the plain function
 * is used, for the sake of a case that is really about formatting.
 */
export function redactPhoneNumbersThroughMarkup(value: string): string {
  // First the plain pass, because the marker-free view can lose a match the
  // written text has: in `a*+15550000101*` the leading `*` is what satisfies
  // the "not a word character" boundary, and removing it hides the number
  // behind the `a`.
  const redacted = redactPhoneNumbers(value);

  const view: string[] = [];
  const sourceIndex: number[] = [];
  for (let i = 0; i < redacted.length; i++) {
    const char = redacted[i];
    if (MARKUP_CHARS.has(char)) continue;
    view.push(char);
    sourceIndex.push(i);
  }
  if (view.length === redacted.length) return redacted;

  let out = "";
  let cursor = 0;
  for (const match of view.join("").matchAll(PHONE_CANDIDATE_RE)) {
    const candidate = match[2];
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    const from = match.index + match[1].length;
    const start = sourceIndex[from];
    // Everything between the first and last character of the candidate goes,
    // including the markers that were skipped over to find it.
    const end = sourceIndex[from + candidate.length - 1] + 1;
    out += redacted.slice(cursor, start) + HIDDEN_PHONE_LABEL;
    cursor = end;
  }
  return out + redacted.slice(cursor);
}

export function redactContactHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "me" || trimmed === "unknown") return trimmed;
  const withoutPhones = redactPhoneNumbers(trimmed);
  if (withoutPhones !== trimmed) return withoutPhones;
  if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return HIDDEN_EMAIL_LABEL;
  return trimmed;
}
