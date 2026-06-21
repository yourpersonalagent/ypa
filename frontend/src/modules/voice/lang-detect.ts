// Lightweight language detection. No deps, ~80 lines.
//
// Strategy:
//   1. Script detection by Unicode range (CJK, Cyrillic, Arabic, Hebrew, etc.)
//      — these are unambiguous so we return immediately.
//   2. For Latin script, score by stopword + diacritic frequency across the
//      languages we care about (en, de, fr, es, it, pt, nl). Best score wins.
//
// Returns BCP-47 base codes ('en', 'de', 'fr', …) — caller maps to a voice.

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'on', 'this', 'but', 'are', 'was', 'you', 'have', 'be', 'not', 'as'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'wir', 'ihr', 'sie', 'mit', 'auf', 'für', 'auch', 'eine', 'einen', 'einer', 'dass', 'wenn', 'aber', 'noch', 'sind', 'hat', 'haben', 'wurde', 'sein', 'kann', 'man'],
  fr: ['le', 'la', 'les', 'de', 'du', 'des', 'et', 'est', 'un', 'une', 'que', 'qui', 'dans', 'pour', 'pas', 'plus', 'avec', 'sur', 'mais', 'ne', 'je', 'nous', 'vous', 'ils', 'elles', 'avoir', 'être'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'lo', 'su', 'al', 'del', 'pero', 'más', 'como', 'hay', 'ser', 'está'],
  it: ['il', 'la', 'le', 'gli', 'di', 'che', 'e', 'è', 'un', 'una', 'per', 'con', 'non', 'sono', 'come', 'più', 'ma', 'anche', 'questo', 'sul', 'della', 'dello'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'é', 'um', 'uma', 'para', 'com', 'não', 'no', 'na', 'do', 'da', 'dos', 'das', 'em', 'por', 'mais', 'mas', 'são'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'in', 'op', 'dat', 'die', 'niet', 'voor', 'met', 'aan', 'als', 'maar', 'ook', 'naar', 'uit', 'door', 'wij', 'jij', 'zij']
};

// Distinctive characters per language — strong signal even with very short text.
const DIACRITIC_HINTS: { lang: string; chars: RegExp; weight: number }[] = [
  { lang: 'de', chars: /[äöüÄÖÜß]/g, weight: 3 },
  { lang: 'fr', chars: /[àâçéèêëîïôûùÿœæ]/gi, weight: 2 },
  { lang: 'es', chars: /[ñáíóú¿¡]/gi, weight: 3 },
  { lang: 'pt', chars: /[ãõçáéíóúâêô]/gi, weight: 2 },
  { lang: 'it', chars: /[àèéìíîòóùú]/gi, weight: 1.5 },
  { lang: 'nl', chars: /[ëïĳ]/gi, weight: 2 }
];

export function detectLang(text: string, fallback = 'en'): string {
  const t = (text || '').trim();
  if (!t) return fallback;

  // 1. Script-based detection (Unicode ranges).
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[぀-ゟ゠-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[؀-ۿ]/.test(t)) return 'ar';
  if (/[֐-׿]/.test(t)) return 'he';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';

  // 2. Latin-script scoring.
  const lower = t.toLowerCase();
  const tokens = lower.split(/[^a-zà-ÿäöüß]+/).filter(Boolean);
  if (tokens.length === 0) return fallback;

  const scores: Record<string, number> = {};
  for (const lang of Object.keys(STOPWORDS)) scores[lang] = 0;

  // Stopword hits.
  for (const tok of tokens) {
    for (const lang of Object.keys(STOPWORDS)) {
      if (STOPWORDS[lang]!.includes(tok)) scores[lang] = (scores[lang] ?? 0) + 1;
    }
  }

  // Diacritic hits.
  for (const hint of DIACRITIC_HINTS) {
    const m = t.match(hint.chars);
    if (m) scores[hint.lang] = (scores[hint.lang] ?? 0) + m.length * hint.weight;
  }

  // Pick best — but require a minimum signal, otherwise fall back.
  let bestLang = fallback;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestLang = lang; }
  }
  // Need at least 2 hits in tokens shorter than 6 words, else fall back.
  if (bestScore < 1 || (tokens.length < 6 && bestScore < 2)) return fallback;
  return bestLang;
}

// Pick the best speechSynthesis voice for a given BCP-47 base code.
// Prefers Microsoft (Edge ships high-quality neural voices), then Google,
// then any voice whose lang starts with the requested code.
export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  if (!matches.length) {
    // Fallback to any default voice.
    return voices.find((v) => v.default) || voices[0] || null;
  }
  return matches.find((v) => /Microsoft/i.test(v.name))
    || matches.find((v) => /Google/i.test(v.name))
    || matches.find((v) => v.default)
    || matches[0]!;
}

// BCP-47 region tag for STT (e.g. 'de' → 'de-DE'). Falls back to navigator.language
// if it matches the requested base, otherwise picks a sensible default region.
export function langToBCP47(lang: string): string {
  const navLang = navigator.language || 'en-US';
  if (navLang.toLowerCase().startsWith(lang.toLowerCase())) return navLang;
  const map: Record<string, string> = {
    en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT',
    pt: 'pt-PT', nl: 'nl-NL', ru: 'ru-RU', zh: 'zh-CN', ja: 'ja-JP',
    ko: 'ko-KR', ar: 'ar-SA', he: 'he-IL', th: 'th-TH', hi: 'hi-IN'
  };
  return map[lang] || (lang + '-' + lang.toUpperCase());
}
