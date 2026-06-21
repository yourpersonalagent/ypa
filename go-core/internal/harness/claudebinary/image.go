// image.go — encode harness.ImageBlock entries into the wire shape
// the claude binary expects on its stdin user-message frame.
//
// Reference: claude-stream.ts:280-287 — when the FE attaches images,
// the initial JSONL user message has a multi-block content array
// where each image block looks like:
//
//	{
//	  "type": "image",
//	  "source": {
//	    "type": "base64",
//	    "media_type": "image/png",
//	    "data": "<base64 bytes>"
//	  }
//	}
//
// buildInitialStdin already accepts a []map[string]any for image
// blocks; this file just translates harness.ImageBlock → that map
// shape so the route handler can pass it through unchanged.
package claudebinary

import (
	"strings"

	"github.com/yha/core/internal/harness"
)

// BuildImageBlock renders a single ImageBlock into the wire shape.
// Returns nil for empty / invalid input so the caller can filter
// without explicit error handling. MediaType defaults to "image/png"
// when unset — matches how the Node side fell back before the FE
// started always sending the field.
func BuildImageBlock(in harness.ImageBlock) map[string]any {
	data := strings.TrimSpace(in.Base64)
	if data == "" {
		return nil
	}
	mediaType := strings.TrimSpace(in.MediaType)
	if mediaType == "" {
		mediaType = "image/png"
	}
	return map[string]any{
		"type": "image",
		"source": map[string]any{
			"type":       "base64",
			"media_type": mediaType,
			"data":       data,
		},
	}
}
