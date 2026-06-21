//go:build !windows

package sysstatus

import (
	"bytes"
	"os"
	"strconv"
)

// ReadProcEnviron returns the environment of pid as a key→value map by
// reading /proc/<pid>/environ. Returns an error if /proc isn't readable
// (containers, restricted procfs, etc.) — callers typically fall back to
// their own process env.
func ReadProcEnviron(pid int) (map[string]string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, 32)
	for _, kv := range bytes.Split(raw, []byte{0}) {
		if len(kv) == 0 {
			continue
		}
		i := bytes.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		out[string(kv[:i])] = string(kv[i+1:])
	}
	return out, nil
}
