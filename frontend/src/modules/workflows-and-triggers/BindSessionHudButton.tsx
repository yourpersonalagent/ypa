import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { workflow } from '../../workflows/workflow.js';

export function BindSessionHudButton() {
  const wfId = useAppStore((s) => s.workflow.id);
  const currentSessionId = useSessionStore((s) => s.currentId);
  const [bindRevision, setBindRevision] = useState(0);

  useEffect(() => {
    function onChanged() { setBindRevision((v) => v + 1); }
    window.addEventListener('yha:wf-binding-changed', onChanged);
    return () => window.removeEventListener('yha:wf-binding-changed', onChanged);
  }, []);

  const isBound = (() => {
    void bindRevision;
    if (!wfId) return false;
    try {
      const bindings = JSON.parse(localStorage.getItem('yha.wf-bindings') || '{}') as Record<string, string>;
      return !!(bindings[wfId] && String(bindings[wfId]) === String(currentSessionId));
    } catch { return false; }
  })();

  return (
    <button
      className={`hud-btn${isBound ? ' hud-bound' : ''}`}
      id="btn-bind-session"
      title={isBound ? 'Unbind from session' : 'Bind to session'}
      onClick={() => workflow.bindCurrentToSession()}
    >
      {isBound ? '⇎' : '⇌'}
    </button>
  );
}
