// ChatHeroGrowl — click-and-hold on the empty hero to play a deep space drone.
//
//   Y axis (full window height = two octaves):
//     top  → 112 Hz (two octaves above base)
//     bottom → 28 Hz (base)
//
//   X axis:
//     echo rhythm  — left=0.12s fast stutter, right=0.8s atmospheric
//     chord root   — two octaves across the full width
//     left side    — major 3rd, 4th, 5th, major 7th
//     right side   — minor 3rd, 4th, 5th, minor 7th
//     Every 9% of screen diagonal moved fires a soft reverbed chord bloom.
//
//   Release: linear fade whose length scales with hold duration.

import { useEffect } from 'react';

function makeWaveShaper(ctx: AudioContext): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  const n = 512;
  const curve = new Float32Array(n);
  const k = 80;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

// Pre-computed reverb impulse-response cache.
// Generating a 7-second stereo IR requires ~617K random-number + pow() ops —
// ~35ms of main-thread work. We compute it once and reuse the Float32Arrays
// so subsequent growl sessions only pay a fast typed-array memcpy (~1ms).
let _irLeft: Float32Array<ArrayBuffer> | null = null;
let _irRight: Float32Array<ArrayBuffer> | null = null;
let _irLength = 0;

function computeIR(length: number): void {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const decay = Math.pow(1 - i / length, 2.5);
    left[i] = (Math.random() * 2 - 1) * decay;
    right[i] = (Math.random() * 2 - 1) * decay;
  }
  _irLeft = left;
  _irRight = right;
  _irLength = length;
}

function makeReverb(ctx: AudioContext): ConvolverNode {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * 7);
  const impulse = ctx.createBuffer(2, length, sampleRate);
  if (_irLeft && _irLength === length) {
    // Fast path: reuse cached IR — just a typed-array copy, ~1ms
    impulse.copyToChannel(_irLeft, 0);
    impulse.copyToChannel(_irRight!, 1);
  } else {
    // Slow path: first press before pre-warm fired, or mismatched sample rate
    computeIR(length);
    impulse.copyToChannel(_irLeft!, 0);
    impulse.copyToChannel(_irRight!, 1);
  }
  const conv = ctx.createConvolver();
  conv.buffer = impulse;
  return conv;
}

const PHI = 1.6180339887;
const ECHO_MAX_DELAY = 1.6; // max delay ~0.8s × φ ≈ 1.3s, cap at 1.6
const BASE_HZ = 28; // bottom of drone range
const CHORD_BASE = BASE_HZ * 6; // 168 Hz — low enough to read as atmosphere
const MAJOR_OVER_INTERVALS = [1, 5 / 4, 4 / 3, 3 / 2, 15 / 8] as const;
const MINOR_OVER_INTERVALS = [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5] as const;

type ChordColor = 'major' | 'minor';

// Fire one soft chord bloom. The slow attack and detuned partials make it read
// more like distant resonant metal than a piano note.
function fireChordBloom(
  ctx: AudioContext,
  dest: AudioNode,
  root: number,
  color: ChordColor,
  pan: number
) {
  const t = ctx.currentTime;
  const intervals = color === 'major' ? MAJOR_OVER_INTERVALS : MINOR_OVER_INTERVALS;
  const chordGain = ctx.createGain();
  chordGain.gain.setValueAtTime(0, t);
  chordGain.gain.linearRampToValueAtTime(0.22, t + 0.08);
  chordGain.gain.setTargetAtTime(0, t + 0.16, 1.35);

  const chordFilter = ctx.createBiquadFilter();
  chordFilter.type = 'lowpass';
  chordFilter.frequency.setValueAtTime(1250, t);
  chordFilter.frequency.setTargetAtTime(520, t + 0.1, 0.9);
  chordFilter.Q.value = 0.7;

  const chordPan = ctx.createStereoPanner();
  chordPan.pan.value = pan;

  chordGain.connect(chordFilter);
  chordFilter.connect(chordPan);
  chordPan.connect(dest);

  intervals.forEach((ratio, i) => {
    const gainScale = [0.38, 0.22, 0.18, 0.2, 0.12][i] ?? 0.12;
    const detune = [-5, 3, -2, 5, -4][i] ?? 0;

    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'triangle' : 'sine';
    osc.frequency.value = root * ratio;
    osc.detune.value = detune;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gainScale, t);

    osc.connect(env);
    env.connect(chordGain);
    osc.start(t);
    osc.stop(t + 6.5);
  });
}

function startGrowl(startY: number, startX: number): () => void {
  const ctx = new AudioContext();
  const holdStart = ctx.currentTime;

  // ── Master (drone + echo output) ────────────────────────────────────────────
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0, ctx.currentTime);
  masterGain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 0.6);
  masterGain.connect(ctx.destination);

  // ── Chord blooms go here — separate from the growl LFO, but washed in space ──
  const chordDest = ctx.createGain();
  chordDest.gain.value = 0.85;

  // ── Reverb ───────────────────────────────────────────────────────────────────
  const reverb = makeReverb(ctx);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.55;
  reverb.connect(reverbGain);
  reverbGain.connect(masterGain);

  const chordWet = ctx.createGain();
  chordWet.gain.value = 0.72;
  const chordDry = ctx.createGain();
  chordDry.gain.value = 0.22;
  chordDest.connect(chordWet);
  chordDest.connect(chordDry);
  chordWet.connect(reverb);
  chordDry.connect(ctx.destination);

  // ── Dry ──────────────────────────────────────────────────────────────────────
  const dryGain = ctx.createGain();
  dryGain.gain.value = 0.45;
  dryGain.connect(masterGain);

  // ── Processing chain ─────────────────────────────────────────────────────────
  const shaper = makeWaveShaper(ctx);
  shaper.connect(dryGain);
  shaper.connect(reverb);

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 110;
  lpf.Q.value = 1.5;
  lpf.connect(shaper);

  // ── Oscillators ──────────────────────────────────────────────────────────────
  const oscSub = ctx.createOscillator();
  oscSub.type = 'sawtooth';
  const subGain = ctx.createGain();
  subGain.gain.value = 0.55;
  oscSub.connect(subGain);
  subGain.connect(lpf);

  const osc1 = ctx.createOscillator();
  osc1.type = 'sawtooth';
  osc1.connect(lpf);

  const osc2 = ctx.createOscillator();
  osc2.type = 'triangle';
  osc2.detune.value = 9;
  const osc2Gain = ctx.createGain();
  osc2Gain.gain.value = 0.7;
  osc2.connect(osc2Gain);
  osc2Gain.connect(lpf);

  const osc3 = ctx.createOscillator();
  osc3.type = 'sawtooth';
  const osc3Gain = ctx.createGain();
  osc3Gain.gain.value = 0.18;
  osc3.connect(osc3Gain);
  osc3Gain.connect(lpf);

  // ── Dual-tap echo (shorter, tighter) ─────────────────────────────────────────
  const echoSend = ctx.createGain();
  echoSend.gain.setValueAtTime(0, ctx.currentTime);
  echoSend.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 1.8);
  shaper.connect(echoSend);

  // Tap 1 — centered
  const delay1 = ctx.createDelay(ECHO_MAX_DELAY);
  const echoDark1 = ctx.createBiquadFilter();
  echoDark1.type = 'lowpass';
  echoDark1.frequency.value = 190;
  echoDark1.Q.value = 1.2;
  const echoFB1 = ctx.createGain();
  echoFB1.gain.value = 0.38;
  const echoOut1 = ctx.createGain();
  echoOut1.gain.value = 0.38;
  echoSend.connect(delay1);
  delay1.connect(echoDark1);
  echoDark1.connect(echoFB1);
  echoFB1.connect(delay1);
  echoDark1.connect(echoOut1);
  echoOut1.connect(masterGain);

  // Tap 2 — T×φ, panned right
  const delay2 = ctx.createDelay(ECHO_MAX_DELAY);
  const echoDark2 = ctx.createBiquadFilter();
  echoDark2.type = 'lowpass';
  echoDark2.frequency.value = 145;
  echoDark2.Q.value = 1.4;
  const echoFB2 = ctx.createGain();
  echoFB2.gain.value = 0.3;
  const echoOut2 = ctx.createGain();
  echoOut2.gain.value = 0.26;
  const echoPan2 = ctx.createStereoPanner();
  echoPan2.pan.value = 0.42;
  echoSend.connect(delay2);
  delay2.connect(echoDark2);
  echoDark2.connect(echoFB2);
  echoFB2.connect(delay2);
  echoDark2.connect(echoOut2);
  echoOut2.connect(echoPan2);
  echoPan2.connect(masterGain);

  // ── LFOs ─────────────────────────────────────────────────────────────────────
  const lfoAmp = ctx.createOscillator();
  lfoAmp.type = 'sine';
  lfoAmp.frequency.value = 0.09;
  const lfoAmpGain = ctx.createGain();
  lfoAmpGain.gain.value = 0.12;
  lfoAmp.connect(lfoAmpGain);
  lfoAmpGain.connect(masterGain.gain);
  lfoAmp.start();

  const lfoFreq = ctx.createOscillator();
  lfoFreq.type = 'sine';
  lfoFreq.frequency.value = 0.06;
  const lfoFreqGain = ctx.createGain();
  lfoFreqGain.gain.value = 2.5;
  lfoFreq.connect(lfoFreqGain);
  lfoFreqGain.connect(osc1.frequency);
  lfoFreqGain.connect(osc2.frequency);
  lfoFreq.start();

  // ── Y axis → drone frequency (full window height = two octaves) ──────────────
  function yToFreq(y: number): number {
    // top of window = BASE*4 (112 Hz), bottom = BASE (28 Hz)
    const norm = Math.max(0, Math.min(1, y / window.innerHeight));
    return BASE_HZ * Math.pow(4, 1 - norm);
  }

  function applyFreq(freq: number) {
    const t = ctx.currentTime;
    osc1.frequency.setTargetAtTime(freq, t, 0.08);
    osc2.frequency.setTargetAtTime(freq, t, 0.08);
    osc3.frequency.setTargetAtTime(freq * 2.02, t, 0.08);
    oscSub.frequency.setTargetAtTime(freq * 0.498, t, 0.08);
  }

  // ── X axis → echo delay (left=0.12s fast, right=0.8s dreamy) ─────────────────
  function applyEcho(x: number) {
    const norm = Math.max(0, Math.min(1, x / window.innerWidth));
    const t1 = 0.12 * Math.pow(6.67, norm); // 0.12 → 0.8s
    const t2 = Math.min(t1 * PHI, ECHO_MAX_DELAY - 0.02);
    const now = ctx.currentTime;
    delay1.delayTime.setTargetAtTime(t1, now, 0.25);
    delay2.delayTime.setTargetAtTime(t2, now, 0.25);
  }

  // ── X axis → chord root (two octaves), color (major left, minor right) ───────
  function xToChord(x: number): { root: number; color: ChordColor; pan: number } {
    const norm = Math.max(0, Math.min(1, x / window.innerWidth));
    return {
      root: CHORD_BASE * Math.pow(4, norm), // 168 → 672 Hz
      color: norm < 0.5 ? 'major' : 'minor',
      pan: norm * 1.4 - 0.7,
    };
  }

  applyFreq(yToFreq(startY));
  applyEcho(startX);
  osc1.start();
  osc2.start();
  osc3.start();
  oscSub.start();

  // ── Chord trigger — every 9% of screen diagonal ───────────────────────────────
  const diagThresh = Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2) * 0.09;
  let lastPingX = startX;
  let lastPingY = startY;

  function onMove(e: PointerEvent) {
    applyFreq(yToFreq(e.clientY));
    applyEcho(e.clientX);
    const dx = e.clientX - lastPingX;
    const dy = e.clientY - lastPingY;
    if (Math.sqrt(dx * dx + dy * dy) >= diagThresh) {
      const chord = xToChord(e.clientX);
      fireChordBloom(ctx, chordDest, chord.root, chord.color, chord.pan);
      lastPingX = e.clientX;
      lastPingY = e.clientY;
    }
  }

  // ── Release — linear fade whose length scales with hold duration ──────────────
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);

    // 0.3s hold → 1.5s fade, 8s hold → 5s fade, capped at 6s
    const held = ctx.currentTime - holdStart;
    const fadeTime = Math.min(1.5 + held * 0.45, 6.0);

    const t = ctx.currentTime;
    // Cancel any in-progress ramp (e.g. fade-in still going), snapshot current gain,
    // then do a clean linear ramp to silence — avoids abrupt exponential jumps.
    const currentGain = masterGain.gain.value;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(currentGain, t);
    masterGain.gain.linearRampToValueAtTime(0, t + fadeTime);

    // Chord blooms keep their own envelopes and die naturally; no need to kill them.
    setTimeout(
      () => {
        try {
          osc1.stop();
          osc2.stop();
          osc3.stop();
          oscSub.stop();
          lfoAmp.stop();
          lfoFreq.stop();
        } catch {
          /* already stopped */
        }
        ctx.close();
      },
      (fadeTime + 2) * 1000
    );
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);

  return stop;
}

export function ChatHeroGrowl() {
  useEffect(() => {
    // Pre-warm the reverb IR after the page settles so the first pointerdown
    // on the hero doesn't stall for ~35ms generating 617K random samples.
    // 44100 Hz is the most common AudioContext sample rate; if the actual
    // context differs the first press recomputes (once) for that rate.
    const prewarm = window.setTimeout(() => computeIR(Math.floor(44100 * 7)), 2000);

    const viewChat = document.getElementById('view-chat');
    if (!viewChat) return;

    let stopCurrent: (() => void) | null = null;

    function onPointerDown(e: Event) {
      if (!viewChat!.classList.contains('chat-empty')) return;
      if (viewChat!.classList.contains('synth-off')) return;
      const pe = e as PointerEvent;
      // Clicks on the speaker toggle bubble through the hero — don't growl.
      if ((pe.target as Element | null)?.closest?.('.hero-synth-toggle')) return;
      stopCurrent?.();
      // Capture the pointer so pointermove/pointerup fire globally
      // even when the cursor leaves the hero element.
      (pe.currentTarget as HTMLElement).setPointerCapture(pe.pointerId);
      stopCurrent = startGrowl(pe.clientY, pe.clientX);
    }

    function wire() {
      const hero = viewChat!.querySelector<HTMLElement>('.chat-empty-hero');
      if (!hero) return;
      hero.removeEventListener('pointerdown', onPointerDown);
      hero.addEventListener('pointerdown', onPointerDown);
    }

    const obs = new MutationObserver(wire);
    obs.observe(viewChat, { childList: true, subtree: true });
    wire();

    return () => {
      window.clearTimeout(prewarm);
      stopCurrent?.();
      obs.disconnect();
      viewChat.querySelector('.chat-empty-hero')?.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  return null;
}
