// HatchModal — pet-creation wizard.
//
// The wizard has four steps. Step 1 collects spec; step 2 produces the
// canonical base; step 3 walks the user through one strip per animation
// row; step 4 finalizes the manifest and activates the pet.
//
// All long-form prompt text lives in PromptCard (a code block + copy
// button + drop zone). The wizard never calls Grok itself — the user
// copies the prompt into Grok manually, downloads the PNG, and drops it
// onto the wizard.

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ARCHETYPES,
  PLANS,
  ROWS,
  buildBasePrompt,
  buildSinglePrompt,
  buildStripPrompt,
  planRoundCount,
  planRows,
  suggestFilename,
} from './index.js';
import type { CharacterSpec, RowName } from './index.js';
import { useHatchStore } from '../store/hatchStore.js';
import { PromptCard } from './PromptCard.js';

export function HatchModal() {
  const open = useHatchStore((s) => s.open);
  if (!open) return null;
  return createPortal(<HatchModalInner />, document.body);
}

function HatchModalInner() {
  const closeWizard = useHatchStore((s) => s.closeWizard);
  const reset = useHatchStore((s) => s.reset);
  const step = useHatchStore((s) => s.step);
  const upgradeMode = useHatchStore((s) => s.upgradeMode);
  const petName = useHatchStore((s) => s.petName);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeWizard();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeWizard]);

  const stepLabel = step === 1 ? 'Describe' : step === 2 ? 'Canonical base' : step === 3 ? 'Animation rows' : 'Activate';

  return (
    <div className="hatch-backdrop" role="dialog" aria-modal="true" aria-label={upgradeMode ? `Upgrade ${petName}` : 'Hatch a YHA pet'}>
      <div className="hatch-modal">
        <header className="hatch-head">
          <strong>{upgradeMode ? `🔧 Upgrade ${petName}` : '🥚 Hatch a YHA pet'}</strong>
          <span className="hatch-sub">
            {upgradeMode
              ? `Adding missing rows — ${stepLabel}`
              : `Step ${step} of 4 — ${stepLabel}`}
          </span>
          <div className="hatch-head-actions">
            <button className="hatch-btn-ghost" onClick={() => reset()} title="Discard wizard progress and start over">Reset</button>
            <button className="hatch-btn-ghost" onClick={closeWizard} title="Close — progress is preserved">Close</button>
          </div>
        </header>

        <main className="hatch-body">
          {step === 1 ? <Step1Describe /> : null}
          {step === 2 && !upgradeMode ? <Step2Base /> : null}
          {step === 3 ? <Step3Rows /> : null}
          {step === 4 ? <Step4Activate /> : null}
        </main>

        <footer className="hatch-foot">
          <ErrorRow />
          <NavRow />
        </footer>
      </div>
    </div>
  );
}

function ErrorRow() {
  const error = useHatchStore((s) => s.error);
  if (!error) return null;
  return <div className="hatch-error" role="alert">{error}</div>;
}

function NavRow() {
  const step = useHatchStore((s) => s.step);
  const setStep = useHatchStore((s) => s.setStep);
  const petId = useHatchStore((s) => s.petId);
  const baseUploaded = useHatchStore((s) => s.baseUploaded);
  const plan = useHatchStore((s) => s.plan);
  const rows = useHatchStore((s) => s.rows);
  const upgradeMode = useHatchStore((s) => s.upgradeMode);

  const canGoNext = useMemo(() => {
    if (step === 1) return Boolean(petId && plan);
    if (step === 2) return Boolean(baseUploaded);
    if (step === 3) {
      const required = planRows(plan);
      return required.every((r) => rows[r]?.uploaded);
    }
    return false;
  }, [step, petId, baseUploaded, plan, rows]);

  // In upgrade mode, Step 2 (canonical base) is skipped — we already have one.
  function nextStep(): 1 | 2 | 3 | 4 {
    if (step === 1 && upgradeMode) return 3;
    return (step + 1) as 1 | 2 | 3 | 4;
  }
  function prevStep(): 1 | 2 | 3 | 4 {
    if (step === 3 && upgradeMode) return 1;
    return (step - 1) as 1 | 2 | 3 | 4;
  }

  return (
    <div className="hatch-nav">
      <button
        className="hatch-btn-ghost"
        disabled={step <= 1}
        onClick={() => setStep(prevStep())}
      >
        ← Back
      </button>
      {step < 4 ? (
        <button
          className="hatch-btn-primary"
          disabled={!canGoNext}
          onClick={() => setStep(nextStep())}
        >
          Next →
        </button>
      ) : null}
    </div>
  );
}

// ── Step 1: Describe ────────────────────────────────────────────────────

function Step1Describe() {
  const petName = useHatchStore((s) => s.petName);
  const petId = useHatchStore((s) => s.petId);
  const archetypeId = useHatchStore((s) => s.archetypeId);
  const spec = useHatchStore((s) => s.spec);
  const plan = useHatchStore((s) => s.plan);
  const description = useHatchStore((s) => s.description);
  const upgradeMode = useHatchStore((s) => s.upgradeMode);
  const existingManifest = useHatchStore((s) => s.existingManifest);
  const setName = useHatchStore((s) => s.setName);
  const setArchetype = useHatchStore((s) => s.setArchetype);
  const setSpecField = useHatchStore((s) => s.setSpecField);
  const setPlan = useHatchStore((s) => s.setPlan);
  const setDescription = useHatchStore((s) => s.setDescription);

  const hatchPersisted = Boolean(existingManifest?.hatch?.spec);

  return (
    <div className="hatch-step hatch-step-1">
      <p className="hatch-intro">
        {upgradeMode ? (
          hatchPersisted
            ? 'Spec recovered from the existing manifest. Review and continue — or tweak before generating new rows.'
            : 'This pet was hatched before spec persistence existed. Pick the matching archetype (or fill the slots freeform) so the new row prompts use the same identity as the existing frames.'
        ) : (
          'Describe the pet. The wizard renders prompts you copy into Grok manually. Grok auth is intentionally not wired — paste, generate, drop the PNG back here.'
        )}
      </p>

      <div className="hatch-field">
        <label htmlFor="hatch-name">Name <span className="hatch-required">*</span></label>
        <input
          id="hatch-name"
          type="text"
          value={petName}
          maxLength={32}
          placeholder="e.g. Goblin Tinker"
          disabled={upgradeMode}
          onChange={(e) => setName(e.target.value)}
        />
        <small>id: <code>{petId || '—'}</code> {upgradeMode ? '(locked — upgrading existing pet)' : '(used as folder name; lowercase a–z, 0–9, hyphen)'}</small>
      </div>

      <div className="hatch-field">
        <label htmlFor="hatch-plan">Plan <span className="hatch-required">*</span></label>
        <div className="hatch-plan-grid">
          {Object.values(PLANS).map((p) => (
            <button
              key={p.name}
              className={`hatch-plan-card${plan === p.name ? ' is-active' : ''}`}
              onClick={() => setPlan(p.name)}
              type="button"
            >
              <strong>{p.label}</strong>
              <span className="hatch-plan-rounds">{planRoundCount(p.name)} animations</span>
              <span className="hatch-plan-desc">{p.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="hatch-field">
        <label>Archetype (optional)</label>
        <div className="hatch-archetype-grid">
          <button
            type="button"
            className={`hatch-archetype-card${archetypeId === null ? ' is-active' : ''}`}
            onClick={() => setArchetype(null)}
          >
            <strong>Free-form</strong>
            <span>Fill the slots yourself.</span>
          </button>
          {ARCHETYPES.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`hatch-archetype-card${archetypeId === a.id ? ' is-active' : ''}`}
              onClick={() => setArchetype(a.id)}
            >
              <strong>{a.label}</strong>
              <span>{a.description}</span>
            </button>
          ))}
        </div>
      </div>

      <SpecEditor spec={spec} onField={setSpecField} />

      <div className="hatch-field">
        <label htmlFor="hatch-desc">Optional manifest description</label>
        <textarea
          id="hatch-desc"
          rows={2}
          placeholder="Notes for the JSON manifest's description field."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </div>
  );
}

interface SpecEditorProps {
  spec: CharacterSpec;
  onField: <K extends keyof CharacterSpec>(field: K, value: CharacterSpec[K]) => void;
}

function SpecEditor({ spec, onField }: SpecEditorProps) {
  const fields: Array<{ key: keyof CharacterSpec; label: string; placeholder: string }> = [
    { key: 'silhouette', label: 'Silhouette', placeholder: 'compact chibi heroic warrior, chunky body, tiny limbs' },
    { key: 'palette', label: 'Palette', placeholder: 'warm tan skin, blond bob, brown harness, red cape' },
    { key: 'props', label: 'Props', placeholder: 'small silver sword with gold hilt' },
    { key: 'signatureMove', label: 'Signature move', placeholder: 'raises sword overhead with attached gold charge' },
    { key: 'faceLanguage', label: 'Face language', placeholder: 'simple readable face, expressive eyes, tiny mouth' },
    { key: 'styleNotes', label: 'Style notes', placeholder: 'extra: tiny scar over right eye, leather wrist guards' },
    { key: 'species', label: 'Species (optional)', placeholder: 'human / robot / goblin / sprite …' },
  ];
  return (
    <div className="hatch-spec-grid">
      {fields.map((f) => (
        <div key={f.key as string} className="hatch-field hatch-field-compact">
          <label htmlFor={`hatch-spec-${f.key as string}`}>{f.label}</label>
          <input
            id={`hatch-spec-${f.key as string}`}
            type="text"
            value={(spec[f.key] as string) || ''}
            placeholder={f.placeholder}
            onChange={(e) => onField(f.key, e.target.value as CharacterSpec[typeof f.key])}
          />
        </div>
      ))}
    </div>
  );
}

// ── Step 2: Canonical base ──────────────────────────────────────────────

function Step2Base() {
  const spec = useHatchStore((s) => s.spec);
  const baseBlob = useHatchStore((s) => s.baseBlob);
  const basePreviewUrl = useHatchStore((s) => s.basePreviewUrl);
  const baseUploaded = useHatchStore((s) => s.baseUploaded);
  const busy = useHatchStore((s) => s.busy);
  const setBaseBlob = useHatchStore((s) => s.setBaseBlob);
  const uploadBaseToBridge = useHatchStore((s) => s.uploadBaseToBridge);

  const prompt = useMemo(() => buildBasePrompt(spec), [spec]);

  return (
    <div className="hatch-step hatch-step-2">
      <p className="hatch-intro">
        Paste the prompt into Grok, download the resulting 960×960 PNG, drop it below.
        The base reference locks the pet's identity for every later frame — get it right.
      </p>
      <PromptCard
        prompt={prompt}
        suggestedFilename={suggestFilename('base')}
        accepted={Boolean(baseBlob)}
        previewUrl={basePreviewUrl}
        onFile={(blob) => void setBaseBlob(blob)}
        onClear={() => void setBaseBlob(null)}
      />
      <div className="hatch-step-actions">
        <button
          className="hatch-btn-primary"
          disabled={!baseBlob || busy || baseUploaded}
          onClick={() => void uploadBaseToBridge()}
        >
          {baseUploaded ? '✓ Base uploaded' : busy ? 'Uploading…' : 'Upload base'}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Animation rows ──────────────────────────────────────────────

function Step3Rows() {
  const plan = useHatchStore((s) => s.plan);
  const upgradeMode = useHatchStore((s) => s.upgradeMode);
  const slots = useHatchStore((s) => s.rows);
  const existingManifest = useHatchStore((s) => s.existingManifest);
  // In upgrade mode, hide rows already covered by the existing manifest —
  // openUpgrade pre-fills those slots with `uploaded: true`. Show only the
  // rows the user actually still needs to generate.
  const rows = useMemo(
    () =>
      planRows(plan).filter((r) => !upgradeMode || !slots[r]?.uploaded),
    [plan, upgradeMode, slots],
  );
  // Derive a preview image: prefer the top-level src (new hatched pets), fall
  // back to the first frame src (old codex-imported pets have no top-level src).
  const previewSrc = useMemo(() => {
    if (!upgradeMode || !existingManifest) return null;
    const idle = existingManifest.poses?.idle as { src?: string; frames?: { src: string }[] } | undefined;
    return idle?.src || idle?.frames?.[0]?.src || null;
  }, [upgradeMode, existingManifest]);

  return (
    <div className="hatch-step hatch-step-3">
      {previewSrc ? (
        <div className="hatch-upgrade-preview">
          <img src={previewSrc} alt={existingManifest?.label ?? ''} />
        </div>
      ) : null}
      <p className="hatch-intro">
        {upgradeMode
          ? rows.length
            ? `Only the ${rows.length === 1 ? 'missing row' : `${rows.length} missing rows`} below need new strips. Existing rows stay untouched.`
            : 'No missing rows for this plan — jump to the activation step.'
          : 'One strip per row. Grok produces a single 960×960 sheet with all frames laid out on a grid; the wizard slices it into individual frames automatically.'}
      </p>
      <div className="hatch-rows">
        {rows.map((row) => <RowCard key={row} row={row} />)}
      </div>
    </div>
  );
}

interface RowCardProps {
  row: RowName;
}

function RowCard({ row }: RowCardProps) {
  const spec = useHatchStore((s) => s.spec);
  const slot = useHatchStore((s) => s.rows[row]);
  const busy = useHatchStore((s) => s.busy);
  const setRowStrip = useHatchStore((s) => s.setRowStrip);
  const replaceRowFrame = useHatchStore((s) => s.replaceRowFrame);
  const uploadRowFramesToBridge = useHatchStore((s) => s.uploadRowFramesToBridge);
  const targetRow = useHatchStore((s) => s.targetRow);
  const clearTargetRow = useHatchStore((s) => s.clearTargetRow);

  const def = ROWS[row];
  const stripPrompt = useMemo(() => buildStripPrompt(spec, row), [spec, row]);
  const cardRef = useRef<HTMLDetailsElement | null>(null);

  // When the wizard was opened with a specific target row (e.g. from the
  // nudge modal's ghost-card Generate button), scroll this card into view
  // and open the <details> so the user lands on its prompt + dropzone
  // immediately. Clears the target so subsequent renders don't keep
  // re-scrolling on every state update.
  const isTarget = targetRow === row;
  useEffect(() => {
    if (!isTarget || !cardRef.current) return;
    cardRef.current.setAttribute('open', '');
    cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Add a brief highlight class so the user's eye is drawn to it.
    cardRef.current.classList.add('is-target-pulse');
    const handle = window.setTimeout(() => {
      cardRef.current?.classList.remove('is-target-pulse');
      clearTargetRow();
    }, 2500);
    return () => window.clearTimeout(handle);
  }, [isTarget, clearTargetRow]);

  return (
    <details
      ref={cardRef}
      className={`hatch-row-card${slot?.uploaded ? ' is-uploaded' : ''}${slot?.frameBlobs?.length ? ' is-sliced' : ''}`}
    >
      <summary>
        <span className="hatch-row-title">{row}</span>
        <span className="hatch-row-meta">
          {def.frames} frames @ {def.stripLayout.cols}×{def.stripLayout.rows}
        </span>
        <span className="hatch-row-status">
          {slot?.uploaded ? '✓ uploaded' : slot?.frameBlobs?.length ? 'sliced — ready to upload' : 'awaiting strip'}
        </span>
      </summary>

      <PromptCard
        prompt={stripPrompt}
        suggestedFilename={suggestFilename(row)}
        accepted={Boolean(slot?.stripBlob)}
        previewUrl={slot?.stripPreviewUrl ?? null}
        onFile={(blob) => void setRowStrip(row, blob)}
        onClear={() => {
          /* strip stays cached; user can re-drop to overwrite */
        }}
      />

      {slot?.frameBlobs?.length ? (
        <div className="hatch-frame-grid">
          {slot.frameBlobs.map((_, i) => (
            <FrameCell
              key={i}
              row={row}
              index={i + 1}
              previewUrl={slot.framePreviewUrls?.[i] ?? null}
              onReplace={(blob) => void replaceRowFrame(row, i + 1, blob)}
            />
          ))}
        </div>
      ) : null}

      {slot?.frameBlobs?.length ? (
        <div className="hatch-step-actions">
          <button
            className="hatch-btn-primary"
            disabled={busy || slot.uploaded}
            onClick={() => void uploadRowFramesToBridge(row)}
          >
            {slot.uploaded ? '✓ Frames uploaded' : busy ? 'Uploading…' : `Upload ${slot.frameBlobs.length} frames`}
          </button>
        </div>
      ) : null}
    </details>
  );
}

interface FrameCellProps {
  row: RowName;
  index: number;
  previewUrl: string | null;
  onReplace: (blob: Blob) => void;
}

function FrameCell({ row, index, previewUrl, onReplace }: FrameCellProps) {
  const spec = useHatchStore((s) => s.spec);
  const def = ROWS[row];
  const rerollPrompt = useMemo(() => buildSinglePrompt(spec, row, index), [spec, row, index]);

  return (
    <div className="hatch-frame-cell">
      <div className="hatch-frame-thumb">
        {previewUrl ? <img src={previewUrl} alt={`${row}-${index}`} /> : <span>—</span>}
      </div>
      <div className="hatch-frame-meta">
        <strong>{row}-{String(index).padStart(2, '0')}</strong>
        <span>{def.durations[index - 1] ?? def.durations[def.durations.length - 1]} ms</span>
      </div>
      <details className="hatch-frame-reroll">
        <summary>Re-roll this frame</summary>
        <PromptCard
          prompt={rerollPrompt}
          suggestedFilename={suggestFilename(row, index)}
          accepted={false}
          previewUrl={null}
          onFile={(blob) => onReplace(blob)}
          onClear={() => undefined}
          dense
        />
      </details>
    </div>
  );
}

// ── Step 4: Activate ────────────────────────────────────────────────────

function Step4Activate() {
  const spec = useHatchStore((s) => s.spec);
  const plan = useHatchStore((s) => s.plan);
  const rows = useHatchStore((s) => s.rows);
  const finalizing = useHatchStore((s) => s.finalizing);
  const upgradeMode = useHatchStore((s) => s.upgradeMode);
  const finalizeAndActivate = useHatchStore((s) => s.finalizeAndActivate);
  const closeWizard = useHatchStore((s) => s.closeWizard);

  const required = useMemo(() => planRows(plan), [plan]);
  // In upgrade mode, only show rows with freshly generated frame previews —
  // existing rows have placeholder slots without frames.
  const reviewRows = upgradeMode
    ? required.filter((r) => rows[r]?.framePreviewUrls?.length)
    : required;
  const totalFrames = reviewRows.reduce((sum, r) => sum + (rows[r]?.frameBlobs?.length ?? 0), 0);

  return (
    <div className="hatch-step hatch-step-4">
      <p className="hatch-intro">
        {upgradeMode
          ? <>Review the new rows below. On activate, the merged manifest writes back to <code>/pets/{spec.id}.json</code> and the floating pet picks up the new poses immediately.</>
          : <>Review the contact sheet. When you activate, the manifest writes to <code>/pets/{spec.id}.json</code> and the floating pet switches over immediately.</>}
      </p>
      <div className="hatch-summary">
        <div><strong>Pet</strong> {spec.name} <code>({spec.id})</code></div>
        <div>
          <strong>Plan</strong> {PLANS[plan].label} — {upgradeMode
            ? <>adding {reviewRows.length} {reviewRows.length === 1 ? 'row' : 'rows'} ({totalFrames} new frames)</>
            : <>{required.length} rows, {totalFrames} frames</>}
        </div>
      </div>
      <div className="hatch-contact-sheet">
        {reviewRows.map((row) => {
          const slot = rows[row];
          if (!slot?.framePreviewUrls?.length) {
            return (
              <div className="hatch-contact-row" key={row}>
                <strong>{row}</strong>
                <em>no frames yet</em>
              </div>
            );
          }
          return (
            <div className="hatch-contact-row" key={row}>
              <strong>{row}</strong>
              <div className="hatch-contact-frames">
                {slot.framePreviewUrls.map((url, i) => (
                  <img key={i} src={url} alt={`${row}-${i + 1}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="hatch-step-actions">
        <button
          className="hatch-btn-primary"
          disabled={finalizing}
          onClick={async () => {
            await finalizeAndActivate();
            // If finalizing succeeded the modal can close; the user can
            // confirm via the floating pet rendering the new sprite.
            const state = useHatchStore.getState();
            if (!state.error) closeWizard();
          }}
        >
          {finalizing
            ? upgradeMode ? 'Merging…' : 'Activating…'
            : upgradeMode ? 'Save upgrade' : 'Activate as my pet'}
        </button>
      </div>
    </div>
  );
}
