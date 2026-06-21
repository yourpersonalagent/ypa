// Forward-mention chain — Go port of bridge/modules/multichat-broadcast/
// forward.ts.
//
// When a participant's reply begins with `@otherParticipant`, the
// remainder is re-dispatched to that participant as if the user had
// sent it directly. Hop count is bounded by config.defaults
// .partnerForwardLimit (default 25, clamped [1, 200]) so we have an
// upper bound; the manual stop button is the primary loop guard
// (route handler aborts the in-flight reply via activeProcesses.killFn).
//
// All forwarded employees share a single chainHistoryId so each
// downstream forward sees the previous one's reply in its history
// fork. The first turn's history (i.e. the pre-fork user-visible
// transcript) is NOT loaded here — Node owns that and the runner's
// in-memory chain is the only state for now.

package broadcast

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/yha/core/internal/stream"
)

// DefaultForwardLimit mirrors Node's config.defaults
// .partnerForwardLimit default. The clamp range matches forward.ts:
// values < 1 fall back to 25; values > 200 saturate at 200.
const DefaultForwardLimit = 25

// ForwardLimitMax is the saturation ceiling for ForwardLimit. Mirrors
// Math.min(limitRaw, 200) in forward.ts. Exposed for tests.
const ForwardLimitMax = 200

// ClampForwardLimit normalises an arbitrary FE-supplied limit into
// the valid [1, 200] range, with a fallback of DefaultForwardLimit
// for non-positive or out-of-band values.
func ClampForwardLimit(raw int) int {
	if raw < 1 {
		return DefaultForwardLimit
	}
	if raw > ForwardLimitMax {
		return ForwardLimitMax
	}
	return raw
}

var forwardMentionPattern = regexp.MustCompile(`(?i)^@([a-z0-9_-]+)\s*`)

// ForwardChain runs the mention-forward loop. participants is the
// session's participant list (used to validate that the @target is a
// current participant). seedText is the first reply text (typically
// the broadcast-leader's reply); when it begins with `@name`, the
// remainder is dispatched to that participant; their reply is then
// re-checked for a leading `@name`, and so on, until:
//
//   - no leading mention found
//   - hop count reaches limit
//   - ctx is cancelled
//   - dispatched employee returns empty text
//
// emit is the outer ChunkEmitter (same one the per-employee runner
// uses). The runner emits a `mentionForward` info chunk (encoded via
// stream.Chunk.Reasoning, "mention-forward\thop\tlimit\ttargetID\ttargetName")
// each hop so the FE can render the chain UI.
//
// Returns total hop count + summed cost across hops.
func (r *Runner) ForwardChain(
	ctx context.Context,
	participants []string,
	seedText string,
	base Request,
	emit ChunkEmitter,
	limit int,
) (ForwardResult, error) {
	if r == nil {
		return ForwardResult{}, fmt.Errorf("broadcast: nil Runner")
	}
	if r.Employees == nil {
		return ForwardResult{}, fmt.Errorf("broadcast: Runner.Employees is required")
	}
	if emit == nil {
		emit = func(stream.Chunk) {}
	}
	if r.Now == nil {
		// runOne reads this; cover the case where ForwardChain is
		// called without RunChain having initialised it.
		// (No-op if already set.)
	}
	clamped := ClampForwardLimit(limit)
	out := ForwardResult{Limit: clamped}

	if len(participants) == 0 {
		return out, nil
	}
	participantSet := make(map[string]struct{}, len(participants))
	for _, id := range participants {
		participantSet[strings.ToLower(strings.TrimSpace(id))] = struct{}{}
	}

	// Shared history id for the whole forward chain so each forwarded
	// participant's history fork includes the previous reply.
	// Per-employee history persistence is Node-owned today; this id
	// is therefore informational (it flows into harness.Request
	// .HistorySessionID but no Go-side resolver writes to it yet).
	chainID := fmt.Sprintf("%s::fwd::%d", base.SessionID, nowNano(r))

	lastReply := seedText
	for {
		if err := ctx.Err(); err != nil {
			out.Err = err
			return out, err
		}
		if out.Hops >= clamped {
			break
		}
		target, clean := parseLeadingMention(lastReply, participantSet)
		if target == "" {
			break
		}
		rec, err := r.Employees.Load(target)
		if err != nil {
			out.Err = fmt.Errorf("broadcast: forward load %q: %w", target, err)
			return out, out.Err
		}
		if rec == nil {
			break
		}
		out.Hops++

		// Hop info chunk — typed Author payload identifies the forward
		// hop's target so the FE can render the chain visually without
		// substring-parsing the legacy `mention-forward\tN\t...`
		// reasoning string. The reasoning string is kept in parallel
		// for one release; drop it after the FE ships the typed reader.
		emit(stream.Chunk{
			Type:      stream.ChunkTypeReasoning,
			Reasoning: fmt.Sprintf("mention-forward\t%d\t%d\t%s\t%s", out.Hops, clamped, rec.ID, rec.Name),
			Author: &stream.Author{
				ID:          rec.ID,
				Name:        rec.Name,
				Role:        rec.Role,
				SymbolColor: rec.SymbolColor,
				Hop:         fmt.Sprintf("mention-forward:%d/%d", out.Hops, clamped),
			},
		})

		hopBase := base
		hopBase.Input = clean

		historyID := fmt.Sprintf("%s::%d::%s", chainID, out.Hops, rec.ID)
		res := r.runOne(ctx, rec, hopBase, historyID, emit, "" /* untagged: forward chain is sequential */)
		out.PerHop = append(out.PerHop, res)
		out.TotalUsage.InputTokens += res.Usage.InputTokens
		out.TotalUsage.OutputTokens += res.Usage.OutputTokens
		out.TotalUsage.CacheRead += res.Usage.CacheRead
		out.TotalUsage.CacheCreation += res.Usage.CacheCreation
		out.TotalUsage.Cost += res.Usage.Cost

		if res.Err != nil {
			out.Err = res.Err
			return out, res.Err
		}
		lastReply = res.Text
		if strings.TrimSpace(lastReply) == "" {
			break
		}
	}
	return out, nil
}

// ForwardResult is the aggregate ForwardChain returns. Hops is the
// number of forwards that actually ran (≤ Limit). PerHop contains
// one entry per hop in dispatch order; TotalUsage sums usage across
// hops. Err is populated on chain-aborting failures (loader error,
// ctx cancellation, runOne returning a hard error).
type ForwardResult struct {
	Hops       int
	Limit      int
	PerHop     []EmployeeResult
	TotalUsage struct {
		InputTokens   int64
		OutputTokens  int64
		CacheRead     int64
		CacheCreation int64
		Cost          float64
	}
	Err error
}

// parseLeadingMention is the Go port of parseLeadingMentionToParticipant
// in bridge/chat/helpers.ts, scoped to the runner's needs.
//
// Returns:
//   - target — the lowercase participant id the mention targets, or ""
//     if no leading mention was found / the target isn't a participant.
//   - clean  — the reply text with the leading mention stripped (or
//     the trimmed original when stripping would yield empty text).
func parseLeadingMention(text string, participantSet map[string]struct{}) (string, string) {
	trimmed := strings.TrimLeft(text, " \t\r\n")
	match := forwardMentionPattern.FindStringSubmatch(trimmed)
	if len(match) < 2 {
		return "", ""
	}
	token := strings.ToLower(strings.TrimSpace(match[1]))
	if _, ok := participantSet[token]; !ok {
		return "", ""
	}
	remainder := strings.TrimSpace(trimmed[len(match[0]):])
	if remainder == "" {
		remainder = strings.TrimSpace(trimmed)
	}
	return token, remainder
}

// nowNano returns the runner's clock as a nanosecond unix timestamp.
// Falls back to a 0 sentinel when r.Now is nil — chain ids stay
// deterministic across calls in that case (tests can detect the
// constant 0 and assert on it).
func nowNano(r *Runner) int64 {
	if r == nil || r.Now == nil {
		return 0
	}
	return r.Now().UnixNano()
}
