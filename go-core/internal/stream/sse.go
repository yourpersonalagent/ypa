package stream

import (
	"bufio"
	"errors"
	"io"
	"strings"
)

// EventStreamReader parses an HTTP SSE response into a sequence of
// (event, data) pairs. The wire format is:
//
//	event: someName\n      (optional)
//	data: line1\n
//	data: line2\n
//	\n                     (blank line — frame terminator)
//
// Multiple data lines accumulate with '\n' between them. Comments (`:`)
// and `id:` / `retry:` lines are ignored.
//
// Provider parsers wrap the response body in NewEventStreamReader and
// loop on Next until io.EOF.
type EventStreamReader struct {
	br *bufio.Reader
}

// NewEventStreamReader is small-buffered (8 KiB) — provider responses
// rarely exceed that per frame.
func NewEventStreamReader(r io.Reader) *EventStreamReader {
	return &EventStreamReader{br: bufio.NewReaderSize(r, 8*1024)}
}

// Event is one parsed SSE frame.
type Event struct {
	Name string // contents of "event:" line, empty if absent
	Data string // joined "data:" lines, blank-trimmed
}

// Next reads frames until one with a non-empty Data field is found,
// then returns it. Empty frames (heartbeats etc.) are skipped silently.
// Returns io.EOF cleanly when the stream closes between frames.
func (r *EventStreamReader) Next() (Event, error) {
	var ev Event
	var data strings.Builder
	for {
		line, err := r.br.ReadString('\n')
		if errors.Is(err, io.EOF) {
			if data.Len() > 0 || ev.Name != "" {
				ev.Data = data.String()
				return ev, nil
			}
			return Event{}, io.EOF
		}
		if err != nil {
			return Event{}, err
		}
		line = strings.TrimRight(line, "\r\n")

		if line == "" {
			// Frame terminator. If we have anything, return it; else
			// continue to the next frame (skip blank-only frames).
			if data.Len() > 0 || ev.Name != "" {
				ev.Data = data.String()
				return ev, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // comment / heartbeat
		}
		field, value := splitField(line)
		switch field {
		case "event":
			ev.Name = value
		case "data":
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(value)
		}
		// "id" and "retry" intentionally ignored — providers don't use
		// them and we don't replay.
	}
}

// splitField splits "key: value" the way the SSE spec mandates: a
// single space after the colon is stripped (but only one).
func splitField(line string) (field, value string) {
	idx := strings.IndexByte(line, ':')
	if idx < 0 {
		return line, ""
	}
	field = line[:idx]
	value = line[idx+1:]
	if strings.HasPrefix(value, " ") {
		value = value[1:]
	}
	return field, value
}
