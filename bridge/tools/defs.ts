// ── Static + dynamic bridge tool definitions, OpenAI + Gemini formats ─────────
//
// Phase 1 of the modular migration (`YHA-modular-plan.md` Schritt 1):
// the static tool array is now registered into the `tools` register
// with `core: true` instead of being read directly. `getBridgeToolDefs()`
// composes the live list as `register.list() + dynamic MCP tools`,
// so future modules can extend the catalog by calling
// `ctx.registers.tools.add({ id, ...openAiToolDef, core: false })`
// with no change to this file.
//
// Every entry here keeps `core: true` so an over-eager
// `removeAllByModule('<core>')` cannot accidentally wipe the catalog.
'use strict';

const { config, mcpConnections } = require('../core/state');
const { sanitizeGeminiSchema } = require('../chat/translation');
const { bridgeRegisters } = require('../core/registers/keys');

const DEFAULT_OVERWRITE_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'Task', 'RunCode'];

// Inject the session working directory into a system-prompt string so API-based
// models don't fall back to the /workspace default learned from training data.
function addCwdToPreset(preset, cwd) {
  if (!cwd) return preset;
  const note = `Working directory: ${cwd}\nWhen calling Read, Write, Edit, Bash, Glob, or Grep tools always use absolute paths that start with this directory.`;
  return preset ? `${preset}\n\n${note}` : note;
}

// ── Static bridge tool definitions (OpenAI function-calling format) ───────────
const BRIDGE_TOOL_DEFS_STATIC = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a file from the local filesystem. Returns full file text. Use this to inspect code, configs, or any text file before editing.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to read' },
        },
        required: ['file_path'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Write or completely overwrite a file. Creates parent directories if needed. Prefer Edit for targeted changes — use Write only for new files or full rewrites.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to write to' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Replace an exact occurrence of old_string with new_string in a file. The old_string must match the file exactly (including whitespace/indentation). Fails if old_string is not found or is ambiguous. Use for targeted line-level edits.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to edit' },
          old_string: {
            type: 'string',
            description: 'Exact text to find and replace — must be unique in the file',
          },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Execute a shell command and return its stdout+stderr (combined, max 8000 chars). Runs in the session working directory. Timeout: 60 s. Use for git, npm, file ops, running tests, and anything not covered by Read/Write/Glob/Grep.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Glob',
      description:
        'Find files by glob pattern. Returns matching paths sorted by modification time. Faster than Bash find for simple pattern searches. Example patterns: "**/*.ts", "src/**/*.test.js".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")' },
          path: {
            type: 'string',
            description: 'Directory to search in (default: session cwd)',
            default: '.',
          },
        },
        required: ['pattern'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Grep',
      description:
        'Search file contents with a regex. Returns matching lines with filenames and line numbers (max 50 matches). Faster than Bash grep for content searches. Use glob parameter to filter to specific file types.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: {
            type: 'string',
            description: 'File or directory to search (default: session cwd)',
            default: '.',
          },
          glob: { type: 'string', description: 'File glob filter, e.g. "*.ts" or "**/*.py"' },
        },
        required: ['pattern'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description:
        'Fetch a URL and return its text content (HTML tags stripped, max 12000 chars). Use for reading documentation, APIs, or web pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description:
        'Search the web with automatic provider fallback (Tavily → Exa → Google CSE → Bing → free DuckDuckGo/Brave). Returns up to N result titles and URLs. Use to find current information, documentation, or anything requiring a live web search. Per-provider quotas are tracked automatically.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: {
            type: 'integer',
            minimum: 1,
            maximum: 25,
            default: 10,
            description: 'Max number of results to return',
          },
        },
        required: ['query'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Task',
      description:
        "Spawn an independent Claude Code subagent. Multiple Task calls in the same response run concurrently — use this when you have independent workstreams that can proceed in parallel. Each subagent receives the full prompt and returns its final response. Do NOT use for work that depends on another Task's result; those must be sequential turns.",
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Short label shown in progress output (e.g. "Audit auth module")',
          },
          prompt: {
            type: 'string',
            description:
              'Complete self-contained instructions for the subagent. Include all context it needs — it has no memory of this conversation.',
          },
        },
        required: ['description', 'prompt'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'TodoWrite',
      description:
        'Save the session task list. Replaces the entire list. Use to track multi-step plans, mark steps complete, and keep work organised across tool calls.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique identifier, e.g. "1" or "auth-fix"' },
                content: { type: 'string', description: 'Task description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['id', 'content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'TodoRead',
      description:
        'Load the session task list saved by TodoWrite. Returns all tasks with their current status.',
      parameters: { type: 'object', properties: {} },
    },
  },

  {
    type: 'function',
    function: {
      name: 'AskUser',
      description:
        'Ask the user a multiple-choice question and wait for their answer. Renders an interactive selection form in the chat. Use this whenever you need user input on choices, preferences, or branching decisions — instead of guessing or asking in plain text. Drop-in replacement for the unavailable built-in AskUserQuestion: same schema, same semantics. Blocks until the user submits an answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions to ask the user (1-4 questions).',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question. Should be clear and end with a question mark.',
                },
                header: {
                  type: 'string',
                  description: 'Very short label displayed as a chip/tag (max 12 chars).',
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow the user to select multiple options. Default false.',
                },
                options: {
                  type: 'array',
                  description: 'The available choices (2-4). Each must be distinct and mutually exclusive unless multiSelect is true.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Concise display text (1-5 words).' },
                      description: { type: 'string', description: 'Explanation of what this option means or implies.' },
                    },
                    required: ['label', 'description'],
                  },
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'Frontend',
      description:
        'Inspect or control the user\'s currently visible YPA app tab from inside the active chat. This operates the existing app directly; it does NOT open a remote browser. Use list_tabs after a session switch, then pass session_id to continue controlling the new visible session.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_commands',
              'run_command',
              'get_state',
              'list_surfaces',
              'focus_surface',
              'close_surface',
              'list_manifest',
              'open_terminal',
              'list_models',
              'new_session',
              'set_model',
              'send_message',
              'list_tabs',
            ],
            description: 'Frontend operation to perform in the visible YPA tab.',
          },
          command_id: {
            type: 'string',
            description: 'Stable command id from list_commands; required for run_command.',
          },
          surface_id: {
            type: 'string',
            description: 'Stable surface id from list_surfaces; required for focus_surface or close_surface.',
          },
          model_query: {
            type: 'string',
            description: 'Model name or unambiguous search text; required for set_model.',
          },
          message: {
            type: 'string',
            description: 'Chat message text; required for send_message.',
          },
          session_id: {
            type: 'string',
            description: 'Visible target session returned by new_session or list_tabs. Defaults to the invoking chat session.',
          },
        },
        required: ['action'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'RunCode',
      description:
        'Execute Python 3 code in a subprocess scoped to the session working directory. Use for data processing, filtering large results, aggregating multiple tool outputs, and any computation better done in code than in context. Intermediate values stay in Python variables — only final stdout is returned. The built-in `yha` module exposes bridge tools callable from within code: yha.bash(cmd), yha.read(path), yha.write(path, content), yha.grep(pattern, path, glob), yha.glob_files(pattern, path), yha.web_fetch(url), yha.web_search(query, num). yha.cwd holds the session working directory. Use when you need loops, conditionals, filtering, or multi-tool aggregation — this is the provider-agnostic equivalent of Programmatic Tool Calling.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python 3 source code to execute' },
        },
        required: ['code'],
      },
    },
  },
];

// ── Register the static catalog into `tools` ─────────────────────────────
// Done once on module load. Each entry uses the OpenAI function name as
// `id` so `register.list()` round-trips byte-identically with
// `BRIDGE_TOOL_DEFS_STATIC`. `core: true` pins the entry so module
// teardown can never wipe the baseline catalog.
{
  let _coreOrder = 0;
  for (const def of BRIDGE_TOOL_DEFS_STATIC) {
    bridgeRegisters.tools.add(
      {
        id: def.function.name,
        order: 10 + _coreOrder++,
        core: true,
        // Carry the OpenAI shape on the entry so list() consumers don't
        // have to rebuild it. Preserved fields: type, function.
        ...def,
      },
      '<core>'
    );
  }
}

// Dynamic tool list: registered tools (core + any module that
// `ctx.registers.tools.add(...)`'d) + MCP-derived tools from running
// servers. Duplicate names across MCP servers are prefixed with
// serverName_ to avoid Gemini rejection.
//
// `options.audience` decides which MCP servers can contribute tools.
// The pet module's audience policy is ternary ('all' / 'chat-only' /
// 'pet-only'); this function delegates the per-server decision to
// `mcp-audience.skipForAudience(name, audience)` so the filter is
// symmetric:
//   • 'main' (default) — main chat tool list AND the MCP-Tools aggregator
//     consumed by spawned harnesses. Hides 'pet-only' servers.
//   • 'pet'             — the pet console. Hides 'chat-only' servers.
//   • 'all'-scoped servers are visible to both.
function getBridgeToolDefs(options?: { audience?: 'main' | 'pet' }) {
  const audience: 'main' | 'pet' = options?.audience === 'pet' ? 'pet' : 'main';
  let skipForAudience: (name: string) => boolean = () => false;
  try {
    const audienceMod = require('../modules/pet/lib/mcp-audience');
    skipForAudience = (name: string) => audienceMod.skipForAudience(name, audience);
  } catch (_e) { /* pet module not loaded — no filter (every server is 'all') */ }

  // Strip register meta (id/module/order/core/before/after/when) so the
  // returned shape is byte-equivalent to the pre-register array.
  const registered = bridgeRegisters.tools.list().map((entry: any) => ({
    type: entry.type,
    function: entry.function,
  }));

  const nameCount = new Map();
  for (const [serverName, conn] of mcpConnections) {
    if (!conn.ok) continue;
    if (skipForAudience(serverName)) continue;
    for (const t of conn.tools) nameCount.set(t.name, (nameCount.get(t.name) || 0) + 1);
  }
  const mcpTools = [];
  for (const [serverName, conn] of mcpConnections) {
    if (!conn.ok) continue;
    if (skipForAudience(serverName)) continue;
    for (const t of conn.tools) {
      const safeName =
        nameCount.get(t.name) > 1
          ? `${serverName.replace(/[^a-zA-Z0-9]/g, '_')}_${t.name}`
          : t.name;
      mcpTools.push({
        type: 'function',
        function: {
          name: safeName,
          description: `[MCP:${serverName}] ${t.desc}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  const allDefs = [...registered, ...mcpTools];
  const defaults = config.defaults || {};
  if (defaults.tool_command_overwrite_enabled !== true) return allDefs;
  const allowedRaw = Array.isArray(defaults.tool_command_overwrite_tools)
    ? defaults.tool_command_overwrite_tools
    : DEFAULT_OVERWRITE_TOOLS;
  const allowed = new Set(allowedRaw.map((v) => String(v || '').trim()).filter(Boolean));
  return allDefs.filter((t) => {
    const name = t?.function?.name;
    if (!name) return false;
    if (allowed.has(name)) return true;
    const parts = String(name).split('_');
    if (parts.length > 1) {
      const rawName = parts.slice(1).join('_');
      if (allowed.has(rawName)) return true;
    }
    return false;
  });
}

function getGeminiToolDefs() {
  return [
    {
      function_declarations: getBridgeToolDefs().map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: sanitizeGeminiSchema(t.function.parameters),
      })),
    },
  ];
}

module.exports = {
  BRIDGE_TOOL_DEFS_STATIC,
  getBridgeToolDefs,
  getGeminiToolDefs,
  addCwdToPreset,
};
