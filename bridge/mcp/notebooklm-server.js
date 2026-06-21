#!/usr/bin/env node
// @ts-check
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── Binary path resolution ────────────────────────────────────────────────────
// Priority: process.argv[2] > bridge/config.json defaults.notebooklm_bin > hardcoded default
const HARDCODED_DEFAULT = '/home/user/notebooklm-py/venv/bin/notebooklm';

function resolveNotebooklmBin() {
  if (process.argv[2]) return process.argv[2];
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.defaults?.notebooklm_bin) return cfg.defaults.notebooklm_bin;
  } catch (_) {}
  return HARDCODED_DEFAULT;
}

// ── MCP stdio transport ───────────────────────────────────────────────────────
let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  // ── Session ────────────────────────────────────────────────────────────────
  {
    name: 'nlm_status',
    description: 'Show current NotebookLM context — active notebook and conversation.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_use',
    description: 'Set the active NotebookLM notebook by name or partial ID.',
    inputSchema: {
      type: 'object',
      properties: { notebook: { type: 'string', description: 'Notebook name or partial ID' } },
      required: ['notebook']
    }
  },
  {
    name: 'nlm_clear',
    description: 'Clear the current NotebookLM notebook context (deselect active notebook).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Notebooks ──────────────────────────────────────────────────────────────
  {
    name: 'nlm_list',
    description: 'List all NotebookLM notebooks.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_create',
    description: 'Create a new NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name for the new notebook' } },
      required: ['name']
    }
  },
  {
    name: 'nlm_delete',
    description: 'Delete a NotebookLM notebook by name or partial ID.',
    inputSchema: {
      type: 'object',
      properties: { notebook: { type: 'string', description: 'Notebook name or partial ID to delete' } },
      required: ['notebook']
    }
  },
  {
    name: 'nlm_rename',
    description: 'Rename the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'New name for the notebook' } },
      required: ['name']
    }
  },
  {
    name: 'nlm_summary',
    description: 'Get an AI-generated summary of the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_metadata',
    description: 'Export notebook metadata with sources list.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Chat ───────────────────────────────────────────────────────────────────
  {
    name: 'nlm_ask',
    description: 'Ask the active NotebookLM notebook a question.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'Question to ask the notebook' } },
      required: ['question']
    }
  },
  {
    name: 'nlm_history',
    description: 'Get conversation history for the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_configure',
    description: 'Configure chat persona and response settings for the active notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Sources ────────────────────────────────────────────────────────────────
  {
    name: 'nlm_source_list',
    description: 'List all sources in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_source_add',
    description: 'Add a source (URL or text) to the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'URL or text content to add as a source' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_add_drive',
    description: 'Add a Google Drive file as a source to the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Google Drive file URL or ID' } },
      required: ['url']
    }
  },
  {
    name: 'nlm_source_add_research',
    description: 'Add a research source to the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Research topic or query' } },
      required: ['query']
    }
  },
  {
    name: 'nlm_source_get',
    description: 'Get details of a source in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_delete',
    description: 'Delete a source from the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID to delete' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_delete_by_title',
    description: 'Delete a source from the active NotebookLM notebook by title.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Exact title of the source to delete' } },
      required: ['title']
    }
  },
  {
    name: 'nlm_source_rename',
    description: 'Rename a source in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source name or partial ID' },
        name: { type: 'string', description: 'New name for the source' }
      },
      required: ['source', 'name']
    }
  },
  {
    name: 'nlm_source_fulltext',
    description: 'Get the full text content of a source in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_refresh',
    description: 'Refresh a source in the active NotebookLM notebook (re-fetch/reprocess).',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_stale',
    description: 'Mark a source as stale in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_wait',
    description: 'Wait for a source to finish processing in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },
  {
    name: 'nlm_source_guide',
    description: 'Get the guide/study guide for a source in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source name or partial ID' } },
      required: ['source']
    }
  },

  // ── Artifacts ──────────────────────────────────────────────────────────────
  {
    name: 'nlm_generate',
    description: 'Generate a NotebookLM artifact. Types: audio, cinematic-video, data-table, flashcards, infographic, mind-map, quiz, report, revise-slide, slide-deck, video.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['audio', 'cinematic-video', 'data-table', 'flashcards', 'infographic', 'mind-map', 'quiz', 'report', 'revise-slide', 'slide-deck', 'video'],
          description: 'Type of artifact to generate'
        }
      },
      required: ['type']
    }
  },
  {
    name: 'nlm_artifact_list',
    description: 'List all artifacts in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_artifact_get',
    description: 'Get details of an artifact in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_artifact_delete',
    description: 'Delete an artifact from the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID to delete' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_artifact_rename',
    description: 'Rename an artifact in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: 'Artifact name or partial ID' },
        name: { type: 'string', description: 'New name for the artifact' }
      },
      required: ['artifact', 'name']
    }
  },
  {
    name: 'nlm_artifact_export',
    description: 'Export an artifact from the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_artifact_suggestions',
    description: 'Get suggestions for an artifact in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_artifact_poll',
    description: 'Poll the generation status of an artifact.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_artifact_wait',
    description: 'Wait for an artifact to finish generating.',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'Artifact name or partial ID' } },
      required: ['artifact']
    }
  },
  {
    name: 'nlm_download',
    description: 'Download a generated artifact. Types: audio, cinematic-video, data-table, flashcards, infographic, mind-map, quiz, report, slide-deck, video.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['audio', 'cinematic-video', 'data-table', 'flashcards', 'infographic', 'mind-map', 'quiz', 'report', 'slide-deck', 'video'],
          description: 'Type of artifact to download'
        },
        output: { type: 'string', description: 'Optional output file path' }
      },
      required: ['type']
    }
  },

  // ── Notes ──────────────────────────────────────────────────────────────────
  {
    name: 'nlm_note_list',
    description: 'List all notes in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_note_create',
    description: 'Create a new note in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content of the note' },
        title: { type: 'string', description: 'Optional title for the note' }
      },
      required: ['content']
    }
  },
  {
    name: 'nlm_note_get',
    description: 'Get a specific note from the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Note title or partial ID' } },
      required: ['note']
    }
  },
  {
    name: 'nlm_note_delete',
    description: 'Delete a note from the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Note title or partial ID to delete' } },
      required: ['note']
    }
  },
  {
    name: 'nlm_note_rename',
    description: 'Rename a note in the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note title or partial ID' },
        name: { type: 'string', description: 'New name for the note' }
      },
      required: ['note', 'name']
    }
  },
  {
    name: 'nlm_note_save',
    description: 'Save the current conversation history as a note in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Share ──────────────────────────────────────────────────────────────────
  {
    name: 'nlm_share_status',
    description: 'Show sharing status of the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_share_add',
    description: 'Share the active NotebookLM notebook with a user.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address of the user to share with' },
        role: { type: 'string', description: 'Role to grant (e.g. reader, writer)' }
      },
      required: ['email']
    }
  },
  {
    name: 'nlm_share_remove',
    description: 'Remove a user from sharing the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Email address of the user to remove' } },
      required: ['email']
    }
  },
  {
    name: 'nlm_share_public',
    description: 'Make the active NotebookLM notebook public or get its public link.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_share_update',
    description: 'Update sharing settings for the active NotebookLM notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address of the user to update' },
        role: { type: 'string', description: 'New role to assign' }
      },
      required: ['email', 'role']
    }
  },
  {
    name: 'nlm_share_view_level',
    description: 'Get or set the view level for sharing the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Research ───────────────────────────────────────────────────────────────
  {
    name: 'nlm_research_status',
    description: 'Check the status of a research operation in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'nlm_research_wait',
    description: 'Wait for a research operation to complete in the active NotebookLM notebook.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },

  // ── Other ──────────────────────────────────────────────────────────────────
  {
    name: 'nlm_language',
    description: 'Manage output language for artifact generation.',
    inputSchema: {
      type: 'object',
      properties: { language: { type: 'string', description: 'Language code or name to set (omit to show current)' } },
      required: []
    }
  }
];

// ── Command execution ─────────────────────────────────────────────────────────
function run(args, timeout = 60000) {
  return new Promise(resolve => {
    const bin = resolveNotebooklmBin();
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out  = (stdout || '').trim();
      const err2 = (stderr || '').trim();
      if (err) resolve({ ok: false, output: err2 || err.message });
      else     resolve({ ok: true,  output: out || err2 || '(no output)' });
    });
  });
}

async function callTool(name, args) {
  switch (name) {
    // Session
    case 'nlm_status':   return run(['status']);
    case 'nlm_use':      return run(['use', args.notebook]);
    case 'nlm_clear':    return run(['clear']);

    // Notebooks
    case 'nlm_list':     return run(['list']);
    case 'nlm_create':   return run(['create', args.name]);
    case 'nlm_delete':   return run(['delete', args.notebook]);
    case 'nlm_rename':   return run(['rename', args.name]);
    case 'nlm_summary':  return run(['summary'], 120000);
    case 'nlm_metadata': return run(['metadata']);

    // Chat
    case 'nlm_ask':      return run(['ask', args.question], 120000);
    case 'nlm_history':  return run(['history']);
    case 'nlm_configure': return run(['configure']);

    // Sources
    case 'nlm_source_list':           return run(['source', 'list']);
    case 'nlm_source_add':            return run(['source', 'add', args.source]);
    case 'nlm_source_add_drive':      return run(['source', 'add-drive', args.url]);
    case 'nlm_source_add_research':   return run(['source', 'add-research', args.query]);
    case 'nlm_source_get':            return run(['source', 'get', args.source]);
    case 'nlm_source_delete':         return run(['source', 'delete', args.source]);
    case 'nlm_source_delete_by_title': return run(['source', 'delete-by-title', args.title]);
    case 'nlm_source_rename':         return run(['source', 'rename', args.source, args.name]);
    case 'nlm_source_fulltext':       return run(['source', 'fulltext', args.source]);
    case 'nlm_source_refresh':        return run(['source', 'refresh', args.source]);
    case 'nlm_source_stale':          return run(['source', 'stale', args.source]);
    case 'nlm_source_wait':           return run(['source', 'wait', args.source], 300000);
    case 'nlm_source_guide':          return run(['source', 'guide', args.source]);

    // Artifacts
    case 'nlm_generate':              return run(['generate', args.type], 300000);
    case 'nlm_artifact_list':         return run(['artifact', 'list']);
    case 'nlm_artifact_get':          return run(['artifact', 'get', args.artifact]);
    case 'nlm_artifact_delete':       return run(['artifact', 'delete', args.artifact]);
    case 'nlm_artifact_rename':       return run(['artifact', 'rename', args.artifact, args.name]);
    case 'nlm_artifact_export':       return run(['artifact', 'export', args.artifact]);
    case 'nlm_artifact_suggestions':  return run(['artifact', 'suggestions', args.artifact]);
    case 'nlm_artifact_poll':         return run(['artifact', 'poll', args.artifact]);
    case 'nlm_artifact_wait':         return run(['artifact', 'wait', args.artifact], 300000);
    case 'nlm_download': {
      const dlArgs = ['download', args.type];
      if (args.output) dlArgs.push('--output', args.output);
      return run(dlArgs, 300000);
    }

    // Notes
    case 'nlm_note_list':   return run(['note', 'list']);
    case 'nlm_note_create': {
      const noteArgs = ['note', 'create', args.content];
      if (args.title) noteArgs.splice(2, 0, '--title', args.title);
      return run(noteArgs);
    }
    case 'nlm_note_get':    return run(['note', 'get', args.note]);
    case 'nlm_note_delete': return run(['note', 'delete', args.note]);
    case 'nlm_note_rename': return run(['note', 'rename', args.note, args.name]);
    case 'nlm_note_save':   return run(['history', '--save-note']);

    // Share
    case 'nlm_share_status':     return run(['share', 'status']);
    case 'nlm_share_add': {
      const shareArgs = ['share', 'add', args.email];
      if (args.role) shareArgs.push('--role', args.role);
      return run(shareArgs);
    }
    case 'nlm_share_remove':     return run(['share', 'remove', args.email]);
    case 'nlm_share_public':     return run(['share', 'public']);
    case 'nlm_share_update':     return run(['share', 'update', args.email, '--role', args.role]);
    case 'nlm_share_view_level': return run(['share', 'view-level']);

    // Research
    case 'nlm_research_status': return run(['research', 'status']);
    case 'nlm_research_wait':   return run(['research', 'wait'], 300000);

    // Other
    case 'nlm_language': {
      const langArgs = ['language'];
      if (args.language) langArgs.push(args.language);
      return run(langArgs);
    }

    default:
      return { ok: false, output: `Unknown tool: ${name}` };
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'notebooklm', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response needed
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    const result = await callTool(name, args);
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        content: [{ type: 'text', text: result.output }],
        isError: !result.ok
      }
    });
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

// ── stdin frame parser ────────────────────────────────────────────────────────
process.stdin.on('data', chunk => {
  inputBuffer += _stdinDecoder.write(chunk);
  while (true) {
    const sep = inputBuffer.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const header = inputBuffer.slice(0, sep);
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { inputBuffer = inputBuffer.slice(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    const bodyStart = sep + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    let msg;
    try { msg = JSON.parse(body); } catch (_) { continue; }
    handleMessage(msg).catch(() => {});
  }
});

process.stdin.resume();
require('./_parent-watchdog').installParentWatchdog();
