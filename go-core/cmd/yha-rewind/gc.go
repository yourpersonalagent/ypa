// Garbage collection for the rewind CAS. The bridge writes a blob
// before writing the record that references it, so blobs are
// content-addressed but not always immediately referenced. This sweep
// is the equivalent of tools/yha-rewind-gc.mjs running on a timer
// inside the long-lived yha-rewind process — same mark-and-sweep
// algorithm, same safety guards (min-age window for blobs and .tmp.*
// orphans from crashed mid-writes), just so the user doesn't have to
// remember to run the manual script.
//
// Scheduling: a goroutine ticks every YHA_REWIND_GC_INTERVAL (default
// 6h) and applies a sweep. A POST /api/gc endpoint triggers an
// on-demand pass (?dry=1 leaves files untouched). Both routes call
// the same `runGC` so behaviour is identical.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// defaultGCInterval is the cadence the background goroutine sweeps at.
// 6h is long enough that the GC is cheap compared to chat traffic but
// short enough that the disk footprint stays bounded without operator
// intervention. Override via YHA_REWIND_GC_INTERVAL=<duration>.
const defaultGCInterval = 6 * time.Hour

// defaultGCMinAge gives the bridge a buffer to write the JSONL record
// that references a freshly-written blob before the GC could sweep it.
// 5 minutes is generous compared to the JSONL-write latency (sub-ms in
// practice) but cheap in terms of how much disk the buffer pins.
const defaultGCMinAge = 5 * time.Minute

var tmpBlobPattern = regexp.MustCompile(`\.tmp\.\d+\.\d+(\.[0-9a-f]+)?$`)

// gcStats summarises one sweep. Same shape on the HTTP response so
// callers can verify behaviour with `curl -X POST /api/gc?dry=1`.
type gcStats struct {
	Apply         bool   `json:"apply"`
	MinAgeSeconds int64  `json:"min_age_seconds"`
	LiveHashes    int    `json:"live_hashes"`
	Scanned       int    `json:"scanned"`
	Kept          int    `json:"kept"`
	KeptBytes     int64  `json:"kept_bytes"`
	Swept         int    `json:"swept"`
	SweptBytes    int64  `json:"swept_bytes"`
	SweptTmp      int    `json:"swept_tmp"`
	SweptTmpBytes int64  `json:"swept_tmp_bytes"`
	TooYoung      int    `json:"too_young"`
	Errors        int    `json:"errors"`
	DurationMs    int64  `json:"duration_ms"`
	Error         string `json:"error,omitempty"`
}

// runGC executes one mark-and-sweep pass. When apply is false, no
// files are unlinked but the stats reflect what would have been freed.
// minAge bounds how recent a candidate can be before it's spared on
// safety grounds.
func (s *service) runGC(apply bool, minAge time.Duration) gcStats {
	t0 := time.Now()
	stats := gcStats{
		Apply:         apply,
		MinAgeSeconds: int64(minAge / time.Second),
	}

	live, err := collectLiveHashes(s.rewindDir)
	if err != nil {
		stats.Error = err.Error()
		stats.DurationMs = time.Since(t0).Milliseconds()
		return stats
	}
	stats.LiveHashes = len(live)

	entries, err := os.ReadDir(s.blobsDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			stats.DurationMs = time.Since(t0).Milliseconds()
			return stats
		}
		stats.Error = err.Error()
		stats.DurationMs = time.Since(t0).Milliseconds()
		return stats
	}
	cutoff := time.Now().Add(-minAge)

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		stats.Scanned++
		name := e.Name()
		fullPath := filepath.Join(s.blobsDir, name)
		info, err := e.Info()
		if err != nil {
			stats.Errors++
			continue
		}
		// `.tmp.<pid>.<ts>[.<rand>]` files are orphans from crashed
		// mid-writes (writeBlob renames atomically on success). Sweep
		// once they age past the safety window.
		if tmpBlobPattern.MatchString(name) {
			if info.ModTime().After(cutoff) {
				stats.TooYoung++
				continue
			}
			stats.SweptTmp++
			stats.SweptTmpBytes += info.Size()
			if apply {
				if err := os.Remove(fullPath); err != nil {
					stats.Errors++
				}
			}
			continue
		}
		if _, ok := live[name]; ok {
			stats.Kept++
			stats.KeptBytes += info.Size()
			continue
		}
		if info.ModTime().After(cutoff) {
			stats.TooYoung++
			continue
		}
		stats.Swept++
		stats.SweptBytes += info.Size()
		if apply {
			if err := os.Remove(fullPath); err != nil {
				stats.Errors++
			}
		}
	}
	stats.DurationMs = time.Since(t0).Milliseconds()
	return stats
}

// collectLiveHashes builds the union of every blob hash referenced by
// any baseline file or any JSONL record. Matches the algorithm in
// tools/yha-rewind-gc.mjs so the two stay interchangeable.
func collectLiveHashes(rewindDir string) (map[string]struct{}, error) {
	live := map[string]struct{}{}

	baselineDir := filepath.Join(rewindDir, "baselines")
	if entries, err := os.ReadDir(baselineDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(baselineDir, e.Name()))
			if err != nil {
				continue
			}
			var doc struct {
				Files map[string]string `json:"files"`
			}
			if json.Unmarshal(b, &doc) == nil {
				for _, h := range doc.Files {
					if h != "" {
						live[h] = struct{}{}
					}
				}
			}
		}
	}

	if entries, err := os.ReadDir(rewindDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			f, err := os.Open(filepath.Join(rewindDir, e.Name()))
			if err != nil {
				continue
			}
			scan := bufio.NewScanner(f)
			// Per-record allocation cap so a corrupt long line can't
			// crash the GC. 4 MiB is well above realistic record size
			// (a single record carries metadata + hashes, not blob
			// content).
			scan.Buffer(make([]byte, 64*1024), 4*1024*1024)
			for scan.Scan() {
				line := scan.Bytes()
				if len(line) == 0 {
					continue
				}
				var rec struct {
					Files []struct {
						BeforeHash *string `json:"before_hash"`
						AfterHash  *string `json:"after_hash"`
					} `json:"files"`
				}
				if json.Unmarshal(line, &rec) != nil {
					continue
				}
				for _, fl := range rec.Files {
					if fl.BeforeHash != nil && *fl.BeforeHash != "" {
						live[*fl.BeforeHash] = struct{}{}
					}
					if fl.AfterHash != nil && *fl.AfterHash != "" {
						live[*fl.AfterHash] = struct{}{}
					}
				}
			}
			_ = f.Close()
		}
	}

	return live, nil
}

// runScheduledGC kicks off the background sweep goroutine. Cancelling
// ctx stops the ticker; the goroutine exits cleanly without applying a
// final partial sweep.
func (s *service) runScheduledGC(ctx context.Context, interval, minAge time.Duration) {
	if interval <= 0 {
		s.log.Info("scheduled gc disabled (interval<=0)")
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	s.log.Info("scheduled gc armed", "interval", interval.String(), "min_age", minAge.String())
	// Run once shortly after startup so a long-running bridge that
	// accrued blobs between yha-rewind restarts still gets a sweep
	// without waiting a full interval.
	firstFire := time.After(2 * time.Minute)
	for {
		select {
		case <-ctx.Done():
			return
		case <-firstFire:
			s.fireScheduledSweep(minAge)
			firstFire = nil
		case <-t.C:
			s.fireScheduledSweep(minAge)
		}
	}
}

func (s *service) fireScheduledSweep(minAge time.Duration) {
	stats := s.runGC(true, minAge)
	if stats.Error != "" {
		s.log.Warn("scheduled gc error", "err", stats.Error)
		return
	}
	if stats.Swept == 0 && stats.SweptTmp == 0 {
		s.log.Info("scheduled gc — nothing to sweep",
			"scanned", stats.Scanned, "kept", stats.Kept)
		return
	}
	s.log.Info("scheduled gc swept",
		"swept", stats.Swept, "swept_bytes", stats.SweptBytes,
		"swept_tmp", stats.SweptTmp, "swept_tmp_bytes", stats.SweptTmpBytes,
		"kept", stats.Kept, "too_young", stats.TooYoung,
		"duration_ms", stats.DurationMs)
}

// handleGC exposes the same mark-and-sweep over HTTP. `?dry=1` runs in
// dry-run mode; everything else applies. `?min_age=<seconds>` overrides
// the default safety window per call (useful when the bridge is stopped
// and an operator wants to sweep aggressively).
func (s *service) handleGC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	q := r.URL.Query()
	apply := q.Get("dry") != "1"
	minAge := defaultGCMinAge
	if raw := q.Get("min_age"); raw != "" {
		if secs, err := strconv.ParseInt(raw, 10, 64); err == nil && secs >= 0 {
			minAge = time.Duration(secs) * time.Second
		} else {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("bad min_age: %q", raw))
			return
		}
	}
	stats := s.runGC(apply, minAge)
	writeJSON(w, http.StatusOK, stats)
}

// envDuration parses YHA_REWIND_GC_INTERVAL / YHA_REWIND_GC_MIN_AGE
// values as Go duration strings (e.g. "6h", "30m"). Returns fallback
// on missing/invalid input.
func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return fallback
	}
	return d
}
