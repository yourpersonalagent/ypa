// server-greetings — loads bridge/welcomeMsg/*.md once at server start.
// Each .md file is one "special day" with YAML-ish frontmatter
// (name / match / priority) and a body containing one line per hour:
// `HH: message text`. `match` is either "default" (the generic fallback used
// for any non-themed date) or an `MM-DD` fixed date — leap day (02-29) is
// included and naturally only fires in leap years because the calendar
// simply skips it otherwise.
//
// Exposes the parsed catalog at GET /v1/greetings for the frontend
// empty-chat greeting. {name} placeholders are preserved; the frontend
// interpolates the user's first name.
'use strict';

const fs = require('fs');
const path = require('path');

interface HourMap { [hour: string]: string; }
interface GreetingsCatalog {
  generics: HourMap[];
  dates: { [mmdd: string]: HourMap };
}

// Surfaced through GET /v1/greetings so the admin UI can show which files
// failed to load and why — previously these were console-only and invisible
// to anyone running the server in production.
let loadErrors: string[] = [];

// Was bridge/welcomeMsg/ before the welcome-messages module move.
// Now sits next to this file under bridge/modules/welcome-messages/data/.
const WELCOME_DIR = path.join(__dirname, 'data');

let catalog: GreetingsCatalog = { generics: [], dates: {} };
let loaded = false;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta, body: raw };
  const fmText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[m[1]] = val;
  }
  return { meta, body };
}

function parseHours(body: string, fileLabel: string): HourMap {
  const out: HourMap = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    const m = /^(\d{1,2})\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const h = Number(m[1]);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      const err = `${fileLabel}: invalid hour "${m[1]}" — expected 0–23`;
      console.warn(`[greetings] ${err}`);
      loadErrors.push(err);
      continue;
    }
    out[pad2(h)] = m[2].trim();
  }
  return out;
}

function loadGreetings(): void {
  const next: GreetingsCatalog = { generics: [], dates: {} };
  const genericEntries: { priority: number; hours: HourMap }[] = [];
  const priorities: { dates: { [mmdd: string]: number } } = {
    dates: {},
  };
  const dateSourceFile: { [mmdd: string]: string } = {};

  loadErrors = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(WELCOME_DIR).filter((f: string) => f.endsWith('.md'));
  } catch (e) {
    const err = `welcomeMsg/ unreadable: ${(e as Error).message}`;
    console.warn(`[greetings] ${err}`);
    loadErrors.push(err);
    catalog = next;
    loaded = false;
    return;
  }

  for (const f of files) {
    const filePath = path.join(WELCOME_DIR, f);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      const err = `${f}: read failed — ${(e as Error).message}`;
      console.warn(`[greetings] ${err}`);
      loadErrors.push(err);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const match = String(meta.match || meta.date || '').trim();
    if (!match) {
      const err = `${f}: missing 'match' field — skipping`;
      console.warn(`[greetings] ${err}`);
      loadErrors.push(err);
      continue;
    }
    const priority = Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 0;
    const hours = parseHours(body, f);

    if (match === 'default') {
      genericEntries.push({ priority, hours });
      continue;
    }
    if (!/^\d{2}-\d{2}$/.test(match)) {
      const err = `${f}: invalid match "${match}" — expected "default" or "MM-DD"`;
      console.warn(`[greetings] ${err}`);
      loadErrors.push(err);
      continue;
    }
    const prevPrio = priorities.dates[match];
    if (prevPrio === undefined || priority >= prevPrio) {
      if (prevPrio !== undefined) {
        // Higher-priority entry shadowing an earlier one is a deliberate
        // override, but it's surprising when two files at the same priority
        // both target the same MM-DD — the loser is silently lost. Surface it.
        const loser = dateSourceFile[match] || '(prior)';
        const note = priority === prevPrio
          ? `${f}: replaces ${loser} for ${match} at equal priority ${priority} (silent shadow)`
          : `${f}: overrides ${loser} for ${match} (priority ${priority} > ${prevPrio})`;
        console.warn(`[greetings] ${note}`);
        loadErrors.push(note);
      }
      next.dates[match] = hours;
      priorities.dates[match] = priority;
      dateSourceFile[match] = f;
    } else {
      // Current entry loses to an existing higher-priority one. Worth
      // surfacing too so the author can see why their file isn't taking effect.
      const winner = dateSourceFile[match] || '(prior)';
      const note = `${f}: shadowed by ${winner} for ${match} (priority ${priority} < ${prevPrio})`;
      console.warn(`[greetings] ${note}`);
      loadErrors.push(note);
    }
  }

  genericEntries.sort((a, b) => a.priority - b.priority);
  next.generics = genericEntries.map((e) => e.hours);

  catalog = next;
  loaded = true;
  const dateCount = Object.keys(catalog.dates).length;
  console.log(`[greetings] loaded ${catalog.generics.length} generic banks, ${dateCount} themed dates from welcomeMsg/`);
}

function registerGreetingsRoutes(app: any): void {
  if (!loaded) loadGreetings();
  app.get('/v1/greetings', (_req: unknown, res: any) => {
    res.json({
      success: true,
      generics: catalog.generics,
      dates: catalog.dates,
      loadErrors,
    });
  });
  app.post('/v1/greetings/reload', (_req: unknown, res: any) => {
    loadGreetings();
    res.json({
      success: true,
      generics: catalog.generics,
      dates: catalog.dates,
      loadErrors,
    });
  });
}

module.exports = { loadGreetings, registerGreetingsRoutes };
