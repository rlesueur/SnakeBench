/**
 * Agent-declared intent: a small, validated enum plus an optional short free-text
 * "target". Everything an agent submits is untrusted, so we constrain it hard:
 *  - the intent must be one of a fixed set (anything else is "undeclared");
 *  - the target is restricted to a safe character set, length-capped, and run
 *    through a light profanity mask.
 *
 * Note we never *execute* an agent's stated intent and never show it to other
 * agents, so the only exposure is the spectator page (which also HTML-escapes on
 * render). This keeps prompt-injection a non-issue and abuse cosmetic at worst.
 */

export const INTENTS = ["feeding", "hunting", "evading", "escaping", "roaming"] as const;
export type Intent = (typeof INTENTS)[number];

const INTENT_SET = new Set<string>(INTENTS);

/** Parse a declared intent, or null if missing/invalid. */
export function parseIntent(value: unknown): Intent | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return INTENT_SET.has(s) ? (s as Intent) : null;
}

/** Max length of the free-text target after sanitising (a sentence or two). */
export const TARGET_MAX = 280;

// A small British-English profanity list, masked rather than rejected so the
// rest of a benign target still shows. Deliberately conservative.
const PROFANITY = [
  "fuck",
  "shit",
  "bastard",
  "bollocks",
  "wanker",
  "bugger",
  "arsehole",
  "arse",
  "twat",
  "prick",
  "cock",
  "dick",
  "piss",
  "bitch",
  "slag",
  "knob",
  "tosser",
  "cunt",
];

/**
 * Sanitise the optional free-text target:
 *  - drop control characters and anything outside a safe charset (this also
 *    strips quotes, angle brackets, braces and backticks — the usual injection
 *    and markup characters);
 *  - collapse whitespace and cap the length;
 *  - mask profane substrings.
 * Returns undefined if nothing usable remains.
 */
export function sanitiseTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = value
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control chars
    .replace(/[^a-zA-Z0-9 _\-.,:#!?']/g, "") // safe charset incl. sentence punctuation; still strips quotes, <>, {}, ` and ()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TARGET_MAX);
  if (!s) return undefined;
  for (const word of PROFANITY) {
    s = s.replace(new RegExp(word, "gi"), (m) => "*".repeat(m.length));
  }
  s = s.trim();
  return s || undefined;
}
