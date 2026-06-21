// ── Context Sensitivity Detection ─────────────────────────────────────────────
// Phase 1a / Adaption 6 of the ContextGenerator pipeline.
//
// Sensitivity is an axis ORTHOGONAL to the topic-category. A `frontend` item
// can be `private`; a `notes` item can be `system`. Three tiers exist:
//
//   public   — default, freely visible
//   private  — requires English confirm-gate before access (PII, mail, calendar)
//   system   — requires confirm-gate + extra warning (credentials, keys, configs)
//
// Detection sources, by priority:
//
//   1. user   — manual override; never overwritten by auto-detection
//   2. path   — directory or frontmatter rule (deterministic, applied first)
//   3. auto   — heuristic; only surfaces as a *suggestion* when confidence > 0.8,
//               never auto-promoted to user-visible without confirmation
//
// All exports are pure functions — this file holds no state. The watchdog/
// route layer is responsible for caching results and persisting the chosen
// tier into the session JSON.
'use strict';

// ── Tier type ────────────────────────────────────────────────────────────────

type Tier = 'public' | 'private' | 'system';

// ── Path-based default ───────────────────────────────────────────────────────
// Deterministic mapping for files that live under conventional sensitive dirs.
// Returns null when the path doesn't match any known sensitive root, so the
// caller can fall back to auto-detection.

function pathToDefaultTier(p: string | null | undefined): Tier | null {
  if (!p || typeof p !== 'string') return null;
  const norm = p.replace(/\\/g, '/').toLowerCase();

  // System-tier paths — credentials, configs, secrets.
  if (
    norm.includes('/docs/system/') ||
    norm.includes('/.env') ||
    norm.endsWith('/.env') ||
    norm.includes('/credentials/') ||
    norm.includes('/secrets/') ||
    norm.endsWith('.pem') ||
    norm.endsWith('.key') ||
    norm.endsWith('.p12')
  ) {
    return 'system';
  }

  // Private-tier paths — personal notes, mail, calendar.
  if (
    norm.includes('/docs/notes/private/') ||
    norm.includes('/docs/mail/') ||
    norm.includes('/docs/calendar/') ||
    norm.includes('/private/')
  ) {
    return 'private';
  }

  return null;
}

// ── Credential / secret detection ────────────────────────────────────────────
// High-precision regex for things that look like API keys, env-var assignments,
// and PEM-encoded private keys. False positives are acceptable here because
// the caller treats hits as *suggestions*, not auto-promotions.

const _CRED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // PEM-encoded private keys are unambiguous → very high signal.
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i, reason: 'pem-private-key' },
  // AWS access keys have a fixed prefix and length.
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'aws-access-key' },
  // Generic env-var style: API_KEY=, PASSWORD=, SECRET=, TOKEN=, AUTH=
  { re: /\b(?:API[_-]?KEY|SECRET[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|BEARER[_-]?TOKEN)\s*[:=]\s*['"`]?[A-Za-z0-9._\-+/=]{12,}/i, reason: 'env-credential' },
  // GitHub personal access tokens (classic + fine-grained) and OAuth tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, reason: 'github-token' },
  // Slack/Discord/Stripe-style API tokens (xoxp-, xoxb-, sk_live_, etc.)
  { re: /\b(?:xox[pbar]-|sk_live_|sk_test_|rk_live_|pk_live_)[A-Za-z0-9-]{20,}/, reason: 'service-token' },
  // OpenAI / Anthropic / etc. API key prefixes.
  { re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/, reason: 'llm-api-key' },
];

function detectCredentials(text: string | null | undefined): { found: boolean; reasons: string[] } {
  if (!text || typeof text !== 'string' || text.length === 0) {
    return { found: false, reasons: [] };
  }
  const reasons: string[] = [];
  for (const { re, reason } of _CRED_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return { found: reasons.length > 0, reasons };
}

// ── Personal information (PII) detection ─────────────────────────────────────
// Lower-confidence than credentials — used to nudge `public → private`, never
// to escalate to `system`.

const _PII_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // IBAN: 2 letters + 2 digits + up to 30 alphanumerics (format only, not checksum).
  { re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, reason: 'iban-format' },
  // Credit-card-ish 13–19 digit runs separated by spaces or dashes.
  { re: /\b(?:\d[ -]*?){13,19}\b/, reason: 'card-number-format' },
  // E-mail address — high false-positive rate, weak signal alone.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, reason: 'email-address' },
  // International phone numbers (loose heuristic).
  { re: /\+\d{1,3}[\s().-]?\d{2,4}[\s().-]?\d{3,4}[\s().-]?\d{3,4}/, reason: 'phone-number' },
  // Generic SSN-ish 9-digit blocks with US-style separators.
  { re: /\b\d{3}-\d{2}-\d{4}\b/, reason: 'ssn-format' },
  // Postal-address heuristic — DE Postleitzahl (5 digits) followed by city, or
  // English-style "<number> <Street name> Street/Avenue/Road/Way". High
  // false-positive rate, but combined with another marker it justifies
  // private. Per user request 2026-05-07 (Phase 4.1) addresses are explicit
  // sensitivity markers for the keep-notes import.
  { re: /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,}/, reason: 'postal-de-format' },
  { re: /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Way|Drive|Dr\.?|Court|Ct\.?)\b/, reason: 'street-en-format' },
  { re: /\b(?:Straße|Strasse|Str\.|Gasse|Weg|Allee|Platz)\s+\d+/i, reason: 'street-de-format' },
];

function detectPersonalInfo(text: string | null | undefined): { found: boolean; reasons: string[] } {
  if (!text || typeof text !== 'string' || text.length === 0) {
    return { found: false, reasons: [] };
  }
  const reasons: string[] = [];
  for (const { re, reason } of _PII_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return { found: reasons.length > 0, reasons };
}

// ── Theme-based sensitivity markers (Phase 4.1, 2026-05-07) ──────────────────
// Per user spec: keep-notes (and any other free-form text) should escalate to
// `private` when topics like psychology, religion, erotic content, passwords,
// or addresses are present. Passwords are already covered by `_CRED_PATTERNS`
// (bumped to `system`); addresses by the new `street-*` / `postal-*` PII
// patterns above. The three remaining themes — psychology, religion, erotic —
// are content-based and bilingual (DE primary, EN secondary because the
// notes corpus is mixed).
//
// Word-boundary anchored, case-insensitive. Each row needs at least ONE
// strong-signal hit to fire (single ambiguous word like "Glaube" alone
// won't escalate because the count threshold is ≥ 2 in `proposeSensitivity`).
const _THEME_MARKERS: Array<{ re: RegExp; theme: string }> = [
  // Psychology / mental health — therapy talk, named conditions, self-reflection
  { re: /\b(?:Psycholog(?:e|in|isch|ie)?|Therap(?:eut|ie|ist)|Depressi(?:on|v)|Burnout|Burn-out|Angststörung|Panikattacke|Trauma(?:tisi(?:ert|erung))?|Suizid|Selbstverletzung|Borderline|Bipolar|Schizophreni|ADHS|ADHD|PTBS|PTSD|Achtsamkeit|Selbstwert|Selbsthass|Innere?s? Kind|Schattenarbeit|Sigmund Freud|C\.G\. Jung|Carl Jung)\b/i, theme: 'psychology' },
  { re: /\b(?:therapy|therapist|depression|anxiety attack|panic attack|trauma|self-harm|suicid(?:e|al)|mental health|inner child|shadow work|cognitive behaviou?ral|psychotherapy)\b/i, theme: 'psychology' },
  // Religion / spirituality — explicit naming of faiths, prayer language, scripture
  { re: /\b(?:Christentum|Christlich|Katholi(?:sch|k)|Evangelisch|Protestant(?:isch)?|Islam(?:isch)?|Muslim(?:in|isch)?|Allah|Koran|Quran|Hadith|Judentum|Jüdisch|Tora|Talmud|Buddhis(?:mus|tisch|t)|Hindu(?:ismus|istisch)?|Karma|Reinkarnation|Wiedergeburt|Bet(?:en|et|ete|etet|end)|Gebet(?:e|en|s)?|Predigt|Bibel|Heilige Schrift|Jesus Christus|Gott der Herr|Kirche|Pfarrer|Pastor(?:in)?|Priester(?:in)?|Imam|Rabbiner(?:in)?|Mönch|Nonne|Moschee|Synagoge|Tempel|Esoteri(?:k|sch)|Spirituali(?:tät|sch)|Schamanis(?:mus|tisch)|Reiki|Chakra|Astrolog(?:ie|isch)|Horoskop|Tarot)\b/i, theme: 'religion' },
  { re: /\b(?:Christianity|Christian|Catholic|Protestant|Islam(?:ic)?|Muslim|Quran|Koran|Hadith|Judaism|Jewish|Torah|Talmud|Buddhism|Buddhist|Hinduism|Hindu|Karma|Reincarnation|prayer|sermon|scripture|Holy Bible|Jesus Christ|spirituality|esoteric|shamanism|chakra|astrology|horoscope|tarot)\b/i, theme: 'religion' },
  // Erotic / sexual content — explicit terms, clearly NSFW, kept conservative
  // to avoid false-positives on innocent words. ("Sex" alone is too ambiguous
  // — it appears in "Geschlecht/sex" forms — so we anchor on harder cues.)
  { re: /\b(?:Eroti(?:k|sch)|Porno(?:graph(?:ie|isch))?|Onaniere?n?|Masturb(?:ation|ier)|Fetisch|BDSM|Sadomaso|Domina|Nackt(?:foto|bild|aufnahme)|Geschlechtsverkehr|Orgasm(?:us|ieren)|Vaginal|Anal(?:sex|verkehr)|Fellatio|Cunnilingus|Brustwarze|Schamlippe|Penis|Vagina|Klitoris)\b/i, theme: 'erotic' },
  { re: /\b(?:erotic(?:a|ism)?|porn(?:o(?:graphy|graphic)?)?|masturbat(?:ion|e|ing)|fetish|BDSM|kinky|nude(?: photo| pic| shot)?|sexual intercourse|orgasm(?:s|ic)?|nipples?|labia|clitoris|vagina|penis|fellatio|cunnilingus)\b/i, theme: 'erotic' },
];

function detectThemes(text: string | null | undefined): { found: boolean; themes: string[] } {
  if (!text || typeof text !== 'string' || text.length === 0) {
    return { found: false, themes: [] };
  }
  const hits = new Set<string>();
  for (const { re, theme } of _THEME_MARKERS) {
    if (re.test(text)) hits.add(theme);
  }
  return { found: hits.size > 0, themes: [...hits] };
}

// ── Top-level proposal ───────────────────────────────────────────────────────
// Combines path-based defaults + content heuristics into a single tier
// suggestion with a confidence score and human-readable reason. The Watchdog
// only persists the proposal when `confidence > 0.8`.

interface SensitivityProposal {
  tier:        Tier;
  confidence:  number;       // 0..1
  source:      'path' | 'auto';
  reasons:     string[];
}

function proposeSensitivity(input: {
  title?:   string | null;
  content?: string | null;
  path?:    string | null;
}): SensitivityProposal {
  // 1) Path is deterministic — short-circuit when it hits.
  const fromPath = pathToDefaultTier(input.path);
  if (fromPath) {
    return {
      tier:       fromPath,
      confidence: 1.0,
      source:     'path',
      reasons:    [`path-rule:${fromPath}`],
    };
  }

  // 2) Content scan. Credentials beat PII because they justify `system`.
  const haystack = `${input.title || ''}\n${input.content || ''}`;
  const creds = detectCredentials(haystack);
  if (creds.found) {
    return {
      tier:       'system',
      confidence: 0.95,
      source:     'auto',
      reasons:    creds.reasons,
    };
  }

  const pii = detectPersonalInfo(haystack);
  const themes = detectThemes(haystack);
  if (pii.found || themes.found) {
    // E-mail-only is a weak signal (could be a public address); require ≥2 hits
    // or a strong individual reason to clear the 0.8 threshold for surfacing.
    const strongPii = pii.reasons.some((r) =>
      r === 'iban-format' || r === 'ssn-format' || r === 'card-number-format' ||
      r === 'phone-number' || r === 'street-en-format' || r === 'street-de-format' ||
      r === 'postal-de-format'
    );
    // Themes count as a strong individual reason (per user spec, Phase 4.1):
    // a single hit on psychology/religion/erotic should be enough to surface.
    const strongTheme = themes.themes.length > 0;
    const totalSignals = pii.reasons.length + themes.themes.length;
    let confidence: number;
    if (strongPii || strongTheme) confidence = 0.85;
    else if (totalSignals >= 2) confidence = 0.82;
    else confidence = 0.55;
    return {
      tier:       'private',
      confidence,
      source:     'auto',
      reasons:    [...pii.reasons, ...themes.themes.map((t) => `theme:${t}`)],
    };
  }

  // 3) No signal → default public, very high confidence.
  return {
    tier:       'public',
    confidence: 1.0,
    source:     'auto',
    reasons:    ['no-sensitive-content'],
  };
}

// ── Whitelist for confirmed access ───────────────────────────────────────────
// In-memory only (intentionally — see doc 8: "Server-Memory only"), keyed by
// itemId, with a 30-minute TTL for `scope: 'session'` and a one-shot for
// `scope: 'once'`. Cleared on bridge restart.

interface WhitelistEntry {
  itemId:    string;
  expiresAt: number;        // epoch ms; 0 = single-use, consumed on first read
}

const _whitelist: Map<string, WhitelistEntry> = new Map();
const SESSION_TTL_MS = 30 * 60 * 1_000;

function addWhitelistEntry(itemId: string, scope: 'once' | 'session'): WhitelistEntry {
  const entry: WhitelistEntry = {
    itemId,
    expiresAt: scope === 'session' ? Date.now() + SESSION_TTL_MS : 0,
  };
  _whitelist.set(itemId, entry);
  return entry;
}

// Returns true and consumes the entry if it's a `once` entry; returns true
// and leaves the entry if it's a session entry that hasn't expired; returns
// false and removes the entry if it has expired.
function checkAndConsumeWhitelist(itemId: string): boolean {
  const entry = _whitelist.get(itemId);
  if (!entry) return false;
  if (entry.expiresAt === 0) {
    // single-use — consume
    _whitelist.delete(itemId);
    return true;
  }
  if (entry.expiresAt < Date.now()) {
    _whitelist.delete(itemId);
    return false;
  }
  return true;
}

// Diagnostic peek (does NOT consume). Used by the status endpoint.
function whitelistSize(): number {
  // Lazy expiry sweep so the count stays accurate without a background timer.
  const now = Date.now();
  for (const [k, v] of _whitelist) {
    if (v.expiresAt !== 0 && v.expiresAt < now) _whitelist.delete(k);
  }
  return _whitelist.size;
}

function clearWhitelist(): void {
  _whitelist.clear();
}

module.exports = {
  // Detection
  pathToDefaultTier,
  detectCredentials,
  detectPersonalInfo,
  detectThemes,
  proposeSensitivity,
  // Whitelist
  addWhitelistEntry,
  checkAndConsumeWhitelist,
  whitelistSize,
  clearWhitelist,
  // Constants
  SESSION_TTL_MS,
};
