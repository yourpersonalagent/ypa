// ── context-rag chunker ───────────────────────────────────────────────────────
// One implementation, two callable shapes:
//
//   chunkSession(session)  — turn-aware. Packs whole user/assistant turns
//                            into ~TARGET-char windows, never splitting a
//                            single turn unless it alone exceeds TARGET.
//                            Carries `turnStart`/`turnEnd` metadata so the
//                            retrieve UI can highlight which messages a hit
//                            came from.
//
//   chunkText(text, meta)  — char-window with overlap. Used for files (one
//                            big string per file) and knowledge entries
//                            (already plaintext).
//
// Why turn-aware sessions: a chat where the user message is 800 chars and the
// assistant reply is 1500 chars is genuinely two distinct semantic units. A
// naive char-window would slice the assistant message at an arbitrary midpoint
// and produce two half-thoughts that neither match by themselves nor blend
// when retrieved.
//
// Targets are deliberately conservative. NIM `nv-embedqa-e5-v5` accepts up to
// 512 tokens (~2k chars); we leave headroom for non-Latin text and tokenizer
// overhead.
'use strict';

const TARGET_CHARS  = 800;
const OVERLAP_CHARS = 100;

interface Chunk {
  index:    number;
  text:     string;
  metadata: Record<string, unknown>;
}

// ── Session chunking ──────────────────────────────────────────────────────────

interface TurnMeta {
  role:  string;
  text:  string;
  ts?:   number;
  /** Original message index in `session.messages[]` — preserved so retrieve
   *  hits can deep-link to the exact turn the chunk came from. */
  msgIndex: number;
}

function _materializeTurn(msg: any, idx: number): TurnMeta | null {
  if (!msg || msg.role === 'note') return null;
  let t: string = msg.text || '';
  if (!t && Array.isArray(msg.blocks)) {
    t = msg.blocks
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.content || '')
      .join(' ');
  }
  t = (t || '').trim();
  if (!t) return null;
  return { role: msg.role, text: t, ts: msg.ts, msgIndex: idx };
}

function chunkSession(session: any): Chunk[] {
  const out: Chunk[] = [];
  const turns: TurnMeta[] = [];
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const turn = _materializeTurn(messages[i], i);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) return out;

  let buffer = '';
  let bufferStart = 0;   // index into `turns` for the first turn in `buffer`
  let chunkIdx = 0;

  const flush = (endTurnIdx: number) => {
    const trimmed = buffer.trim();
    if (!trimmed) return;
    out.push({
      index: chunkIdx++,
      text: trimmed,
      metadata: {
        turnStart:    turns[bufferStart].msgIndex,
        turnEnd:      turns[endTurnIdx].msgIndex,
        turnCount:    endTurnIdx - bufferStart + 1,
        firstRole:    turns[bufferStart].role,
        lastRole:     turns[endTurnIdx].role,
      },
    });
  };

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    const piece = `${turn.role}: ${turn.text}\n\n`;

    if (piece.length > TARGET_CHARS) {
      // Flush whatever is already buffered, then split this oversize turn
      // by char-window.
      if (buffer.trim()) flush(t - 1);
      buffer = '';
      const splits = _splitLongString(piece, TARGET_CHARS, OVERLAP_CHARS);
      for (let s = 0; s < splits.length; s++) {
        out.push({
          index: chunkIdx++,
          text: splits[s].trim(),
          metadata: {
            turnStart:  turn.msgIndex,
            turnEnd:    turn.msgIndex,
            turnCount:  1,
            firstRole:  turn.role,
            lastRole:   turn.role,
            splitPart:  s,
            splitTotal: splits.length,
          },
        });
      }
      bufferStart = t + 1;
      continue;
    }

    if (buffer.length + piece.length > TARGET_CHARS) {
      flush(t - 1);
      buffer = piece;
      bufferStart = t;
    } else {
      buffer += piece;
    }
  }
  if (buffer.trim()) flush(turns.length - 1);
  return out;
}

// ── Plain-text chunking ───────────────────────────────────────────────────────

function chunkText(text: string, meta: Record<string, unknown> = {}): Chunk[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const out: Chunk[] = [];
  let chunkIdx = 0;
  let p = 0;
  while (p < trimmed.length) {
    const end = Math.min(p + TARGET_CHARS, trimmed.length);
    const slice = trimmed.slice(p, end);
    out.push({
      index: chunkIdx++,
      text: slice,
      metadata: { ...meta, charStart: p, charEnd: end },
    });
    if (end === trimmed.length) break;
    p = end - OVERLAP_CHARS;
    if (p <= 0) break; // defensive — only triggers if TARGET <= OVERLAP
  }
  return out;
}

function _splitLongString(s: string, target: number, overlap: number): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < s.length) {
    const end = Math.min(p + target, s.length);
    out.push(s.slice(p, end));
    if (end === s.length) break;
    p = end - overlap;
    if (p <= 0) break;
  }
  return out;
}

export { chunkSession, chunkText, TARGET_CHARS, OVERLAP_CHARS };
export type { Chunk };
