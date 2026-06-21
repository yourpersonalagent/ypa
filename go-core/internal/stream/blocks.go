package stream

import "strings"

// BlockAccumulator builds an ordered []PersistBlock from the chunk
// stream so finalize-time persistence can record the rich assistant
// reply (tool-call + thinking + text), not just the flat text.
// Pre-Phase-7 Node tracked these in displaySessions[sid].messages
// via the legacy chat.ts handleChunk; the Go path lost them when
// dispatchHarnessAdapter was reduced to "accumulate Text and POST at
// finalize". Without this, every reload shows a tool-using turn as a
// single text block — no spinner, no tool name, no result.
//
// Not goroutine-safe; callers serialise via emitMu (we accumulate from
// the same emit closure that writes to the SSE response, which is
// already mutex-guarded).
type BlockAccumulator struct {
	blocks []PersistBlock
	// callsByID maps a tool_use ID to the index of its block in the
	// slice so the matching tool_result chunk can stamp its content
	// onto the same entry. Tool calls without a paired result still
	// land in the output (model produced a call, harness errored).
	callsByID map[string]int
	// activeText / activeThinking are indices of the *most recently
	// appended* text / thinking block — we coalesce consecutive
	// deltas of the same kind into one block rather than spawning a
	// new one per chunk. Reset to -1 on any non-matching chunk.
	activeText     int
	activeThinking int
}

// NewBlockAccumulator returns an empty accumulator.
func NewBlockAccumulator() *BlockAccumulator {
	return &BlockAccumulator{
		callsByID:      map[string]int{},
		activeText:     -1,
		activeThinking: -1,
	}
}

// Observe folds one chunk into the running block list. Chunks that
// don't correspond to a renderable block (errors handled separately,
// the _end terminator, heartbeats) are no-ops — the caller can pass
// every emitted chunk through here without filtering.
func (a *BlockAccumulator) Observe(c Chunk) {
	if a == nil {
		return
	}
	switch c.Type {
	case ChunkTypeDelta, ChunkTypeText:
		t := c.Text
		if t == "" {
			t = c.Delta
		}
		if t == "" {
			return
		}
		if a.activeText >= 0 && a.activeText < len(a.blocks) {
			a.blocks[a.activeText].Content += t
		} else {
			a.blocks = append(a.blocks, PersistBlock{Type: "text", Content: t})
			a.activeText = len(a.blocks) - 1
		}
		a.activeThinking = -1
	case ChunkTypeReasoning:
		if c.Reasoning == "" {
			return
		}
		if a.activeThinking >= 0 && a.activeThinking < len(a.blocks) {
			a.blocks[a.activeThinking].Content += c.Reasoning
		} else {
			a.blocks = append(a.blocks, PersistBlock{Type: "thinking", Content: c.Reasoning})
			a.activeThinking = len(a.blocks) - 1
		}
		a.activeText = -1
	case ChunkTypeToolUse:
		if c.ToolUse == nil {
			return
		}
		a.blocks = append(a.blocks, PersistBlock{
			Type:   "tool-call",
			Name:   c.ToolUse.Name,
			Detail: c.ToolUse.Input,
			ToolID: c.ToolUse.ID,
		})
		a.callsByID[c.ToolUse.ID] = len(a.blocks) - 1
		a.activeText = -1
		a.activeThinking = -1
	}
	// Btw blocks live on a separate field from Type (they aren't a
	// model-produced kind — they're user-injected mid-stream notes
	// the bridge broadcasts), so handle them outside the switch.
	// Persisting them with the same chronological position the FE
	// renders them at keeps reload faithful.
	if c.BtwBlock != nil {
		a.blocks = append(a.blocks, PersistBlock{
			Type:     "btw",
			Text:     c.BtwBlock.Text,
			LivePath: c.BtwBlock.LivePath,
		})
		a.activeText = -1
		a.activeThinking = -1
		return
	}
	// Interrupt blocks (disconnect / reconnect notices) — persist
	// them so a reload renders them as standalone styled blocks at
	// their chronological position instead of bleeding the notice
	// text into the model's reply on the FE's text-delta path.
	if c.InterruptBlock != nil {
		a.blocks = append(a.blocks, PersistBlock{
			Type: "interrupt",
			Kind: c.InterruptBlock.Kind,
			Text: c.InterruptBlock.Text,
		})
		a.activeText = -1
		a.activeThinking = -1
		return
	}
	// Re-enter the switch for the remaining chunk kinds we still
	// recognise. (Splitting the original case-block lets us insert
	// the side-channel BtwBlock branch without reshuffling every
	// other case.)
	switch c.Type {
	case ChunkTypeToolResult:
		if c.ToolResult == nil {
			return
		}
		kind := "ok"
		body := c.ToolResult.Content
		if !c.ToolResult.OK {
			kind = "error"
			if c.ToolResult.Error != "" {
				body = c.ToolResult.Error
			}
		}
		// Look up the matching call so we can attach the tool name to
		// the result block. The FE's toolPillHtml renderer reads
		// `name` + `detail` — without the name the icon arrow is the
		// only thing that shows on reload (chat-streaming.ts:975
		// builds live blocks the same way).
		callName := ""
		if idx, ok := a.callsByID[c.ToolResult.ID]; ok && idx >= 0 && idx < len(a.blocks) {
			callName = a.blocks[idx].Name
			a.blocks[idx].Kind = kind // status pip on the call block too
		}
		a.blocks = append(a.blocks, PersistBlock{
			Type:   "tool-result",
			Name:   callName,
			Detail: strings.TrimSpace(body),
			ToolID: c.ToolResult.ID,
			Kind:   kind,
		})
		a.activeText = -1
		a.activeThinking = -1
	}
}

// Blocks returns the accumulated slice. The result is a fresh copy
// so the caller can persist it without racing the still-running
// accumulator (deltas may keep arriving after _end fires on the
// claude-binary path).
func (a *BlockAccumulator) Blocks() []PersistBlock {
	if a == nil || len(a.blocks) == 0 {
		return nil
	}
	out := make([]PersistBlock, len(a.blocks))
	copy(out, a.blocks)
	return out
}

// blocksHaveStructure reports whether the slice carries any non-text
// block (tool-call, tool-result, thinking, btw, interrupt). The live-
// checkpoint loop uses this to decide whether a mid-stream persist MUST
// ship the full blocks array: once a turn has tool calls, a text-only
// checkpoint both clobbers entry.blocks on the bridge (updateLiveMsg
// deletes blocks on a text-only update) and — if the turn is later
// force-finalized by the bridge's live-msg ceiling sweep instead of a
// clean _end — leaves the persisted message with only the flat text,
// dropping the entire tool transcript. That was the "long codex/grok
// reply with tool calls disappears after a while" report.
func blocksHaveStructure(blocks []PersistBlock) bool {
	for _, b := range blocks {
		if b.Type != "" && b.Type != "text" {
			return true
		}
	}
	return false
}

// blocksApproxLen is a cheap byte-size proxy for a blocks slice — it sums
// the variable-length fields without marshalling. The checkpoint throttle
// (shouldLiveCheckpoint) keys its back-off interval off this so a heavy
// tool-result transcript is re-serialized on a size-scaled cadence rather
// than the fast 2s flat-text one.
func blocksApproxLen(blocks []PersistBlock) int {
	n := 0
	for _, b := range blocks {
		n += len(b.Type) + len(b.Content) + len(b.Name) + len(b.Text) + len(b.ToolID) + len(b.Kind) + len(b.LivePath)
		if s, ok := b.Detail.(string); ok {
			n += len(s)
		} else if b.Detail != nil {
			n += 64 // rough constant for a structured detail payload
		}
	}
	return n
}
