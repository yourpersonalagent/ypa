// yha-core is the Go front door for the YHA bridge.
//
// Phase 1 — listens on YHA_CORE_PORT and reverse-proxies everything to
// the Node bridge at YHA_NODE_URL. Later phases absorb routes natively
// (auth in 2a/2b, MCP in 2c, tools in 2c).
//
// Phase 2b — auth.Gate classifies every request and tags X-Yha-Auth on
// the response. It enforces (rejects unauth/restricted) by default and is
// only downgraded to advisory mode when YHA_GO_AUTH_ENFORCE=0 is set. The
// gate's session lookup goes through Node's POST /internal/whoami endpoint,
// which requires SESSION_SECRET + YHA_INTERNAL_KEY in the environment.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yha/core/internal/auth"
	"github.com/yha/core/internal/embeddedmcp"
	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/harness/claudebinary"
	claudesdkh "github.com/yha/core/internal/harness/claudesdk"
	codexh "github.com/yha/core/internal/harness/codex"
	grokbuildh "github.com/yha/core/internal/harness/grokbuild"
	grokacph   "github.com/yha/core/internal/harness/grokacp"
	hermesh "github.com/yha/core/internal/harness/hermes"
	openclawh "github.com/yha/core/internal/harness/openclaw"
	"github.com/yha/core/internal/internalapi"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/mcp"
	"github.com/yha/core/internal/metrics"
	"github.com/yha/core/internal/nodecallback"
	"github.com/yha/core/internal/partnersapi"
	"github.com/yha/core/internal/paths"
	"github.com/yha/core/internal/rate"
	"github.com/yha/core/internal/rawlog"
	"github.com/yha/core/internal/server"
	"github.com/yha/core/internal/state"
	"github.com/yha/core/internal/stream"
	"github.com/yha/core/internal/stream/broadcast"
	"github.com/yha/core/internal/tools"
)

// defaultDrainTimeout is the default budget given to in-flight requests
// when SIGUSR2 (graceful drain) lands. Override with
// YHA_DRAIN_TIMEOUT_SECONDS. The companion blue-green orchestrator
// (./yha.sh go-reload) waits at least this long before declaring the
// old process stuck.
const defaultDrainTimeout = 30 * time.Second

// In go-mode (./yha.sh dev): Go is the front door on :8443 (Tailscale
// Funnel target) and Node moves to :8442 as private upstream. yha.sh
// passes the right --port + --node-url; these defaults match that
// layout when the binary is invoked directly.
const defaultPort = "8443"
const defaultNodeURL = "http://127.0.0.1:8442"

// version is the canonical project version. Injected at build time via
// -ldflags "-X main.version=$(VERSION)" by yha.ps1; defaults to "dev" for a
// plain `go build` / `go run`. Printed by `yha-core --version`. Single source
// of truth is the repo-root VERSION file — see AGENTS.md.
var version = "dev"

func main() {
	var (
		flagPort    = flag.String("port", envOr("YHA_CORE_PORT", defaultPort), "port to listen on")
		flagNodeURL = flag.String("node-url", envOr("YHA_NODE_URL", defaultNodeURL), "Node bridge upstream URL")
		flagSocket  = flag.String("socket", os.Getenv("YHA_CORE_SOCKET"), "optional Unix socket path (overrides --port if set)")
		flagVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *flagVersion {
		fmt.Println(version)
		return
	}

	log := logger.New(os.Stderr).With("bin", "yha-core")

	// One root context for the whole daemon — autostart, shutdown,
	// and any in-flight goroutines all hang off this.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// SIGUSR2 = graceful drain (Phase 4 blue-green). Triggered by
	// `./yha.sh go-reload` (or `pm2 reload YHA-Core`, which sends
	// SIGUSR2 by default). Distinct from INT/TERM so the new binary
	// can come up under SO_REUSEPORT, and only THEN we drain the old.
	// Windows has no SIGUSR2 and no SO_REUSEPORT — drain context is
	// never canceled there (drainCtx.Done() never fires).
	drainCtx, drainNotify := notifyDrainSignal(context.Background())
	defer drainNotify()

	// SIGUSR1 = non-destructive goroutine dump (diagnostic). Writes all
	// goroutine stacks to a timestamped file so a live deadlock (e.g. the
	// codex stdout-consumer wedge) can be pinned without crashing the
	// daemon the way Go's built-in SIGQUIT dump would. See
	// goroutinedump_unix.go.
	installGoroutineDump(filepath.Join(paths.BridgeRoot(), "go-core-debug"), log)

	reusePort := os.Getenv("YHA_REUSEPORT") == "1"
	drainTimeout := defaultDrainTimeout
	if v := os.Getenv("YHA_DRAIN_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			drainTimeout = time.Duration(n) * time.Second
		}
	}

	log.Info("starting",
		"port", *flagPort,
		"node_url", *flagNodeURL,
		"socket", *flagSocket,
		"bridge_root", paths.BridgeRoot(),
		"reuse_port", reusePort,
		"drain_timeout", drainTimeout.String(),
		"pid", os.Getpid(),
	)

	// Phase 2a state: load config.json, resolve BRIDGE_INTERNAL_KEY
	// (prefers YHA_BRIDGE_KEY env so Node + Go agree; logs a Warn and
	// generates an ephemeral key when the env is unset).
	store, err := state.NewStore(state.ResolveConfigPath(paths.BridgeRoot()), log)
	if err != nil {
		log.Error("state.NewStore failed", "err", err)
		os.Exit(1)
	}
	log.Info("state loaded",
		"providers", len(store.Config().Providers),
		"bridge_internal_key", store.BridgeInternalKey()[:18]+"…",
	)

	// Watch config.json for Node-side writes so changes (API keys,
	// rate limits, defaults) land in the Go in-memory copy without a
	// daemon restart. Best-effort: if fsnotify init fails (e.g. inotify
	// limit hit, watcher not supported on this fs) the daemon still
	// boots and serves with the snapshot loaded above.
	if cw, werr := store.WatchConfig(log); werr != nil {
		log.Warn("state.config watcher disabled", "err", werr)
	} else {
		defer cw.Stop()
		log.Info("state.config watcher armed", "path", state.ResolveConfigPath(paths.BridgeRoot()))
	}

	// Phase 2a rate: per-provider buckets seeded from config.defaults.rateLimit.
	// Wired into the stream loop via RouteDeps.Limiter so every outbound
	// httpClient.Do for the direct-API path passes through the per-provider
	// token bucket + concurrency cap + 429 retry behaviour.
	limiter := rate.NewLimiter(
		rate.Config{RPM: 60, Concurrency: 1},
		rateConfigFromStore(store),
	)
	limiterAdapter := streamLimiterAdapter{l: limiter}

	// Phase 4 metrics: collector lives for the daemon's lifetime; the
	// HTTP middleware records request_count + request_latency_ms by
	// (route, method, status). Subsystem hooks (mcp pool, tools exec,
	// stream loop) attach the same collector via Recorder so each
	// emits its own per-tool / per-provider counters and histograms.
	collector := metrics.NewCollector()

	// Phase 2c MCP: spawn pool, expose /v1/mcp/* control plane natively.
	//
	// Autostart is OPT-IN via YHA_MCP_AUTOSTART=1 because the Node bridge
	// is currently the source of truth — running both autostarts would
	// produce duplicate child processes for every server in mcp-state.json.
	// Phase 2d flips this default once Node hands MCP ownership over.
	pool := mcp.NewPool(log)
	pool.SetRecorder(collector) // hooks mcp_call_* metrics on every Call.
	defer pool.StopAll()
	if os.Getenv("YHA_MCP_AUTOSTART") == "1" {
		asCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := mcp.Autostart(asCtx, pool, paths.MCPRegistry(), paths.MCPState(), 10*time.Second, log); err != nil {
			log.Warn("mcp.autostart", "err", err)
		}
		cancel()
	} else {
		log.Info("mcp pool ready (autostart disabled)",
			"hint", "set YHA_MCP_AUTOSTART=1 to spawn servers in mcp-state.json on boot",
		)
	}

	// Phase 2d auth: Go owns sessions + OAuth flow. Falls back to the
	// Phase 2b advisory gate (Node /internal/whoami lookup) when the
	// session store can't be initialised — typically because
	// SESSION_SECRET is missing.
	gate, sessionStore, workosClient, authMode, authStoreDir := buildAuthGateV2(*flagNodeURL, log)

	// §8.7 — handoff sender closure populated by the BeforeProxy block
	// once streamBuffer is constructed. SIGUSR2 reads this to flush
	// in-flight session tails to the new binary before Shutdown. nil
	// when handoff was never wired (legacy / tests).
	var handoffSendFn func(socket string, timeout time.Duration) (sessions, chunks int, err error)

	// Direct-to-SQLite finalize writer (phase="final"). Opened inside
	// BeforeProxy below but declared here so its Close() defers at main()
	// return — i.e. the whole process lifetime — instead of when the
	// BeforeProxy setup callback returns. A defer *inside* BeforeProxy closed
	// the *sql.DB moments after boot, leaving a closed handle in RouteDeps, so
	// every phase="final" write failed with "sql: database is closed" and
	// assistant turns persisted inputTokens:0/outputTokens:0 (blank final meta
	// bar on reload/switch). Registered first → runs last (after srv shutdown).
	var sqliteFinalizer *stream.SQLiteFinalizer
	defer func() {
		if sqliteFinalizer != nil {
			if cerr := sqliteFinalizer.Close(); cerr != nil {
				log.Warn("stream.sqlite-finalizer.close-failed", "err", cerr.Error())
			}
		}
	}()

	// Fail-closed bind host. When WorkOS auth is disabled, auth.Classify()
	// passes every request, so binding the TCP front door to all interfaces
	// would expose an unauthenticated daemon. Restrict to loopback in that
	// case unless the operator explicitly opts in via YHA_GO_BIND_HOST.
	bindHost := goBindHost(auth.FromEnv().Enabled())
	if !auth.FromEnv().Enabled() && os.Getenv("YHA_GO_BIND_HOST") == "" {
		log.Warn("WorkOS auth disabled — binding go-core to loopback only (set YHA_GO_BIND_HOST to override)", "host", bindHost)
	}

	cfg := server.Config{
		Host:           bindHost,
		Port:           *flagPort,
		Socket:         *flagSocket,
		NodeURL:        *flagNodeURL,
		Logger:         log,
		ReusePort:      reusePort,
		Auth:           gate.Middleware(),
		Metrics:        collector.HTTPMiddleware(),
		ProxyDecorator: trustHeaderDecorator(sessionStore, os.Getenv("SESSION_SECRET"), log),
		BeforeProxy: func(mux *http.ServeMux) {
			// Native handlers go on a sub-mux so we can stamp
			// X-Yha-Core: native on every native response without
			// editing each handler. The wrapping function below is
			// what hides the sub-mux from the outer chain.
			sub := http.NewServeMux()

			// MCP control plane: only register Go-native when Go owns
			// the pool (autostart enabled). Otherwise the Node bridge
			// is still the source of truth for MCP servers, and
			// /v1/mcp/* must proxy through to Node so the existing
			// frontend buttons keep working.
			goOwnsMCP := os.Getenv("YHA_MCP_AUTOSTART") == "1"
			if goOwnsMCP {
				mcp.RegisterRoutes(sub, pool, paths.MCPRegistry(), paths.MCPState(), log,
					mcp.WithBridgeKey(store.BridgeInternalKey))
			}
			tools.RegisterRoutes(sub, paths.BridgeRoot(), log, tools.WithRecorder(collector))
			metrics.RegisterRoutes(sub, collector, log)

			// /internal/auth-status: lets operators query the auth mode
			// the daemon decided on at boot without grepping logs. Mode
			// values match the strings buildAuthGateV2 logs.
			authEnforce := authEnforceEnabled()
			authWorkOSEnabled := auth.FromEnv().Enabled()
			sub.HandleFunc("/internal/auth-status", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					w.Header().Set("Allow", "GET")
					http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
					return
				}
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Cache-Control", "no-store")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"mode":          authMode,
					"workosEnabled": authWorkOSEnabled,
					"storeDir":      authStoreDir,
					"enforce":       authEnforce,
					"pid":           os.Getpid(),
				})
			})

			// Phase 2c-stream-route: direct streaming through Go.
			//
			// The runner fans out across three backends:
			//   - embeddedmcp: the six bridge-native tools (Bash, Read,
			//     Write, Glob, Grep, WebFetch), in-process.
			//   - mcp.Pool: tools advertised by every running MCP child
			//     server. Active only when YHA_MCP_AUTOSTART=1.
			//   - nodecallback: module-provided tools served by Node via
			//     /proxy/tool (AskUser, RunCode, Task, etc.). Catalog
			//     refreshed via /internal/tool-catalog. Both endpoints
			//     authenticate with the bridge key generated above.
			toolsExec := tools.New(paths.BridgeRoot(), nil, log)
			toolsExec.SetRecorder(collector) // hooks tool_run_* metrics.
			embeddedSrv := embeddedmcp.New(toolsExec)
			nodeClient := nodecallback.NewClient(*flagNodeURL, store.BridgeInternalKey(), log)
			nodeRunner := nodecallback.NewRunner(*flagNodeURL, store.BridgeInternalKey(), log)
			composite := tools.NewCompositeRunner(
				embeddedmcp.NewRunnerAdapter(embeddedSrv),
				mcp.NewPoolAdapter(pool),
				nodeClient,
				nodeRunner,
			)
			// Phase 3 reattach buffer: one instance for the daemon's
			// lifetime, shared between the live POST /v1/stream-direct/
			// emit path and the GET /v1/sessions/:id/stream-direct
			// reattach handler. Default caps (200 chunks/session, 500
			// active sessions, 60 s post-finish grace).
			streamBuffer := stream.NewSessionBuffer()
			// Stale-stream watchdog: if an adapter goroutine hangs or
			// dies without calling _end, the buffer entry stays "active"
			// forever and the FE picker keeps flashing busy on that
			// session. The watchdog scans periodically and finalises
			// idle/listenerless entries so the picker clears even when
			// the adapter never reported terminal state.
			streamBuffer.EnableStaleStreamWatchdog(stream.StaleStreamThreshold, stream.StaleSweepInterval)
			// §8.7 — buffer-handoff. Listen on the configured socket
			// (when YHA_HANDOFF_SOCKET is set by the orchestrator on
			// this binary's spawn) so the previous-generation binary
			// can stream every in-flight session's buffered tail
			// across before exiting. Send-side closure is captured
			// here so the outer SIGUSR2 handler can flush in-flight
			// state right before Shutdown.
			if stopHandoff, hErr := stream.ListenHandoff(streamBuffer, "",
				func(sessions, chunks int) {
					log.Info("handoff received",
						"sessions", sessions,
						"chunks", chunks,
						"socket", os.Getenv(stream.HandoffEnvVar))
				}); hErr != nil {
				log.Warn("handoff listen", "err", hErr)
			} else {
				defer stopHandoff()
			}
			handoffSendFn = func(socket string, timeout time.Duration) (int, int, error) {
				return stream.SendHandoff(streamBuffer, socket, timeout)
			}
			// Per-session kill-switch registry. Backs Go's
			// POST /v1/stop/:sessionId so the FE's Stop button can
			// abort an in-flight Go-owned turn. Same role as Node's
			// bridge/core/state.ts activeProcesses Map.
			activeStops := harness.NewActiveProcesses()
			// Mid-stream #btw injection queue. The FE POSTs to
			// /v1/sessions/:id/btw while a stream is running; loop.go
			// drains it at each tool-call boundary.
			btwQueue := stream.NewBtwQueue()
			// Phase 5 finalize hooks: cost-event + auto-title POST to
			// Node's internal endpoints. Same shared bridge key as the
			// tool catalog / proxy-tool calls above. Fire-and-forget
			// with a 5s timeout per attempt — telemetry never blocks
			// the user-visible turn finalize.
			costEventClient := nodecallback.NewCostEventClient(
				*flagNodeURL, store.BridgeInternalKey(), log)
			// Phase 6g/7 persistence hop: per-employee broadcast
			// replies POST back to Node so bridge/sessions/<sid>.json
			// stays authoritative even on the Go-owned broadcast path.
			// Same bridge key as the other internal callbacks; the
			// closure below threads it into broadcast.Runner.Persist
			// with a fresh 5 s timeout per call.
			persistBroadcastClient := nodecallback.NewPersistBroadcastMessageClient(
				*flagNodeURL, store.BridgeInternalKey(),
				log.With("harness", "broadcast"))
			// Per-turn agent-turn id callback so the bridge's rewind
			// recorder can group records by chat turn instead of by
			// bridge restart. Fire-and-forget — the bridge falls back
			// to its process-wide id if Node is unreachable.
			agentTurnClient := nodecallback.NewAgentTurnClient(
				*flagNodeURL, store.BridgeInternalKey(),
				log.With("client", "agent-turn"))
			history, histErr := harness.NewHistoryInDir(paths.BridgeRoot())
			if histErr != nil {
				log.Warn("harness.history load failed", "err", histErr)
			}
			participantResolver := stream.NewFileParticipantResolver(paths.BridgeRoot())
			claudeDefaults := instanceDefaultsFromConfig(cfgDefaultsMap(store), "claudeInstances", "claudeBin")
			codexDefaults := instanceDefaultsFromConfig(cfgDefaultsMap(store), "codexInstances", "codexBin")
			codexResolver := newCodexInstanceResolver(codexDefaults)
			grokDefaults := instanceDefaultsFromConfig(cfgDefaultsMap(store), "grokInstances", "grokBin")
			grokResolver := newGrokInstanceResolver(grokDefaults)
			grokHist := grokHistoryResolver{history: history}

			// grok-acp — the real ACP ( `grok agent stdio` ) long-lived agent route.
			// This is the "sdk" counterpart to the "grok" headless binary route,
			// exactly parallel to claude-sdk vs claude-binary. One long-lived
			// agent stdio proc per GrokInstance (HOME), ACP session reuse for
			// continuous agent memory across turns, live streaming from
			// protocol notifications, MCP via the already-materialized config.
			grokACP := grokacph.NewHarness(grokacph.HarnessOpts{
				Binary:   stringDefault(cfgDefaultsMap(store), "grokBin"),
				Logger:   log.With("harness", "grok-acp"),
				History:  history,      // stores ACP sessionIds under "grok-acp" key
				Resolver: grokResolver, // same HOME/instance isolation as the binary route
			})
			claudeStreamer := claudebinary.NewStreamer(
				claudeHistoryResolver{history: history},
				log.With("harness", "claude-binary"),
			)
			openclawPool, openclawHarness := openclawh.NewDefault(
				paths.BridgeRoot(),
				log.With("harness", "openclaw"),
			)
			openclawHarness = openclawh.NewHarness(
				openclawPool,
				openclawHistoryResolver{history: history},
				log.With("harness", "openclaw"),
			)
			defer openclawPool.StopAll()
			openclawh.RegisterRoutes(sub, openclawPool, log.With("harness", "openclaw"),
				openclawh.WithBridgeKey(store.BridgeInternalKey))

			// Phase 6 — hermes partner gateway (Python tui_gateway
			// subprocess + JSON-RPC stdio). Constructed dormant; the
			// first SubmitPrompt lazily spawns the subprocess. Opt-in
			// via YHA_GO_HERMES=1.
			hermesGateway := hermesh.NewDefault(paths.BridgeRoot(), log.With("harness", "hermes"))
			defer hermesGateway.Stop()
			hermesHarness := hermesh.New(hermesGateway, log.With("harness", "hermes"))

			// §8.6 — partnersapi prompt-respond route. Lets the FE
			// answer Hermes' mid-turn approval/clarify/sudo/secret
			// prompts without going through Node, so the partner-side
			// control plane survives a Node restart the same way the
			// outer chat SSE does. Bridge-key gated, mirrors the
			// /v1/mcp/* auth pattern.
			partnersapi.RegisterRoutes(sub, partnersapi.Deps{
				Hermes:    hermesGateway,
				BridgeKey: store.BridgeInternalKey,
				Logger:    log.With("component", "partnersapi"),
			})

			// Phase 6 — claude-sdk (Anthropic Claude Agent SDK
			// equivalent: claude CLI in stream-json mode with
			// --mcp-config pointing at the bridge-stub MCP server).
			// Opt-in via YHA_GO_CLAUDE_SDK=1.
			claudeSDKHarness := claudesdkh.NewHarness(claudesdkh.HarnessOpts{
				Bin:       stringDefault(cfgDefaultsMap(store), "claudeBin"),
				BridgeURL: "http://127.0.0.1:" + *flagPort,
				BridgeKey: store.BridgeInternalKey(),
				Logger:    log.With("harness", "claude-sdk"),
			})

			// Phase 6 — broadcast / versus runner. Builds the per-
			// harness adapter map from the already-constructed
			// streamer/harness instances so each employee in a
			// multi-participant turn lands on the right backend.
			// Opt-in via YHA_GO_BROADCAST=1.
			broadcastRunner := &broadcast.Runner{
				Employees:  broadcast.NewFileEmployeeLoader(paths.BridgeRoot()),
				BridgeRoot: paths.BridgeRoot(),
				Log:        log.With("harness", "broadcast"),
				Adapters: map[string]broadcast.Adapter{
					broadcast.AdapterClaudeBinary: claudeBinaryBroadcastAdapter(claudeStreamer, claudeDefaults, store, *flagNodeURL),
					broadcast.AdapterCodex:        codexBroadcastAdapter(codexDefaults, codexResolver, store),
					broadcast.AdapterGrok:         grokBroadcastAdapter(grokDefaults, grokResolver, store, history),
					broadcast.AdapterOpenClaw:     openclawBroadcastAdapter(openclawHarness),
					broadcast.AdapterHermes:       hermesBroadcastAdapter(hermesHarness),
					broadcast.AdapterDirectAPI: directAPIBroadcastAdapter(
						defaultDirectAPIPicker,
						apiKeyFromStore(store),
						composite,
						nil, // loop now defaults to no-timeout client (long reasoning turns)
						log.With("harness", "direct-api"),
						collector,
						limiterAdapter,
					),
				},
				// Per-employee assistant replies POST back to Node so
				// the FE can read them from bridge/sessions/<sid>.json
				// on reload. Fresh 5 s timeout per call so a slow disk
				// save doesn't drag the chain.
				Persist: broadcastPersistFn(persistBroadcastClient, log.With("harness", "broadcast")),
			}
			// Step 6 (docs/SQL-migration-plan.md): open the bridge's
			// sessions.db so Go writes phase="final" directly into
			// SQLite, removing the bridge-restart race that previously
			// surfaced as the abandoned-stream interrupt. Optional —
			// if the file is missing or the schema version mismatches,
			// we log and continue without it (legacy HTTP-only persist
			// stays the fallback).
			// Assign the main-scoped sqliteFinalizer (declared near
			// handoffSendFn). Its Close() is deferred at main() return, NOT
			// here — a defer inside this BeforeProxy callback fired at
			// setup-return and closed the *sql.DB seconds after boot, so every
			// phase="final" write hit "sql: database is closed" and turns
			// persisted inputTokens:0/outputTokens:0 (blank final meta bar).
			var sqlErr error
			sqliteFinalizer, sqlErr = stream.OpenSQLiteFinalizer(paths.SessionsDBPath())
			if sqlErr != nil {
				log.Warn("stream.sqlite-finalizer.open-failed",
					"path", paths.SessionsDBPath(),
					"err", sqlErr.Error(),
					"note", "persist falls back to HTTP-only (bridge-restart race remains)")
			} else if sqliteFinalizer != nil {
				log.Info("stream.sqlite-finalizer.opened", "path", paths.SessionsDBPath())
				// Step 5 prep: rewire session metadata lookups
				// (participants / groupMode) onto SQLite so the
				// post-mv bridge/sessions-archive/ rename can't
				// silently break multichat dispatch.
				participantResolver.WithSQLite(sqliteFinalizer)
			}
			// Long (or no) timeout for upstream model streams. Reasoning
			// models and tool-using agents routinely exceed 5-10 min per
			// iteration; the sweeper + explicit stops are the guards.
			streamHTTPClient := &http.Client{Timeout: 0}
			streamDeps := stream.RouteDeps{
				APIKeyFor:       apiKeyFromStore(store),
				Runner:          composite,
				Logger:          log,
				Recorder:        collector, // hooks stream_request_* metrics.
				Buffer:          streamBuffer,
				CostEvents:      costEventAdapter{client: costEventClient},
				Participants:    participantResolver,
				PersistMessage:  persistMessageAdapter{client: persistBroadcastClient},
				SQLiteFinalizer: sqliteFinalizer,
				HTTPClient:      streamHTTPClient,
				GenericProvider: store.ProviderEndpoint,
				UploadsDir:      paths.UploadsDir(),
				SessionsDir:     paths.SessionsDir(),
				DefaultCWD:      resolveDefaultCWD(log),
				BridgeRoot:      paths.BridgeRoot(),
				ActiveStops:     stopRegistryAdapter{active: activeStops},
				Btw:             btwQueue,
				Limiter:         limiterAdapter,
				AgentTurn:       agentTurnClient,
				ResolveSkills: func(setName string) []stream.SkillBlock {
					return stream.ResolveSkillSet(
						filepath.Join(paths.BridgeRoot(), "skills"),
						setName,
						store.Config().SkillSets,
					)
				},
				RawLog: rawlog.New(filepath.Join(paths.BridgeRoot(), "api-inout-log")),
				ResolveToolSet: func(name string) []string {
					tools := store.Config().ToolSets
					if tools == nil {
						return nil
					}
					return tools[name]
				},
				ToolCommandOverwrite: func() ([]string, bool) {
					defaults := cfgDefaultsMap(store)
					if defaults == nil {
						return nil, false
					}
					enabled, _ := defaults["tool_command_overwrite_enabled"].(bool)
					if !enabled {
						return nil, false
					}
					raw, _ := defaults["tool_command_overwrite_tools"].([]any)
					out := make([]string, 0, len(raw))
					for _, v := range raw {
						if s, ok := v.(string); ok && s != "" {
							out = append(out, s)
						}
					}
					return out, true
				},
				ModelPricing: store.ModelPricing,
				DefaultSystemPrompt: func() string {
					cfg := store.Config()
					presetName, _ := cfg.Defaults["preset"].(string)
					if presetName == "" {
						return "You are a helpful assistant. Always respond in the same language the user writes in, defaulting to English."
					}
					if cfg.Presets != nil {
						if v, ok := cfg.Presets[presetName]; ok {
							return v
						}
					}
					return ""
				},
				ResolvePreset: func(nameOrText string) string {
					if nameOrText == "" {
						return ""
					}
					cfg := store.Config()
					if cfg.Presets != nil {
						if v, ok := cfg.Presets[nameOrText]; ok {
							return v
						}
					}
					return nameOrText
				},
				History: historyLoaderAdapter{client: nodecallback.NewSessionHistoryClient(
					*flagNodeURL, store.BridgeInternalKey(), log.With("client", "session-history"))},

				HarnessAdapters: map[string]stream.HarnessAdapterFn{
					"claude-binary": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						instance, ok := claudeDefaults.pickBySubProvider(req.Provider)
						if !ok {
							instance = claudeDefaults.pick(req.HarnessInstance)
						}
						// Resolved stream.ImageBlocks → claude-binary's
						// `{type:image, source:{base64, media_type, data}}`
						// wire shape. nil/empty when no images on the turn.
						var harnessImages []map[string]any
						for _, img := range req.ImageBlocks {
							blk := claudebinary.BuildImageBlock(harness.ImageBlock{
								MediaType: img.MediaType,
								Base64:    img.Base64,
							})
							if blk != nil {
								harnessImages = append(harnessImages, blk)
							}
						}
						// Resolved skill blocks for the FE-supplied
						// SkillSet name. Folded into the claude CLI's
						// initial prompt by buildInitialStdin.
						var harnessSkills []claudebinary.Skill
						for _, s := range req.Skills {
							harnessSkills = append(harnessSkills, claudebinary.Skill{
								Name:    s.Name,
								Content: s.Content,
							})
						}
						// Per-provider AllowedTools split. The FE ships a
						// single mixed list (claude tools + codex tools);
						// claude binary rejects codex-only ids like
						// `functions.exec_command` (and vice-versa). Same
						// split Node's providers/codex.ts:
						// splitAllowedToolsByProvider does pre-Phase-7.
						claudeAllowedTools := make([]string, 0, len(req.AllowedTools))
						for _, name := range req.AllowedTools {
							if !codexh.IsCodexToolName(name) {
								claudeAllowedTools = append(claudeAllowedTools, name)
							}
						}
						// Resolve plugin install dirs + agents.json content
						// from the chosen subscription instance's $HOME so
						// the binary picks up the user's installed plugins
						// and custom agents (`/init`, `/review`, …).
						// Without these the slash-command surface is dark.
						instanceHome := ""
						if cfgDir := expandHomePath(instance.ConfigDir); cfgDir != "" {
							instanceHome = filepath.Dir(strings.TrimSuffix(cfgDir, string(filepath.Separator)))
						}
						pluginDirs := claudebinary.LoadInstalledPluginDirs(instanceHome)
						agentsJSON := claudebinary.LoadAgentsJSON(instanceHome)
						// "claude binary as universal client" — non-Claude
						// models route through the Node bridge's
						// /proxy/:externalModel/v1/messages translator,
						// which forwards to the real upstream (DeepSeek,
						// NVIDIA NIM, OpenRouter, Groq, …) with the right
						// endpoint + key. Without External=true the binary
						// would happily talk to api.anthropic.com against
						// the user's subscription/key — and Anthropic
						// would 400 with "credit balance too low" /
						// "unknown model".
						claudeModel := resolveClaudeSubscriptionModel(req.Model)
						external := !isClaudeModelID(claudeModel)
						proxyURL := ""
						if external {
							proxyURL = strings.TrimRight(*flagNodeURL, "/") + "/proxy/" + url.PathEscape(req.Model)
						}
						// History-fold fallback. The binary's `--resume <sid>`
						// path carries forward the model's own conversation
						// memory across turns. When the resolver has no
						// stored claude-binary session id for this YHA
						// session (first turn, fresh branch, daemon
						// restart after the in-memory mirror was lost),
						// --resume is skipped and the binary starts a
						// blank conversation — it has no idea what was
						// said in earlier turns. Mirror Node's
						// bridge/providers/claude-stream.ts:87-101: when
						// no resume is available AND prior turns exist,
						// fold them into the prompt as a `[Previous
						// conversation context: ...]` preamble so the
						// model gets the same context the YHA chat UI
						// has been showing the user. Cap the per-turn
						// payload at 16 turns / 32 KiB so a very long
						// history doesn't blow the prompt budget.
						prompt := req.Input
						if !claudeStreamer.HasResume(req.SessionID) && len(req.PriorHistory) > 0 {
							// Map to harness.FoldMessage so we use the single
							// deduped helper (see harness/history.go). Keeps
							// exact 16/32k + preamble semantics.
							fh := make([]harness.FoldMessage, 0, len(req.PriorHistory))
							for _, m := range req.PriorHistory {
								fh = append(fh, harness.FoldMessage{Role: m.Role, Content: m.Content})
							}
							if folded := harness.FoldPriorHistoryForCLI(fh, 16, 32*1024); folded != "" {
								prompt = folded + req.Input
							}
						}
						cbReq := claudebinary.Request{
							Prompt:           prompt,
							HistorySessionID: req.SessionID,
							ImageBlocks:      harnessImages,
							MaxRetries:       1,
							Spawn: claudebinary.SpawnOpts{
								ClaudeBin:            firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "claudeBin")),
								ConfigDir:            expandHomePath(instance.ConfigDir),
								CWD:                  req.CWD,
								Model:                claudeModel,
								Effort:               req.Effort,
								Reasoning:            stringMapValue(req.Caps, "reasoning"),
								Preset:               req.Preset,
								SysMode:              req.SystemMode,
								Subscription:         isClaudeSubscriptionProvider(req.Provider),
								AnthropicAPIKey:      apiKeyFromStore(store)("anthropic"),
								BridgeKey:            store.BridgeInternalKey(),
								SkipPermissions:      true,
								AllowedTools:         claudeAllowedTools,
								Skills:               harnessSkills,
								PluginDirs:           pluginDirs,
								AgentsJSON:           agentsJSON,
								WorkingDirConstraint: strings.TrimSpace(req.CWD) != "",
								Stream:               true,
								External:             external,
								ProxyURL:             proxyURL,
							},
						}
						fp, err := claudeStreamer.Stream(ctx, cbReq, emit)
						// Drive finalize whenever fp is populated, even when Stream
						// returned an error. The streamer surfaces ctx.Err() with a
						// non-nil fp when the binary completed at least one result
						// event before the client disconnected — that data must
						// still reach cost telemetry.
						if fp != nil {
							fmt.Fprintf(os.Stderr, "{\"trace\":\"claudebinary.adapter\",\"stage\":\"finalize\",\"fields\":{\"input\":%d,\"output\":%d,\"cost\":%g,\"cacheCreate\":%d,\"cacheRead\":%d,\"stopReason\":%q,\"errored\":%t}}\n",
								fp.InputTokens, fp.OutputTokens, fp.Cost, fp.CacheCreationTokens, fp.CacheReadTokens, fp.StopReason, err != nil)
							finalize(stream.HarnessFinalize{
								InputTokens:         fp.InputTokens,
								OutputTokens:        fp.OutputTokens,
								CacheCreationTokens: fp.CacheCreationTokens,
								CacheReadTokens:     fp.CacheReadTokens,
								Cost:                fp.Cost,
								Model:               req.Model,
								Provider:            firstNonEmpty(req.Provider, "anthropic"),
								StopReason:          fp.StopReason,
							})
						}
						if err != nil {
							fmt.Fprintf(os.Stderr, "{\"trace\":\"claudebinary.adapter\",\"stage\":\"error\",\"fields\":{\"err\":%q,\"fpNil\":%t}}\n", err.Error(), fp == nil)
							return err
						}
						if fp == nil {
							fmt.Fprintf(os.Stderr, "{\"trace\":\"claudebinary.adapter\",\"stage\":\"nilfp\",\"fields\":{}}\n")
						}
						return nil
					},
					"codex": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						instance, fromSub := codexDefaults.pickBySubProvider(req.Provider)
						if !fromSub {
							instance = codexDefaults.pick(req.CodexInstance)
						}
						// When the SUB index resolved to a concrete
						// instance, its Label is authoritative — a stale
						// CodexInstance from the FE's last selection must
						// not override the just-picked account.
						codexInstanceID := req.CodexInstance
						if fromSub {
							codexInstanceID = instance.Label
						} else if codexInstanceID == "" {
							codexInstanceID = instance.Label
						}
						// History-fold. The codex `exec` subprocess has no
						// resume equivalent — every turn starts a blank
						// conversation, so the model has no idea what was
						// said in earlier turns of this YHA session.
						// Mirror bridge/providers/codex.ts:273-283 and
						// fold PriorHistory unconditionally as a
						// `[Previous conversation context: ...]` preamble.
						// Cap at 16 turns / 32 KiB so a very long history
						// doesn't blow the prompt budget.
						codexInput := req.Input
						// Codex currently folds unconditionally (no native resume
						// sid wiring yet in its broadcast/primary paths). Using the
						// shared helper keeps the cap + wording identical to claude/grok.
						// When codex gets a HasResume or hist resolver, this can become
						// conditional like the grok path.
						if len(req.PriorHistory) > 0 {
							fh := make([]harness.FoldMessage, 0, len(req.PriorHistory))
							for _, m := range req.PriorHistory {
								fh = append(fh, harness.FoldMessage{Role: m.Role, Content: m.Content})
							}
							if folded := harness.FoldPriorHistoryForCLI(fh, 16, 32*1024); folded != "" {
								codexInput = folded + req.Input
							}
						}
						codexAPIKey := ""
						if !isOpenAISubscriptionProvider(req.Provider) {
							codexAPIKey = apiKeyFromStore(store)("openai")
						}
						cx := codexh.New(
							codexh.WithBinary(firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "codexBin"))),
							codexh.WithExecMode(stringDefault(cfgDefaultsMap(store), "codexExecMode")),
							codexh.WithOpenAIAPIKey(codexAPIKey),
							codexh.WithInstanceResolver(codexResolver),
						)
						res, err := cx.Stream(ctx, codexh.Request{
							SessionID:        req.SessionID,
							HistorySessionID: req.SessionID,
							Model:            req.Model,
							Input:            codexInput,
							Preset:           req.Preset,
							SystemMode:       req.SystemMode,
							Effort:           req.Effort,
							AllowedTools:     append([]string(nil), req.AllowedTools...),
							CWD:              req.CWD,
							HarnessInstance:  req.HarnessInstance,
							CodexInstance:    codexInstanceID,
							Provider:         req.Provider,
							Caps:             req.Caps,
						}, codexh.Emit(emit))
						if err != nil {
							return err
						}
						finalize(stream.HarnessFinalize{
							InputTokens:         int(res.Usage.InputTokens),
							OutputTokens:        int(res.Usage.OutputTokens),
							CacheCreationTokens: int(res.Usage.CacheCreation),
							CacheReadTokens:     int(res.Usage.CacheRead),
							Cost:                res.Usage.Cost,
							Model:               firstNonEmpty(res.Usage.Model, req.Model),
							Provider:            firstNonEmpty(req.Provider, "openai"),
							StopReason:          res.StopReason,
						})
						return nil
					},
					"grok": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						// "grok" = the headless binary route ( -p / streaming-json + --resume,
						// rich events, MCP via alias, estimator). This is the primary / default,
						// analogous to "claude-binary".
						// However, if defaults.grokRuntime (set via the Grok harness prefs section)
						// is 'acp', we transparently delegate to the grok-acp (long-lived ACP
						// agent stdio) harness for this turn. The HarnessInstance (account label)
						// is still passed through so the acp side resolves the correct per-account
						// HOME / config for MCP and auth isolation. This makes the UI switch work
						// without forcing users to set HarnessInstance="grok-acp" manually.
						rt := strings.ToLower(strings.TrimSpace(stringDefault(cfgDefaultsMap(store), "grokRuntime")))
						if rt == "acp" || rt == "grok-acp" || rt == "agent" || rt == "sdk" {
							log.With("harness", "grok").Info("grokRuntime selects ACP route; delegating to grok-acp (long-lived) while preserving account HarnessInstance")
							res, err := grokACP.Stream(ctx, harness.Request{
								SessionID:        req.SessionID,
								HistorySessionID: req.SessionID,
								Model:            req.Model,
								Input:            req.Input,
								Preset:           req.Preset,
								SystemMode:       req.SystemMode,
								Effort:           req.Effort,
								CWD:              req.CWD,
								AllowedTools:     append([]string(nil), req.AllowedTools...),
								Caps:             req.Caps,
								Provider:         req.Provider,
								HarnessInstance:  req.HarnessInstance,
								GrokInstance:     req.GrokInstance,
							}, harness.Emit(emit))
							if err != nil {
								return err
							}
							finalize(stream.HarnessFinalize{
								InputTokens:         int(res.Usage.InputTokens),
								OutputTokens:        int(res.Usage.OutputTokens),
								CacheCreationTokens: int(res.Usage.CacheCreation),
								CacheReadTokens:     int(res.Usage.CacheRead),
								Cost:                res.Usage.Cost,
								Model:               firstNonEmpty(res.Usage.Model, req.Model),
								Provider:            firstNonEmpty(req.Provider, "xai"),
								StopReason:          res.StopReason,
							})
							return nil
						}

						// normal headless binary path
						instance, fromSub := grokDefaults.pickBySubProvider(req.Provider)
						if !fromSub {
							instance = grokDefaults.pick(req.HarnessInstance)
						}
						grokInstanceID := firstNonEmpty(req.GrokInstance, req.HarnessInstance)
						if fromSub {
							grokInstanceID = instance.Label
						} else if grokInstanceID == "" {
							grokInstanceID = instance.Label
						}
						resumeID := grokHist.Get(req.SessionID)
						grokInput := req.Input
						if resumeID == "" && len(req.PriorHistory) > 0 {
							fh := make([]harness.FoldMessage, 0, len(req.PriorHistory))
							for _, m := range req.PriorHistory {
								fh = append(fh, harness.FoldMessage{Role: m.Role, Content: m.Content})
							}
							if folded := harness.FoldPriorHistoryForCLI(fh, 16, 32*1024); folded != "" {
								grokInput = folded + req.Input
							}
						}
						gx := grokbuildh.New(
							grokbuildh.WithBinary(firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "grokBin"))),
							grokbuildh.WithInstanceResolver(grokResolver),
						)
						res, err := gx.Stream(ctx, grokbuildh.Request{
							SessionID:        req.SessionID,
							HistorySessionID: req.SessionID,
							ResumeSessionID:  resumeID,
							Model:            req.Model,
							Input:            grokInput,
							Preset:           req.Preset,
							SystemMode:       req.SystemMode,
							Effort:           req.Effort,
							AllowedTools:     append([]string(nil), req.AllowedTools...),
							CWD:              req.CWD,
							HarnessInstance:  req.HarnessInstance,
							GrokInstance:     grokInstanceID,
							Provider:         req.Provider,
							Caps:             req.Caps,
						}, grokbuildh.Emit(emit))
						if err != nil {
							if resumeID != "" {
								// Poisoned --resume sid (bad state, auth expiry under that HOME,
								// CLI rejected the session, or prior turn left a dangling id).
								// Clear it so the next turn for this YHA session does a cold start
								// instead of repeatedly dying before any output.
								grokHist.Delete(req.SessionID)
							}
							return err
						}
						if res.SessionID != "" {
							grokHist.Set(req.SessionID, res.SessionID)
						}
						if res.Usage.InputTokens == 0 && res.Usage.OutputTokens == 0 {
							estIn, estOut := grokbuildh.EstimateGrokUsage(grokInput, res.Text, req.Model)
							res.Usage.InputTokens = estIn
							res.Usage.OutputTokens = estOut
						}
						finalize(stream.HarnessFinalize{
							InputTokens:         int(res.Usage.InputTokens),
							OutputTokens:        int(res.Usage.OutputTokens),
							CacheCreationTokens: int(res.Usage.CacheCreation),
							CacheReadTokens:     int(res.Usage.CacheRead),
							Cost:                res.Usage.Cost,
							Model:               firstNonEmpty(res.Usage.Model, req.Model),
							Provider:            firstNonEmpty(req.Provider, "xai"),
							StopReason:          res.StopReason,
						})
						return nil
					},
					"grok-acp": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						// Real dedicated ACP route (`grok agent stdio` long-lived agent).
						// Switchable via HarnessInstance="grok-acp" (parallel to claude-sdk).
						res, err := grokACP.Stream(ctx, harness.Request{
							SessionID:        req.SessionID,
							HistorySessionID: req.SessionID,
							Model:            req.Model,
							Input:            req.Input,
							Preset:           req.Preset,
							SystemMode:       req.SystemMode,
							Effort:           req.Effort,
							CWD:              req.CWD,
							AllowedTools:     append([]string(nil), req.AllowedTools...),
							Caps:             req.Caps,
							Provider:         req.Provider,
							HarnessInstance:  req.HarnessInstance,
							GrokInstance:     req.GrokInstance,
						}, harness.Emit(emit))
						if err != nil {
							return err
						}
						finalize(stream.HarnessFinalize{
							InputTokens:         int(res.Usage.InputTokens),
							OutputTokens:        int(res.Usage.OutputTokens),
							CacheCreationTokens: int(res.Usage.CacheCreation),
							CacheReadTokens:     int(res.Usage.CacheRead),
							Cost:                res.Usage.Cost,
							Model:               firstNonEmpty(res.Usage.Model, req.Model),
							Provider:            firstNonEmpty(req.Provider, "xai"),
							StopReason:          res.StopReason,
						})
						return nil
					},
					"openclaw": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						if req.Participant == nil {
							return errors.New("openclaw adapter: participant target required")
						}
						res, err := openclawHarness.Stream(ctx, harness.Request{
							SessionID: req.SessionID,
							Model:     req.Model,
							Input:     req.Input,
							Preset:    req.Preset,
							Effort:    req.Effort,
							CWD:       req.CWD,
							Caps:      req.Caps,
							BroadcastEmp: &harness.EmployeeMeta{
								ID:          req.Participant.ID,
								Name:        req.Participant.Name,
								PartnerType: req.Participant.PartnerType,
								PartnerID:   req.Participant.PartnerID,
							},
						}, harness.Emit(emit))
						if err != nil {
							return err
						}
						finalize(stream.HarnessFinalize{
							Model:      firstNonEmpty(res.Usage.Model, req.Model),
							Provider:   "openclaw",
							StopReason: res.StopReason,
						})
						return nil
					},
					"hermes": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						if req.Participant == nil {
							return errors.New("hermes adapter: participant target required")
						}
						res, err := hermesHarness.Stream(ctx, harness.Request{
							SessionID: req.SessionID,
							Model:     req.Model,
							Input:     req.Input,
							Preset:    req.Preset,
							CWD:       req.CWD,
							Caps:      req.Caps,
							BroadcastEmp: &harness.EmployeeMeta{
								ID:          req.Participant.ID,
								Name:        req.Participant.Name,
								PartnerType: req.Participant.PartnerType,
								PartnerID:   req.Participant.PartnerID,
							},
						}, harness.Emit(emit))
						if err != nil {
							return err
						}
						finalize(stream.HarnessFinalize{
							Model:      firstNonEmpty(res.Usage.Model, req.Model),
							Provider:   "hermes",
							StopReason: res.StopReason,
						})
						return nil
					},
					"claude-sdk": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						res, err := claudeSDKHarness.Stream(ctx, harness.Request{
							SessionID:       req.SessionID,
							Model:           req.Model,
							Input:           req.Input,
							Preset:          req.Preset,
							SystemMode:      req.SystemMode,
							Effort:          req.Effort,
							CWD:             req.CWD,
							AllowedTools:    append([]string(nil), req.AllowedTools...),
							Caps:            req.Caps,
							Provider:        req.Provider,
							HarnessInstance: req.HarnessInstance,
						}, harness.Emit(emit))
						if err != nil {
							return err
						}
						finalize(stream.HarnessFinalize{
							InputTokens:         int(res.Usage.InputTokens),
							OutputTokens:        int(res.Usage.OutputTokens),
							CacheCreationTokens: int(res.Usage.CacheCreation),
							CacheReadTokens:     int(res.Usage.CacheRead),
							Cost:                res.Usage.Cost,
							Model:               firstNonEmpty(res.Usage.Model, req.Model),
							Provider:            firstNonEmpty(req.Provider, "anthropic"),
							StopReason:          res.StopReason,
						})
						return nil
					},
					"broadcast": func(ctx context.Context, req stream.HarnessAdapterRequest, _ []byte, emit stream.EmitFn, finalize stream.HarnessFinalizeFn) error {
						if len(req.ParticipantIDs) == 0 {
							return errors.New("broadcast adapter: no participants")
						}
						mode := req.GroupMode
						if mode == "" {
							mode = "sequential"
						}
						// Convert resolved stream.ImageBlocks → harness.ImageBlock
						// for the broadcast runner (it then fans them out
						// per employee via ImagesForEmployee).
						var bcImages []harness.ImageBlock
						for _, img := range req.ImageBlocks {
							bcImages = append(bcImages, harness.ImageBlock{
								MediaType: img.MediaType,
								Base64:    img.Base64,
							})
						}
						chain, err := broadcastRunner.RunChain(ctx, req.ParticipantIDs, mode, broadcast.Request{
							SessionID:       req.SessionID,
							Input:           req.Input,
							Model:           req.Model,
							BasePreset:      req.Preset,
							SystemMode:      req.SystemMode,
							Effort:          req.Effort,
							CWD:             req.CWD,
							Provider:        req.Provider,
							HarnessInstance: req.HarnessInstance,
							CodexInstance:   req.CodexInstance,
							GrokInstance:    req.GrokInstance,
							AllowedTools:    append([]string(nil), req.AllowedTools...),
							Caps:            req.Caps,
							ImageBlocks:     bcImages,
						}, broadcast.ChunkEmitter(emit))
						if err != nil {
							return err
						}
						if chain == nil {
							return nil
						}
						finalize(stream.HarnessFinalize{
							InputTokens:         int(chain.Usage.InputTokens),
							OutputTokens:        int(chain.Usage.OutputTokens),
							CacheCreationTokens: int(chain.Usage.CacheCreation),
							CacheReadTokens:     int(chain.Usage.CacheRead),
							Cost:                chain.Usage.Cost,
							Model:               firstNonEmpty(chain.Usage.Model, req.Model),
							Provider:            "broadcast",
							StopReason:          "end_turn",
						})
						return nil
					},
				},
			}
			stream.RegisterRoute(sub, streamDeps)
			// GET /v1/system-preview — read-only inspector that returns
			// the exact system-prompt assembly a stream POST would emit
			// for the requested per-session state. Shares streamDeps so
			// the preview never drifts from the route's actual layering.
			stream.RegisterPreviewRoute(sub, streamDeps)

			// Phase 2d auth routes — only registered when the store
			// + WorkOS client are configured. Otherwise these paths
			// fall through to the proxy and Node still handles them.
			if sessionStore != nil && workosClient != nil {
				auth.RegisterRoutes(sub, auth.RouteDeps{
					WorkOS:      workosClient,
					Store:       sessionStore,
					Cfg:         auth.FromEnv(),
					Secure:      os.Getenv("USE_HTTP") != "true",
					LogPath:     paths.AuthLogPath(),
					Logger:      log,
					BearerCheck: bearerSessionFromEnv(),
				})
			}

			native := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Yha-Core", "native")
				sub.ServeHTTP(w, r)
			})
			if goOwnsMCP {
				mux.Handle("/v1/mcp/", native)
			}
			// Only the executor is implemented natively today —
			// GET /v1/tools/ (tool group discovery) and other
			// /v1/tools/* paths live in Node's mcp-client module.
			// Registering the bare prefix here would 404 those.
			mux.Handle("/v1/tools/exec", native)
			mux.Handle("/v1/stream-direct/", native)
			// /v1/system-preview — Go-native; read-only inspector for the
			// system-prompt assembly. No Node fallback exists.
			mux.Handle("GET /v1/system-preview", native)
			// Phase 3 reattach: only the -direct tail lands on the
			// native sub-mux. /v1/sessions/:id/stream stays Node-owned
			// until Phase 5 cuts the frontend over (Node still serves
			// the live POST /v1/stream/ until then, so its replay tail
			// is the only one with state). Everything else under
			// /v1/sessions/ (status, stop, detach, btw, …) likewise
			// falls through to the proxy because we don't mount the
			// prefix. Go 1.22+ pattern matching keeps the routes precise.
			//
			// The inner sub-mux still has both registrations so
			// /v1/sessions/{id}/stream becomes Go-native the day a
			// route-config flag flips it (or Phase 5 lands and the FE
			// updates its URL).
			mux.Handle("GET /v1/sessions/{id}/stream-direct", native)
			// /v1/sessions/{id}/status — Go-side liveness probe (Buffer-
			// backed). The FE switch-back path calls this to know
			// whether to reattach; Node's old route still exists but
			// reads activeStreams which never sees Go-owned turns.
			mux.Handle("GET /v1/sessions/{id}/status", native)
			// /v1/sessions/{id}/stream/detach — FE-deliberate close
			// marker so the unsubscribe doesn't emit a disconnect
			// interrupt block. Mirrors Node chat-lifecycle.ts:44.
			mux.Handle("POST /v1/sessions/{id}/stream/detach", native)
			// /internal/active-streams — bridge-key gated active-set
			// probe Node uses to enrich its session list with
			// isRunning for Go-owned streams.
			mux.Handle("GET /internal/active-streams", native)
			// /v1/activity/stream — process-global live activity feed
			// (SSE). Reports busy state + live counters of every
			// in-flight session so the FE multichat grid / header can
			// show per-session progress without attaching to each
			// stream. Gated like its active-streams neighbor: the
			// native front door + path mount, no per-handler key.
			mux.Handle("GET /v1/activity/stream", native)
			// /v1/stop/{sessionId} — Go-side hard-stop. Walks the
			// ActiveProcesses registry populated by route.go +
			// route_harness.go. Node's /v1/stop survives but its map
			// is empty for Go-owned turns.
			mux.Handle("POST /v1/stop/{sessionId}", native)
			// /v1/sessions/{id}/btw — Go-side mid-stream #btw queue
			// (POST enqueues, GET peeks). The direct-API tool loop
			// drains at each tool-call boundary. Node's old endpoint
			// is shadowed.
			mux.Handle("POST /v1/sessions/{id}/btw", native)
			mux.Handle("GET /v1/sessions/{id}/btw", native)
			// §8.6 — partnersapi prompt-respond is Go-native; mask it
			// off the proxy so the FE's POST lands on Go's handler
			// instead of being forwarded to Node's
			// /v1/partners/hermes/prompt-respond.
			mux.Handle("POST /v1/partners/hermes/prompt-respond", native)
			mux.Handle("/internal/metrics", native)
			mux.Handle("/internal/metrics/", native)
			mux.Handle("/internal/auth-status", native)

			if sessionStore != nil && workosClient != nil {
				mux.Handle("/auth/login", native)
				mux.Handle("/auth/callback", native)
				mux.Handle("/auth/logout", native)
				mux.Handle("/v1/me", native)
			}

			// /proxy/browser/* — direct reverse proxy from Go to
			// KasmVNC (yha-chromium container at 127.0.0.1:3011).
			// Bypasses the Node bridge because Bun's server.on('upgrade')
			// drops outbound bytes (verified locally with a minimal
			// repro: write() returns success, callback says nil, client
			// receives nothing). See NewBrowserProxy for the long
			// version. The Unwrap chain on statusRecorder /
			// middlewareRecorder lets httputil.ReverseProxy hijack the
			// connection for the KasmVNC WebSocket framebuffer stream.
			browserTarget := os.Getenv("YHA_BROWSER_TARGET")
			if browserTarget == "" {
				browserTarget = "http://127.0.0.1:3011"
			}
			if bp, bErr := server.NewBrowserProxy(browserTarget, log); bErr != nil {
				log.Warn("browser proxy disabled", "err", bErr)
			} else {
				mux.Handle("/proxy/browser", bp)
				mux.Handle("/proxy/browser/", bp)
				log.Info("browser proxy wired", "target", browserTarget)
			}

			// /proxy/desktop-browser-stream — WS upgrade for the Windows
			// native desktop-browser MCP's CDP screencast. Upstream port is
			// chosen at MCP boot and recorded in
			// bridge/mcp/exchange/desktop-browser-stream.port; we re-read
			// that file per request so MCP restarts (and ephemeral port
			// changes) don't require bouncing the Go core.
			dbsDir := os.Getenv("YHA_DESKTOP_BROWSER_STREAM_DIR")
			dbs := server.NewDesktopBrowserStreamProxy(dbsDir, log)
			mux.Handle("/proxy/desktop-browser-stream", dbs)
			mux.Handle("/proxy/desktop-browser-stream/", dbs)
			log.Info("desktop-browser stream proxy wired")
		},
	}

	srv, err := server.New(cfg)
	if err != nil {
		log.Error("server.New failed", "err", err)
		os.Exit(1)
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Run() }()

	// §8.2 — Internal OpenAI-compat server (port of
	// bridge/chat/openai-internal.ts). Hosts a loopback-only
	// /v1/messages style endpoint on 127.0.0.1:8444 so subprocesses
	// spawned by harness adapters can phone home to reach a different
	// model. Off by default unless YHA_INTERNAL_API=1 because the Node
	// side still hosts the same endpoint for now; opt-in lets
	// operators flip traffic over without rebuilding Node.
	var internalSrv *internalapi.Server
	if os.Getenv("YHA_INTERNAL_API") == "1" && !internalapi.Disabled() {
		verifier := internalapi.NewFileVerifier(paths.BridgeRoot(), 30*time.Second)
		internalSrv = internalapi.NewServer(internalapi.Deps{
			Store:     store,
			Limiter:   limiterAdapter,
			VerifyKey: verifier.Verify,
			Logger:    log.With("component", "internalapi"),
		})
		if addr, ierr := internalSrv.Start(); ierr != nil {
			log.Warn("internalapi.start", "err", ierr)
			internalSrv = nil
		} else {
			log.Info("internalapi listening", "addr", addr)
		}
	} else {
		log.Info("internalapi disabled",
			"hint", "set YHA_INTERNAL_API=1 to enable the Go-side OpenAI-compat loopback")
	}
	defer func() {
		if internalSrv != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = internalSrv.Shutdown(ctx)
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown requested", "signal", "INT/TERM", "timeout", "10s")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Error("shutdown error", "err", err)
			os.Exit(1)
		}
		log.Info("clean exit")
	case <-drainCtx.Done():
		// Phase 4: blue-green graceful drain. The new binary is
		// already bound to the same TCP port via SO_REUSEPORT, so
		// the kernel keeps routing new connections to it; we just
		// stop accepting on this listener and wait for in-flight
		// requests to finish, then exit 0 so pm2 doesn't restart us.
		log.Info("drain requested", "signal", "USR2", "timeout", drainTimeout.String())
		// §8.7 — hand off the SessionBuffer tail to the new binary so
		// any chunks emitted after the last Node-side live checkpoint
		// (and before this binary's Shutdown completes) survive the
		// reload. The orchestrator points YHA_HANDOFF_SOCKET at the
		// new binary's listener; an empty env is a no-op so the
		// pre-§8.7 path is preserved when the orchestrator hasn't
		// opted in.
		if handoffSendFn != nil {
			if handoffSock := os.Getenv(stream.HandoffEnvVar); handoffSock != "" {
				sessions, chunks, hErr := handoffSendFn(handoffSock, drainTimeout)
				if hErr != nil {
					log.Warn("handoff send", "err", hErr, "socket", handoffSock)
				} else if sessions > 0 || chunks > 0 {
					log.Info("handoff sent",
						"sessions", sessions,
						"chunks", chunks,
						"socket", handoffSock)
				}
			}
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Error("drain error", "err", err)
			os.Exit(1)
		}
		log.Info("drain complete — exiting 0")
		os.Exit(0)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}
}
