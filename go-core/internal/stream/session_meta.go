package stream

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// LoadSessionWorkingDir reads bridge/sessions/<sid>.json and returns
// the persisted workingDir for the session, or "" when the session
// has none or the file doesn't exist. The route handler consults
// this when the FE didn't supply CWD on the body, so a "this session
// uses /tmp/x" pin survives every turn. Mirrors Node's
// bridge/sessions-internal/index.ts:getSessionCwd lookup.
//
// sessionsDir should be the absolute path to bridge/sessions/. No-op
// on empty inputs so the caller can call unconditionally.
func LoadSessionWorkingDir(sessionsDir, sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	sessionsDir = strings.TrimSpace(sessionsDir)
	if sessionID == "" || sessionsDir == "" {
		return ""
	}
	// Defensive: reject anything with path separators in the session
	// id so a crafted body can't traverse out of the sessions dir.
	if strings.ContainsAny(sessionID, "/\\") || strings.Contains(sessionID, "..") {
		return ""
	}
	path := filepath.Join(sessionsDir, sessionID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var probe struct {
		WorkingDir string `json:"workingDir"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	return strings.TrimSpace(probe.WorkingDir)
}
