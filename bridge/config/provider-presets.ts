// ── Built-in provider presets ─────────────────────────────────────────────────
// Read-only templates for the well-known providers. The user can "load" any
// preset into their config — that materialises a regular provider entry
// (config.providers[]) tagged with `preset_id`. After load the user owns the
// copy; editing it never touches the preset definition here.
//
// Presets live in code (not config.json) so a stale or removed entry never
// causes a load failure. New providers can be added by editing this array.
'use strict';

interface ProviderPreset {
  id: string;
  display_name: string;
  default_name: string;
  endpoint: string;
  api_style: 'anthropic' | 'openai' | 'google';
  env_key: string;
  fetch_live: boolean;
  key_link?: string;
  notes?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    display_name: 'Anthropic',
    default_name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    api_style: 'anthropic',
    env_key: 'ANTHROPIC_API_KEY',
    fetch_live: true,
    key_link: 'https://platform.claude.com/settings/keys',
    notes: 'Claude models (Sonnet, Opus, Haiku)',
  },
  {
    id: 'openai',
    display_name: 'OpenAI',
    default_name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    api_style: 'openai',
    env_key: 'OPENAI_API_KEY',
    fetch_live: true,
    key_link: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    display_name: 'Google',
    default_name: 'Google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    api_style: 'google',
    env_key: 'GOOGLE_API_KEY',
    fetch_live: true,
    key_link: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'openrouter',
    display_name: 'OpenRouter',
    default_name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    api_style: 'openai',
    env_key: 'OPENROUTER_API_KEY',
    fetch_live: true,
    key_link: 'https://openrouter.ai/settings/keys',
    notes: 'Unified API for 100+ models',
  },
  {
    id: 'nvidia',
    display_name: 'NVIDIA NIM',
    default_name: 'NVIDIA',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    api_style: 'openai',
    env_key: 'NVIDIA_API_KEY',
    fetch_live: true,
    key_link: 'https://build.nvidia.com/settings/api-keys',
  },
  {
    id: 'deepseek',
    display_name: 'DeepSeek',
    default_name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    api_style: 'openai',
    env_key: 'DEEPSEEK_API_KEY',
    fetch_live: true,
    key_link: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'grok',
    display_name: 'Grok (xAI)',
    default_name: 'Grok',
    endpoint: 'https://api.x.ai/v1',
    api_style: 'openai',
    env_key: 'GROK_API_KEY',
    fetch_live: true,
    key_link: 'https://console.x.ai/team/default/api-keys',
  },
  {
    id: 'local-ollama',
    display_name: 'Ollama (local)',
    default_name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    api_style: 'openai',
    env_key: '',
    fetch_live: true,
    notes: 'Local Ollama instance — OpenAI-compat API',
  },
  {
    id: 'local-lmstudio',
    display_name: 'LM Studio (local)',
    default_name: 'LM Studio',
    endpoint: 'http://localhost:1234/v1',
    api_style: 'openai',
    env_key: '',
    fetch_live: true,
    notes: 'Local LM Studio — OpenAI-compat API',
  },
  {
    id: 'local-custom',
    display_name: 'Custom local server',
    default_name: 'Local',
    endpoint: 'http://localhost:8080/v1',
    api_style: 'openai',
    env_key: '',
    fetch_live: false,
    notes: 'Generic OpenAI-compatible local server (vLLM, llama.cpp, …)',
  },
];

function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

module.exports = { PROVIDER_PRESETS, findPreset };
