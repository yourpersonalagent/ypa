// Package logger is the structured-JSON logger used across yha-core.
//
// Mirrors bridge/core/logger.ts: timestamp, level, msg, fields. Output
// is one JSON object per line, written to the io.Writer passed to New.
//
// Use With(...) to add context that should appear on every subsequent
// log line. Levels are debug < info < warn < error; the threshold is
// read from YHA_LOG_LEVEL (default: info).
package logger

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func parseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

type Logger struct {
	w      io.Writer
	mu     *sync.Mutex
	level  Level
	fields []any
}

func New(w io.Writer) *Logger {
	return &Logger{
		w:     w,
		mu:    &sync.Mutex{},
		level: parseLevel(os.Getenv("YHA_LOG_LEVEL")),
	}
}

func (l *Logger) With(fields ...any) *Logger {
	merged := make([]any, 0, len(l.fields)+len(fields))
	merged = append(merged, l.fields...)
	merged = append(merged, fields...)
	return &Logger{w: l.w, mu: l.mu, level: l.level, fields: merged}
}

func (l *Logger) Debug(msg string, fields ...any) { l.log(LevelDebug, "debug", msg, fields) }
func (l *Logger) Info(msg string, fields ...any)  { l.log(LevelInfo, "info", msg, fields) }
func (l *Logger) Warn(msg string, fields ...any)  { l.log(LevelWarn, "warn", msg, fields) }
func (l *Logger) Error(msg string, fields ...any) { l.log(LevelError, "error", msg, fields) }

func (l *Logger) log(lvl Level, label, msg string, fields []any) {
	if lvl < l.level {
		return
	}
	rec := map[string]any{
		"ts":    time.Now().UTC().Format(time.RFC3339Nano),
		"level": label,
		"msg":   msg,
	}
	mergeFields(rec, l.fields)
	mergeFields(rec, fields)

	l.mu.Lock()
	defer l.mu.Unlock()
	enc := json.NewEncoder(l.w)
	_ = enc.Encode(rec)
}

func mergeFields(into map[string]any, kv []any) {
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			continue
		}
		// Errors don't serialise meaningfully through encoding/json
		// (most have unexported fields). Stringify so the log line
		// actually contains the message.
		if e, isErr := kv[i+1].(error); isErr && kv[i+1] != nil {
			into[key] = e.Error()
			continue
		}
		into[key] = kv[i+1]
	}
}
