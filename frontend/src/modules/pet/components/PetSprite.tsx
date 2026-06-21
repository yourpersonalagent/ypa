import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PetMood, SpriteConfig } from '../store/petStore.js';

interface PetSpriteProps {
  mood: PetMood
  config: SpriteConfig
  size?: number
  className?: string
}

function PetSpriteInner({ mood, config, size = 128, className }: PetSpriteProps) {
  const uid = useId().replace(/:/g, '');
  const [frameIndex, setFrameIndex] = useState(0);
  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(() => new Set());
  // Track every URL whose <img> has fired `onLoad` at least once. Once a
  // URL is in the set it stays "loaded" forever, so a frame transition
  // never drops opacity to 0. The earlier code stored a single
  // `loadedSrc: string | null` and nulled it on every `currentSrc`
  // change (per frame!) — combined with the 0.3 s opacity fade that
  // produced the empty-frame flicker the user reported on busy
  // sessions: each frame swap started a fade-out, then onLoad of the
  // already-cached next frame raced the React paint and left a
  // visible blink. With a Set, after each URL has been seen once
  // (typically inside the first animation cycle, since the next-frame
  // preload below warms cache one step ahead) every subsequent swap
  // is `loaded === true` instantly, no transition, no flicker.
  const [loadedSrcs, setLoadedSrcs] = useState<Set<string>>(() => new Set());
  // Last URL that successfully painted, so we can keep it on screen when
  // the next request fails (e.g. bridge restart, network blip just before
  // the reconnecting overlay kicks in). Without this stickiness, a single
  // failed PNG load blacklists the URL, currentSrc collapses to null, and
  // PetSprite renders the inline He-Man SVG fallback for a frame or two —
  // the user's "kurz vor dem reconnecting screen flippt der pet auf SVG"
  // complaint was exactly this race.
  const [stickySrc, setStickySrc] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frames = useMemo(
    () => config.frames?.filter((f) => f.src && f.duration > 0) || [],
    [config.frames],
  );
  const hasFrames = frames.length > 0;
  const frame = hasFrames ? frames[Math.min(frameIndex, frames.length - 1)] : null;
  const preferredSrc = frame?.src || config.src || null;
  const fallbackSrc = config.fallback && !failedSrcs.has(config.fallback) ? config.fallback : null;
  const targetSrc = preferredSrc && !failedSrcs.has(preferredSrc) ? preferredSrc : fallbackSrc;
  // While targetSrc is null (nothing left to try), keep painting the last
  // good URL instead of dropping to the SVG silhouette. Only when we have
  // never loaded anything (cold start with no network) do we fall through
  // to the SVG branch.
  const currentSrc = targetSrc || stickySrc;
  const loaded = !!currentSrc && loadedSrcs.has(currentSrc);

  useEffect(() => {
    if (!hasFrames) return;

    const advance = () => {
      setFrameIndex((i) => (i + 1) % frames.length);
    };

    timerRef.current = setTimeout(advance, frames[Math.min(frameIndex, frames.length - 1)].duration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [frameIndex, frames, hasFrames]);

  // Restart the frame cycle on mood/config swap. We deliberately do NOT
  // clear `loadedSrcs` — those URLs stay valid across mood changes (the
  // browser keeps them cached) and zeroing the set forced an opacity
  // 0 → 1 fade on every mood flip, which on rapid stream/idle/tool-call
  // toggling read as flicker. Letting the set accumulate means the very
  // first paint of a never-before-seen URL fades in once and every later
  // swap to that URL is instant.
  useEffect(() => {
    setFrameIndex(0);
  }, [mood, config.src, config.frames]);

  // Eagerly warm the browser cache for every frame of the active mood
  // the moment its config arrives. The next-frame preload below only
  // stays one step ahead, which means the FIRST cycle through frames
  // can miss cache and produce the empty-frame flicker the loadedSrcs
  // tracker is designed to suppress. Pre-fetching the whole strip in
  // one batch on config change ensures the per-frame onLoad fires on
  // a cache hit, so React never paints a `loaded === false` frame
  // mid-cycle. `new Image()` is cheap and non-blocking.
  useEffect(() => {
    if (!hasFrames) return;
    for (const f of frames) {
      if (!f.src || failedSrcs.has(f.src)) continue;
      const img = new Image();
      img.src = f.src;
    }
    // Drop `failedSrcs` from the dep array on purpose — re-firing on
    // every blacklist mutation is wasted work. Real failures are
    // rediscovered by the per-frame preload + onError handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, hasFrames]);

  useEffect(() => {
    if (!hasFrames || frames.length < 2) return;
    const next = frames[(frameIndex + 1) % frames.length]?.src;
    if (!next || failedSrcs.has(next)) return;
    const img = new Image();
    img.src = next;
  }, [failedSrcs, frameIndex, frames, hasFrames]);

  // Network came back — drop the blacklist so transient failures during a
  // bridge restart don't permanently mark a frame as broken. Same on the
  // page becoming visible again after sleep/lock. The real PNG fetches will
  // either succeed (back in the cache) or re-fail and re-add themselves.
  useEffect(() => {
    const reset = () => setFailedSrcs((prev) => (prev.size === 0 ? prev : new Set()));
    window.addEventListener('online', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('online', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  const showImage = !!currentSrc;
  const bladeGradId = `pet-blade-grad-${uid}`;
  const glowFilterId = `pet-glow-filter-${uid}`;

  return (
    <div
      className={['pet-sprite', className].filter(Boolean).join(' ')}
      data-mood={mood}
      data-loaded={loaded ? 'true' : 'false'}
      style={{
        width: size,
        height: size,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        className="pet-effect-zone"
        style={{
          position: 'absolute',
          width: config.effectZone.width,
          height: config.effectZone.height,
          top: config.effectZone.top,
          left: config.effectZone.left,
          pointerEvents: 'none',
          zIndex: -1,
        }}
      />

      {showImage ? (
        <img
          src={currentSrc}
          alt=""
          className={`pet-sprite-img ${!loaded ? 'pet-sprite-loading' : ''}`}
          draggable={false}
          /* Native lazy-load so the dozen-or-so per-frame sprite PNGs
             a manifest references don't block the initial render. The
             `decoding="async"` hint also lets the browser decode the
             PNG off the main thread, sparing the chat input from
             paint contention while the user is typing.
             ⚠ Only the *current* frame is rendered (others are
             pre-fetched via `new Image()` in the useEffect above with
             intent: prefetch); `loading="lazy"` is therefore mostly a
             hint for the very first manifest load when the pet is
             below the fold. */
          loading="lazy"
          decoding="async"
          onLoad={() => {
            setLoadedSrcs((prev) => {
              if (!currentSrc || prev.has(currentSrc)) return prev;
              const next = new Set(prev);
              next.add(currentSrc);
              return next;
            });
            setStickySrc(currentSrc);
          }}
          onError={() => {
            console.warn(`[PetSprite] Sprite missing: ${currentSrc}`);
            setFailedSrcs((prev) => new Set(prev).add(currentSrc));
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.3s ease',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            pointerEvents: 'none',
            // Per-row display scale: scale around the foot anchor (centre-X,
            // 93 % down) so the character stays planted on the chat-input
            // ground line when growing or shrinking. Applied via manifest's
            // ManifestPose.scale — NOT baked into PNG pixels.
            ...(config.scale && config.scale !== 1 ? {
              transform: `scale(${config.scale})`,
              transformOrigin: '50% 93%',
            } : {}),
          }}
        />
      ) : (
        <svg
          className="pet-sprite-fallback"
          data-mood={mood}
          viewBox="0 0 100 140"
          aria-hidden="true"
          style={{
            width: '100%',
            height: '100%',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          <defs>
            <linearGradient id={bladeGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffd700" />
              <stop offset="100%" stopColor="#b8860b" />
            </linearGradient>
            <filter id={glowFilterId}>
              <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#ffd700" />
            </filter>
          </defs>

          <g className="pet-lightning">
            <ellipse className="pet-cloud" cx="50" cy="6" rx="22" ry="6" fill="#555" />
            <path className="pet-bolt pet-bolt-1" d="M50 12 L44 32 L52 34 L48 56" fill="none" stroke="#ffd700" strokeWidth="2" />
            <path className="pet-bolt pet-bolt-2" d="M55 12 L60 28 L52 30 L58 54" fill="none" stroke="#ffd700" strokeWidth="1.5" />
            <path className="pet-bolt pet-bolt-3" d="M45 12 L40 30 L48 32 L42 52" fill="none" stroke="#ffd700" strokeWidth="2" />
          </g>

          <path className="pet-cape" d="M36 42 Q30 80 35 120 Q50 125 65 120 Q70 80 64 42" fill="#8B0000" opacity="0.7" />

          <g className="pet-body">
            <ellipse cx="50" cy="80" rx="16" ry="24" fill="#D2691E" />
            <rect x="42" y="70" width="16" height="4" rx="2" fill="#8B4513" />
            <path className="pet-loincloth" d="M40 96 Q50 110 60 96" fill="#8B4513" />
          </g>

          <circle className="pet-head" cx="50" cy="32" r="11" fill="#F5DEB3" />
          <path className="pet-hair" d="M39 28 Q32 15 50 18 Q68 15 61 28" fill="#8B4513" />

          <g className="pet-arm-right pet-sword-arm" style={{
            transformOrigin: '50px 70px',
            transform: mood === 'powermove' || mood === 'fighting' ? 'rotate(-90deg)' : 'rotate(-45deg)',
            transition: 'transform 0.3s ease',
          }}>
            <line className="pet-sword-blade" x1="50" y1="60" x2="50" y2="15" stroke={`url(#${bladeGradId})`} strokeWidth="3" />
            <rect className="pet-sword-grip" x="48" y="60" width="4" height="8" fill="#8B4513" rx="1" />
            <circle className="pet-sword-pommel" cx="50" cy="70" r="3" fill="#ffd700" />
            {(mood === 'streaming' || mood === 'powermove') && (
              <circle className="pet-sword-glow" cx="50" cy="38" r="8" fill="none" stroke="#ffd700" strokeWidth="2" opacity="0.6" filter={`url(#${glowFilterId})`}>
                <animate attributeName="r" values="6;12;6" dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.5s" repeatCount="indefinite" />
              </circle>
            )}
          </g>
        </svg>
      )}
    </div>
  );
}

export const PetSprite = memo(PetSpriteInner);
