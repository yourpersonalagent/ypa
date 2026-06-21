package stream

import (
	"encoding/base64"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// imageMime maps a file extension (lower-case, no dot) to the MIME
// type the FE / model SDKs expect. Mirrors
// bridge/sessions-internal/images.ts IMAGE_MIME exactly so the wire
// shape stays identical between Node and Go.
var imageMime = map[string]string{
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
	"webp": "image/webp",
	"bmp":  "image/bmp",
	"avif": "image/avif",
}

// ResolveImageAttachments walks the FE-supplied Attachments array and
// returns a slice of ImageBlock entries the provider builders can
// render. Each attachment is an arbitrary JSON object the FE shipped;
// we look for `{type: "image", url: "..."}` entries and resolve the
// URL to a local file under uploadsDir or under HOME (matching Node's
// bridge/chat/helpers.ts:appendImageAttachments). Unknown / unreadable
// entries are silently skipped so a single bad attachment doesn't
// nuke the whole turn.
//
// uploadsDir should be the absolute path returned by paths.UploadsDir
// — the function does not call paths itself so the stream package
// stays free of internal/paths import.
func ResolveImageAttachments(uploadsDir string, attachments []any) []ImageBlock {
	if len(attachments) == 0 {
		return nil
	}
	uploadsAbs, _ := filepath.Abs(uploadsDir)
	home := os.Getenv("HOME")
	out := make([]ImageBlock, 0, len(attachments))
	for _, raw := range attachments {
		att, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if t, _ := att["type"].(string); t != "image" {
			continue
		}
		// Pre-decoded inline entry (from ExtractInlineImageBlocks).
		if b, ok := att["base64"].(string); ok && b != "" {
			mt, _ := att["mediaType"].(string)
			if mt == "" {
				mt = "image/jpeg"
			}
			out = append(out, ImageBlock{MediaType: mt, Base64: b})
			continue
		}
		rawURL, _ := att["url"].(string)
		if rawURL == "" {
			continue
		}
		path := resolveLocalImageURL(rawURL, uploadsAbs, home)
		if path == "" {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
		mime, ok := imageMime[ext]
		if !ok {
			mime = "image/jpeg"
		}
		out = append(out, ImageBlock{
			MediaType: mime,
			Base64:    base64.StdEncoding.EncodeToString(data),
		})
	}
	return out
}

// markdownImageRe matches `![alt](url)` Markdown image references with
// no whitespace in the url. Mirrors Node's
// bridge/sessions-internal/images.ts:extractImageBlocks regex.
var markdownImageRe = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)

// ExtractInlineImageBlocks walks the prompt text, finds every
// `![alt](url)` reference whose URL resolves to a local upload (under
// uploadsDir or HOME), reads the file as base64, and returns the
// rewritten prompt (with `[Image: <alt>]` placeholders) plus the
// extracted ImageBlock entries. Mirrors Node's
// bridge/sessions-internal/images.ts:extractImageBlocks.
//
// Used by the route handler so a prompt that pasted an image inline
// (Obsidian-style ![](/uploads/...)) shows up as a real attachment to
// the model. uploadsDir / home are the same anchors the JSON
// Attachments path uses.
func ExtractInlineImageBlocks(uploadsDir, prompt string) (string, []ImageBlock) {
	if strings.TrimSpace(prompt) == "" || strings.TrimSpace(uploadsDir) == "" {
		return prompt, nil
	}
	uploadsAbs, _ := filepath.Abs(uploadsDir)
	home := os.Getenv("HOME")
	var blocks []ImageBlock
	rewritten := markdownImageRe.ReplaceAllStringFunc(prompt, func(match string) string {
		sub := markdownImageRe.FindStringSubmatch(match)
		if sub == nil {
			return match
		}
		alt := sub[1]
		rawURL := sub[2]
		path := resolveLocalImageURL(rawURL, uploadsAbs, home)
		if path == "" {
			return match
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return match
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
		mime, ok := imageMime[ext]
		if !ok {
			mime = "image/jpeg"
		}
		blocks = append(blocks, ImageBlock{
			MediaType: mime,
			Base64:    base64.StdEncoding.EncodeToString(data),
		})
		if alt != "" {
			return "[Image: " + alt + "]"
		}
		return "[Image]"
	})
	return rewritten, blocks
}

// resolveLocalImageURL maps the FE-uploaded URL back to an absolute
// path on disk. Accepts:
//
//   - https://host/uploads/<rel>      → uploadsAbs/<rel>
//   - /uploads/<rel>                  → uploadsAbs/<rel>
//   - /absolute/path/inside/HOME      → as-is (file browser attach)
//   - /absolute/path/inside/uploads   → as-is
//
// Returns "" when the resolved path escapes the allowed roots (path
// traversal guard) or the input doesn't match any of the above
// shapes. Mirrors bridge/sessions-internal/images.ts:resolveLocalImageUrl.
func resolveLocalImageURL(raw, uploadsAbs, home string) string {
	if uploadsAbs == "" {
		return ""
	}
	if u, err := url.Parse(raw); err == nil && u.Path != "" && strings.HasPrefix(u.Path, "/uploads/") {
		rel := strings.TrimPrefix(u.Path, "/uploads/")
		candidate := filepath.Join(uploadsAbs, rel)
		abs, err := filepath.Abs(candidate)
		if err != nil {
			return ""
		}
		if strings.HasPrefix(abs, uploadsAbs+string(filepath.Separator)) || abs == uploadsAbs {
			return abs
		}
		return ""
	}
	if strings.HasPrefix(raw, "/") {
		abs, err := filepath.Abs(raw)
		if err != nil {
			return ""
		}
		if strings.HasPrefix(abs, uploadsAbs+string(filepath.Separator)) || abs == uploadsAbs {
			return abs
		}
		if home != "" {
			homeAbs, _ := filepath.Abs(home)
			if homeAbs != "" && strings.HasPrefix(abs, homeAbs+string(filepath.Separator)) {
				return abs
			}
		}
	}
	return ""
}
