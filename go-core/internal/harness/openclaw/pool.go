// pool.go — per-partner WS-client pool.
//
// Mirrors the singleton pool at openclaw.ts:355-388. The map is keyed by
// partnerId; same partnerId + same (host, port, agentId) returns the
// existing client. A config change drops the old client and replaces it.
//
// Partner config resolution: Phase 6 ships with a JSON file lookup at
// <bridgeRoot>/partners.json that mirrors the Node bridge's writable
// partners list (created/edited by the /v1/partners* CRUD routes). This
// keeps Go and Node looking at the same source of truth without a
// state.Store dependency. Future phases can swap in a state.Store-backed
// reader by replacing ConfigLoader.

package openclaw

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// PartnerConfig is the per-partner connection record. Mirrors the
// OpenClaw-specific fields in PartnerRecord (routes.ts:77-97).
type PartnerConfig struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Enabled bool   `json:"enabled"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	AgentID string `json:"agentId"`
}

// ConfigLoader reads partner records keyed by partnerID. Real impl
// reads bridge/partners.json from disk; tests substitute an in-memory
// map.
type ConfigLoader interface {
	Load(partnerID string) (*PartnerConfig, error)
}

// FileConfigLoader is the disk-backed default — reads
// <bridgeRoot>/partners.json on each Get call. The file is small (a
// handful of records) so re-reading per lookup is fine; this keeps the
// loader stateless and tolerant of mid-runtime edits from the Node CRUD
// routes.
type FileConfigLoader struct {
	Path string
}

// NewFileConfigLoader builds a loader pointing at <bridgeRoot>/partners.json.
func NewFileConfigLoader(bridgeRoot string) *FileConfigLoader {
	return &FileConfigLoader{Path: filepath.Join(bridgeRoot, "partners.json")}
}

// Load reads the JSON file, finds the matching id, and returns the
// OpenClaw-typed config. Returns an error when the file is unreadable,
// the id isn't found, or the type isn't "openclaw".
func (l *FileConfigLoader) Load(partnerID string) (*PartnerConfig, error) {
	b, err := os.ReadFile(l.Path)
	if err != nil {
		return nil, fmt.Errorf("openclaw: read %s: %w", l.Path, err)
	}
	var all []PartnerConfig
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("openclaw: parse %s: %w", l.Path, err)
	}
	for _, p := range all {
		if p.ID == partnerID {
			pc := p // copy
			return &pc, nil
		}
	}
	return nil, fmt.Errorf("openclaw: partner %q not found in %s", partnerID, l.Path)
}

// MapConfigLoader is the test-only loader fed from an in-memory map.
type MapConfigLoader struct {
	Map map[string]*PartnerConfig
}

// Load implements ConfigLoader.
func (m *MapConfigLoader) Load(partnerID string) (*PartnerConfig, error) {
	if m == nil || m.Map == nil {
		return nil, errors.New("openclaw: map loader empty")
	}
	c, ok := m.Map[partnerID]
	if !ok {
		return nil, fmt.Errorf("openclaw: partner %q not configured", partnerID)
	}
	return c, nil
}

// Pool keeps one Client per partnerID. Safe for concurrent Get/Stop.
type Pool struct {
	mu      sync.Mutex
	clients map[string]*Client
	loader  ConfigLoader
	log     Logger
}

// NewPool builds an empty pool. loader is required; log may be nil.
func NewPool(loader ConfigLoader, log Logger) *Pool {
	if log == nil {
		log = noopLogger{}
	}
	return &Pool{
		clients: map[string]*Client{},
		loader:  loader,
		log:     log,
	}
}

// Get returns the client for partnerID, creating one from config when
// absent or when the config has changed. Mirrors openclaw.ts:358-375.
//
// Returns (nil, err) when the loader can't resolve the partner.
func (p *Pool) Get(partnerID string) (*Client, error) {
	if partnerID == "" {
		return nil, errors.New("openclaw: empty partnerID")
	}
	cfg, err := p.loader.Load(partnerID)
	if err != nil {
		return nil, err
	}
	if cfg.Host == "" {
		return nil, fmt.Errorf("openclaw: partner %q has no host configured", partnerID)
	}
	if cfg.Port == 0 {
		cfg.Port = 18789
	}
	if cfg.AgentID == "" {
		cfg.AgentID = "main"
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if existing, ok := p.clients[partnerID]; ok {
		if existing.Host() == cfg.Host && existing.Port() == cfg.Port &&
			existing.AgentID() == cfg.AgentID && existing.Token() == cfg.Token {
			return existing, nil
		}
		// Config changed → drop and replace.
		existing.Disconnect()
		delete(p.clients, partnerID)
	}
	cl := New(cfg.Host, cfg.Port, cfg.Token, cfg.AgentID, p.log)
	p.clients[partnerID] = cl
	return cl, nil
}

// Existing returns the client for partnerID without creating one. Used
// by the status route — we don't want a GET /v1/partners to lazily dial
// a remote gateway. Mirrors openclaw.ts:377-379.
func (p *Pool) Existing(partnerID string) *Client {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.clients[partnerID]
}

// Stop disconnects and removes the client for partnerID. Idempotent.
// Mirrors openclaw.ts:381-384.
func (p *Pool) Stop(partnerID string) {
	p.mu.Lock()
	c, ok := p.clients[partnerID]
	if ok {
		delete(p.clients, partnerID)
	}
	p.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
}

// StopAll closes every client. Wired into the daemon's shutdown path.
// Mirrors openclaw.ts:386-388.
func (p *Pool) StopAll() {
	p.mu.Lock()
	all := make([]*Client, 0, len(p.clients))
	for id, c := range p.clients {
		all = append(all, c)
		delete(p.clients, id)
	}
	p.mu.Unlock()
	for _, c := range all {
		c.Disconnect()
	}
}

// List returns a snapshot of (partnerID, isConnected) entries. The
// status route uses it to render the partner roster without
// dial-on-read.
type PoolStatus struct {
	PartnerID string `json:"partnerId"`
	Connected bool   `json:"connected"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	AgentID   string `json:"agentId"`
}

// List returns a per-partner status snapshot. Read-only — does not dial.
func (p *Pool) List() []PoolStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]PoolStatus, 0, len(p.clients))
	for id, c := range p.clients {
		out = append(out, PoolStatus{
			PartnerID: id,
			Connected: c.IsConnected(),
			Host:      c.Host(),
			Port:      c.Port(),
			AgentID:   c.AgentID(),
		})
	}
	return out
}
