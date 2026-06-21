// KnowledgeButtons — manages the #btn-cwd-build / #btn-cwd-synthesize buttons.
// MCP up/down is read from the centralised mcpStore (single shared poller).
// /v1/knowledge/status is fetched on cwd change + every 15 s while mounted —
// previously this was 3 s alongside an independent /v1/mcp/ poll, contributing
// to the rate-limiter blow-up.

import { useEffect, useRef, useState } from 'react';
import { useAppStore, getToastActions, getSessionState } from '../stores/index.js';
import { useMcpRunning } from '../stores/mcpStore.js';
import { bus } from '../state.js';
import { buildSynthesisPrompt } from './knowledgePrompt.js';

const STATUS_POLL_MS = 15_000;

interface KnowledgeStatus { graphExists: boolean; synthCount: number }

function currentCwd(): string | null {
  return useAppStore.getState().sessionWorkingDir
    || getSessionState().defaultWorkingDir
    || null;
}

async function fetchStatus(): Promise<KnowledgeStatus> {
  const cwd = currentCwd();
  if (!cwd) return { graphExists: false, synthCount: 0 };
  try {
    const r = await fetch(`/v1/knowledge/status?workingDir=${encodeURIComponent(cwd)}`);
    if (!r.ok) return { graphExists: false, synthCount: 0 };
    return r.json();
  } catch {
    return { graphExists: false, synthCount: 0 };
  }
}

export function KnowledgeButtons() {
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const mcpRunning = useMcpRunning('knowledge-memory');
  const [status, setStatus] = useState<KnowledgeStatus>({ graphExists: false, synthCount: 0 });
  const [building, setBuilding] = useState(false);
  const buildingRef = useRef(false);

  // Poll graph status on cwd change + every STATUS_POLL_MS while mounted.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const st = await fetchStatus();
      if (cancelled) return;
      setStatus(st);
    }
    poll();
    const id = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionWorkingDir]);

  // Sync the existing static buttons whenever state changes
  useEffect(() => {
    const buildBtn = document.getElementById('btn-cwd-build') as HTMLButtonElement | null;
    if (buildBtn && !buildingRef.current) {
      buildBtn.hidden = false;
      buildBtn.disabled = !mcpRunning;
      buildBtn.textContent = status.graphExists ? 'refresh graph' : 'build graph';
      buildBtn.title = mcpRunning
        ? (status.graphExists
            ? 'Rebuild dependency graph for this working directory'
            : 'Build dependency graph for this working directory')
        : 'Start knowledge-memory MCP first';
      buildBtn.dataset.built = status.graphExists ? 'true' : 'false';
    }

    const synthBtn = document.getElementById('btn-cwd-synthesize') as HTMLButtonElement | null;
    if (synthBtn) {
      synthBtn.hidden = false;
      synthBtn.disabled = !mcpRunning;
      synthBtn.textContent = status.synthCount > 0 ? 're-synthesize' : 'synthesize';
      synthBtn.title = mcpRunning
        ? (status.synthCount > 0
            ? `Regenerate ${status.synthCount} synthesis pages`
            : 'Generate knowledge synthesis pages')
        : 'Start knowledge-memory MCP first';
      synthBtn.dataset.built = status.synthCount > 0 ? 'true' : 'false';
    }
  }, [mcpRunning, status, building]);

  // Wire button clicks
  useEffect(() => {
    async function buildGraph() {
      if (buildingRef.current || !mcpRunning) return;
      const cwd = currentCwd();
      const { show } = getToastActions();
      if (!cwd) { show('Select a working directory first', 'error'); return; }

      buildingRef.current = true;
      setBuilding(true);
      const b = document.getElementById('btn-cwd-build') as HTMLButtonElement | null;
      if (b) {
        b.disabled = true;
        b.textContent = 'building…';
        b.dataset.building = 'true';
        delete b.dataset.built;
      }

      try {
        const br = await fetch('/v1/knowledge/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: cwd }),
        });
        if (!br.ok) {
          const e = await br.json().catch(() => ({ error: `HTTP ${br.status}` }));
          throw new Error((e as { error?: string }).error || `HTTP ${br.status}`);
        }

        const er = await fetch('/v1/knowledge/export-obsidian', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: cwd }),
        });
        if (!er.ok) {
          const e = await er.json().catch(() => ({ error: `HTTP ${er.status}` }));
          throw new Error((e as { error?: string }).error || `HTTP ${er.status}`);
        }
        const ed = (await er.json()) as { filesWritten?: number };
        show(`Graph built — ${ed.filesWritten ?? 0} Obsidian pages updated`, 'success');
      } catch (e) {
        show(`Build failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      } finally {
        buildingRef.current = false;
        setBuilding(false);
        if (b) delete b.dataset.building;
        setStatus(await fetchStatus());
      }
    }

    function injectSynthesisPrompt() {
      if (!mcpRunning) return;
      const cwd = currentCwd();
      if (!cwd) { getToastActions().show('Select a working directory first', 'error'); return; }

      const prompt = buildSynthesisPrompt({
        cwd,
        hasGraph: status.graphExists,
        isUpdate: status.synthCount > 0,
      });

      bus.emit('chat:set-input', prompt);
      requestAnimationFrame(() => {
        (document.getElementById('chat-ta') as HTMLTextAreaElement | null)?.focus();
      });
    }

    const buildBtn = document.getElementById('btn-cwd-build');
    const synthBtn = document.getElementById('btn-cwd-synthesize');
    buildBtn?.addEventListener('click', buildGraph);
    synthBtn?.addEventListener('click', injectSynthesisPrompt);
    return () => {
      buildBtn?.removeEventListener('click', buildGraph);
      synthBtn?.removeEventListener('click', injectSynthesisPrompt);
    };
  }, [mcpRunning, status]);

  return null;
}
