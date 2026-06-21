package parsers

// tailscale.go — parser for `tailscale funnel status` (and the
// related `tailscale status` short form). The output is human-readable
// and shaped roughly like:
//
//   # Funnel on:
//   #     - https://your-tailnet.ts.net (Funnel on)
//   #         |-- /  proxy http://127.0.0.1:8443
//
// or, when nothing is shared:
//
//   No Funnel configured.
//
// We extract the public URL + backing target if present.

import (
	"regexp"
	"strings"
)

var (
	reFunnelOff    = regexp.MustCompile(`(?i)\bno funnel\b`)
	reFunnelTarget = regexp.MustCompile(`proxy\s+(http://[^\s]+)`)
	reFunnelHost   = regexp.MustCompile(`(?i)(https://[a-z0-9._-]+\.ts\.net[^\s]*)`)
)

// ParseTailscale returns a Pretty with funnel on/off + target if any.
func ParseTailscale(raw []byte) Pretty {
	body := string(raw)
	out := Pretty{Facts: map[string]string{}}
	if reFunnelOff.MatchString(body) {
		out.Summary = "tailscale funnel: off"
		out.Facts["funnel"] = "off"
		out.Lines = []Line{{Style: StyleMuted, Text: "no funnel configured"}}
		return out
	}
	out.Facts["funnel"] = "on"
	target := ""
	if m := reFunnelTarget.FindStringSubmatch(body); len(m) == 2 {
		target = m[1]
		out.Facts["target"] = target
	}
	host := ""
	if m := reFunnelHost.FindStringSubmatch(body); len(m) == 2 {
		host = m[1]
		out.Facts["host"] = host
	}
	switch {
	case host != "" && target != "":
		out.Summary = "tailscale funnel: " + host + " → " + target
	case host != "":
		out.Summary = "tailscale funnel: " + host
	case target != "":
		out.Summary = "tailscale funnel: → " + target
	default:
		out.Summary = "tailscale funnel: on (target unknown)"
		out.Partial = true
	}
	// Preserve the raw "host on funnel" lines so the operator can still
	// see the full URL list (some configs have more than one).
	for _, l := range strings.Split(body, "\n") {
		trim := strings.TrimSpace(l)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		out.Lines = append(out.Lines, Line{Text: trim})
	}
	return out
}
