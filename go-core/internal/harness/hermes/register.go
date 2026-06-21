// register.go — wiring helper for cmd/yha-core/main.go.
//
// Mirrors openclaw.NewDefault / Register so the wiring step has a
// single entry point. Phase 6 keeps everything opt-in via the
// YHA_GO_HERMES=1 env flag, which is checked in main.go.

package hermes

import (
	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
)

// Registrar is the minimal surface this package needs from
// harness.Registry. Mirrors openclaw.Registrar.
type Registrar interface {
	Add(h harness.Harness) error
}

// Register adds the Hermes harness to the framework registry.
// Returns the registry's Add error verbatim.
func Register(reg Registrar, h *Harness) error {
	if h == nil {
		return nil
	}
	return reg.Add(h)
}

// NewDefault builds the canonical wiring: a singleton Gateway pointing
// at the on-disk Hermes install + a Harness on top. The Gateway is
// dormant — it is NOT started here. First SubmitPrompt call (via
// Harness.Stream) lazy-starts the subprocess. Phase 6 contract: opt-in
// only.
//
// bridgeRoot is the path to bridge/ (the writable state directory) and
// is accepted for symmetry with openclaw.NewDefault. The Hermes
// gateway doesn't currently read anything out of it — install location
// is resolved from HERMES_HOME / ~/.hermes — but the parameter keeps
// the constructor signature uniform across partner ports.
//
// log may be nil. When log is non-nil it is plumbed both into the
// gateway's internal logger and into the Harness so log lines pick up
// the caller's With(...) context.
func NewDefault(bridgeRoot string, log *logger.Logger) *Gateway {
	_ = bridgeRoot // reserved for future bridge-state lookups
	var l Logger
	if log != nil {
		l = log
	} else {
		l = noopLogger{}
	}
	return NewGateway(l)
}
