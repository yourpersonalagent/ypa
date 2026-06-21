// ModelBadge — syncs #chat-model-btn text to appStore.currentModel.
// The button is a vanilla DOM element created by chat.init() AFTER the first
// React render, so we can't rely on a single mount-time ref. Instead we run
// sync() on every model change AND via a MutationObserver, so the text is
// applied correctly whenever the button appears or the model is restored from
// server prefs.

import { useEffect } from 'react';
import { useAppStore } from '../stores/index.js';

function providerChipShort(provider: string | undefined): string {
  if (!provider) return '';
  const claudeSub = /^Anthropic-SUB(\d*)$/.exec(provider);
  if (claudeSub) return 'SUB' + (claudeSub[1] || '');
  if (provider === 'Anthropic Subscription') return 'SUB';
  const openaiSub = /^OpenAI-SUB(\d*)$/.exec(provider);
  if (openaiSub) return 'SUB' + (openaiSub[1] || '');
  if (provider === 'OpenAI Subscription') return 'SUB';
  if (provider === 'Anthropic' || provider === 'Anthropic API' || provider === 'OpenAI') return 'API';
  return '';
}

export function ModelBadge() {
  const model = useAppStore((s) => s.currentModel);

  useEffect(() => {
    function sync() {
      const el = document.getElementById('chat-model-btn');
      if (!el || !model?.name) return;
      const chip = providerChipShort(model.provider);
      const text = chip ? `${model.name} [${chip}]` : model.name;
      if (el.textContent !== text) el.textContent = text;
    }
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [model]);

  return null;
}
