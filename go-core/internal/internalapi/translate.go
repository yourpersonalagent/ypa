package internalapi

import (
	"encoding/base64"
	"strings"
)

// Translation helpers — port of the OpenAI ↔ Anthropic shape converters
// in bridge/chat/openai-internal.ts and bridge/chat/translation.ts.

// OpenAIMessage is the wire shape inbound on /v1/chat/completions.
// Content is permissive: string OR an array of content parts. The
// parser at OpenAIPartsFromContent handles both branches.
type OpenAIMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content,omitempty"`
}

// OpenAIRequest is the inbound body shape. Fields the server reads
// are typed; the rest stays in the trailing map for passthrough.
type OpenAIRequest struct {
	Model       string          `json:"model"`
	Messages    []OpenAIMessage `json:"messages"`
	MaxTokens   *int            `json:"max_tokens,omitempty"`
	Temperature *float64        `json:"temperature,omitempty"`
	TopP        *float64        `json:"top_p,omitempty"`
	Stream      bool            `json:"stream,omitempty"`
	Stop        any             `json:"stop,omitempty"` // string | []string

	// APIKey is the JSON-body fallback for the bearer token (rare in
	// the wild — most clients use Authorization or ?api_key=). Read by
	// ExtractBearer when present.
	APIKey string `json:"api_key,omitempty"`
}

// AnthropicMessage is the per-turn entry of an Anthropic /messages
// request. Role is "user" | "assistant"; content is an array of typed
// blocks the model understands.
type AnthropicMessage struct {
	Role    string             `json:"role"`
	Content []AnthropicContent `json:"content"`
}

// AnthropicContent is one block in an AnthropicMessage. Type discrim
// is "text" | "image"; only one of Text / Source is populated.
type AnthropicContent struct {
	Type   string            `json:"type"`
	Text   string            `json:"text,omitempty"`
	Source *AnthropicImgSrc  `json:"source,omitempty"`
}

// AnthropicImgSrc is the source block of an image content entry.
// Type is "base64" (data URL decoded) or "url" (http(s) URL forwarded
// as-is). MediaType + Data are populated for base64; URL for url.
type AnthropicImgSrc struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type,omitempty"`
	Data      string `json:"data,omitempty"`
	URL       string `json:"url,omitempty"`
}

// AnthropicRequest is the body we POST to provider.endpoint/messages.
// Fields beyond the basics aren't exposed because the JS side doesn't
// translate them either (tool calls noted as TODO at line ~268).
type AnthropicRequest struct {
	Model         string             `json:"model"`
	Messages      []AnthropicMessage `json:"messages"`
	System        string             `json:"system,omitempty"`
	MaxTokens     int                `json:"max_tokens"`
	Temperature   *float64           `json:"temperature,omitempty"`
	TopP          *float64           `json:"top_p,omitempty"`
	StopSequences []string           `json:"stop_sequences,omitempty"`
	Stream        bool               `json:"stream,omitempty"`
}

// OpenAIToAnthropic converts an inbound OpenAI request to an Anthropic
// /messages request. The model id is the resolved unqualified name —
// the caller has already split it. Returns a fully populated request
// the proxy can JSON-marshal.
//
// Translation rules:
//   - System messages are concatenated with "\n\n" and lifted to the
//     top-level `system` field. Filters out empty content.
//   - User/assistant turns are kept; other roles are dropped.
//   - Content parts: string → single text block. Array →
//     iterate; text parts copy through, image_url parts split into
//     base64 (data: URL) or url source. Other types are skipped.
//   - max_tokens defaults to 4096 when absent (line 337 of the TS).
//   - stop string → []string{stop}; stop array → as-is.
func OpenAIToAnthropic(req OpenAIRequest, resolvedModel string) AnthropicRequest {
	var systemParts []string
	out := AnthropicRequest{
		Model:       resolvedModel,
		Stream:      req.Stream,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		MaxTokens:   4096,
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		out.MaxTokens = *req.MaxTokens
	}
	if req.Stop != nil {
		switch v := req.Stop.(type) {
		case string:
			if v != "" {
				out.StopSequences = []string{v}
			}
		case []any:
			for _, s := range v {
				if str, ok := s.(string); ok && str != "" {
					out.StopSequences = append(out.StopSequences, str)
				}
			}
		case []string:
			out.StopSequences = append(out.StopSequences, v...)
		}
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "system":
			text := flattenContent(m.Content)
			if text != "" {
				systemParts = append(systemParts, text)
			}
		case "user", "assistant":
			parts := openaiPartsToAnthropic(m.Content)
			if len(parts) == 0 {
				continue
			}
			out.Messages = append(out.Messages, AnthropicMessage{
				Role:    m.Role,
				Content: parts,
			})
		}
	}
	if len(systemParts) > 0 {
		out.System = strings.Join(systemParts, "\n\n")
	}
	return out
}

// flattenContent reduces a content field (string OR array of typed
// parts) to a single string. Used for system messages where only the
// flat text matters.
func flattenContent(content any) string {
	switch v := content.(type) {
	case string:
		return strings.TrimSpace(v)
	case []any:
		var b strings.Builder
		for _, part := range v {
			obj, ok := part.(map[string]any)
			if !ok {
				continue
			}
			t, _ := obj["type"].(string)
			if t == "text" {
				text, _ := obj["text"].(string)
				if text != "" {
					if b.Len() > 0 {
						b.WriteString("\n")
					}
					b.WriteString(text)
				}
			}
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

// openaiPartsToAnthropic converts a content field for a user/assistant
// turn into the Anthropic content blocks array.
func openaiPartsToAnthropic(content any) []AnthropicContent {
	switch v := content.(type) {
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return nil
		}
		return []AnthropicContent{{Type: "text", Text: text}}
	case []any:
		out := make([]AnthropicContent, 0, len(v))
		for _, part := range v {
			obj, ok := part.(map[string]any)
			if !ok {
				continue
			}
			t, _ := obj["type"].(string)
			switch t {
			case "text":
				text, _ := obj["text"].(string)
				if text != "" {
					out = append(out, AnthropicContent{Type: "text", Text: text})
				}
			case "image_url":
				img, _ := obj["image_url"].(map[string]any)
				if img == nil {
					continue
				}
				url, _ := img["url"].(string)
				if url == "" {
					continue
				}
				if src, ok := dataURLToAnthropicImage(url); ok {
					out = append(out, AnthropicContent{Type: "image", Source: &src})
					continue
				}
				out = append(out, AnthropicContent{
					Type:   "image",
					Source: &AnthropicImgSrc{Type: "url", URL: url},
				})
			}
		}
		return out
	}
	return nil
}

// dataURLToAnthropicImage decodes a "data:image/png;base64,…" URL into
// the Anthropic base64 source block. Returns ok=false for non-data
// URLs so the caller can fall back to the url branch.
func dataURLToAnthropicImage(url string) (AnthropicImgSrc, bool) {
	if !strings.HasPrefix(url, "data:") {
		return AnthropicImgSrc{}, false
	}
	rest := url[len("data:"):]
	semi := strings.Index(rest, ";")
	comma := strings.Index(rest, ",")
	if semi < 0 || comma < 0 || semi >= comma {
		return AnthropicImgSrc{}, false
	}
	media := rest[:semi]
	payload := rest[comma+1:]
	if _, err := base64.StdEncoding.DecodeString(payload); err != nil {
		// Best-effort: don't reject — Anthropic will surface a decode
		// error of its own if the payload truly is bad.
	}
	return AnthropicImgSrc{Type: "base64", MediaType: media, Data: payload}, true
}

// AnthropicStopReasonToOpenAI maps the Anthropic stop_reason field to
// the OpenAI finish_reason shape. Mirrors the JS at line ~376.
func AnthropicStopReasonToOpenAI(reason string) string {
	switch reason {
	case "end_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	default:
		return "stop"
	}
}
