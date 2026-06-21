// Config-file watcher: re-reads config.json on disk-write events so
// Node-side UI changes propagate into the Go in-memory copy without a
// daemon restart. Debounced (200ms) to coalesce the temp-file+rename
// burst that atomic writers emit.
//
// Boot must not depend on the watcher. fsnotify init can fail for
// unsurprising reasons (file doesn't exist yet, kernel inotify limit
// hit, filesystem doesn't support events) — in those cases the daemon
// logs a warning and continues without auto-reload.
package state

import (
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/yha/core/internal/logger"
)

// configWatchDebounce is how long we wait after the last write event
// before re-reading the file. Atomic writers (state.go atomicWrite,
// Node fs.promises.rename) emit a write + rename pair; 200ms is well
// above the gap between them.
const configWatchDebounce = 200 * time.Millisecond

// ConfigWatcher wraps an fsnotify watcher that reloads s.cfg from disk
// whenever the underlying config.json changes. One per Store; closed
// via Stop on shutdown.
type ConfigWatcher struct {
	store *Store
	log   *logger.Logger

	w        *fsnotify.Watcher
	stopOnce sync.Once
	done     chan struct{}
}

// WatchConfig starts watching the Store's config path. Returns a
// non-nil ConfigWatcher on success; nil + error if fsnotify init or
// the initial Add failed. Callers should treat the error as a warning
// (daemon must still boot) and discard the watcher.
func (s *Store) WatchConfig(log *logger.Logger) (*ConfigWatcher, error) {
	if log == nil {
		log = logger.New(discardWriter{})
	}
	if s.cfgPath == "" {
		return nil, errors.New("state: WatchConfig: empty cfgPath")
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	// Watch the parent directory rather than the file itself: atomic
	// writers rename a new file over the old one, which on inotify
	// detaches the watch from the original inode. Directory-level
	// events let us re-observe the path through every replacement.
	dir := filepath.Dir(s.cfgPath)
	if err := w.Add(dir); err != nil {
		_ = w.Close()
		return nil, err
	}
	cw := &ConfigWatcher{
		store: s,
		log:   log,
		w:     w,
		done:  make(chan struct{}),
	}
	go cw.run()
	return cw, nil
}

// run drives the event loop. Coalesces bursts of write/create events
// against a single debounce timer, then re-reads + swaps under the
// Store's write lock.
func (cw *ConfigWatcher) run() {
	target := cw.store.cfgPath
	var (
		timer    *time.Timer
		timerCh  <-chan time.Time
	)
	schedule := func() {
		if timer == nil {
			timer = time.NewTimer(configWatchDebounce)
		} else {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(configWatchDebounce)
		}
		timerCh = timer.C
	}
	for {
		select {
		case <-cw.done:
			if timer != nil {
				timer.Stop()
			}
			return
		case ev, ok := <-cw.w.Events:
			if !ok {
				return
			}
			// Only care about our specific file. Directory-level watch
			// sees siblings too; ignore them.
			if filepath.Clean(ev.Name) != target {
				continue
			}
			if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename) == 0 {
				continue
			}
			schedule()
		case err, ok := <-cw.w.Errors:
			if !ok {
				return
			}
			cw.log.Warn("state.config.watch error", "err", err)
		case <-timerCh:
			timerCh = nil
			cw.reload()
		}
	}
}

// reload re-reads the config file and atomically swaps it into the
// Store. Errors are logged but the watcher keeps running.
func (cw *ConfigWatcher) reload() {
	newCfg, err := LoadConfig(cw.store.cfgPath)
	if err != nil {
		cw.log.Warn("state.config.reload failed", "path", cw.store.cfgPath, "err", err)
		return
	}
	cw.store.cfgMu.Lock()
	cw.store.cfg = newCfg
	cw.store.cfgMu.Unlock()
	cw.log.Info("state.config.reloaded", "path", cw.store.cfgPath, "providers", len(newCfg.Providers))
}

// Stop terminates the watcher goroutine and releases the underlying
// fsnotify handle. Idempotent.
func (cw *ConfigWatcher) Stop() {
	cw.stopOnce.Do(func() {
		close(cw.done)
		_ = cw.w.Close()
	})
}

// discardWriter is used when WatchConfig is called with a nil logger.
// Keeps this file self-contained so callers don't need to know about
// logger internals.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
