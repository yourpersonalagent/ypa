// NOTE: YHA logo spin animation is disabled (kept commented for later re-enable).
// To restore: uncomment the import below + the state + useEffect block + dynamic blockChar.
// import { useState, useEffect, useRef } from 'react';

import { appName, appSlogan } from './branding.js';
import { NetworkNodeSwitcher } from './components/NetworkNodeSwitcher.js';

// const SPIN_FRAMES = ['▌', '▄', '▐', '▀'];
const BLOCK = '█';
// const SPIN_MS = 110;
// const SPIN_DUR = 1100;
// const PAUSE_MIN = 3000;
// const PAUSE_MAX = 15000;

export function HeaderBrand() {
  // ── Animation disabled ───────────────────────────────────────────────
  // const [blockChar, setBlockChar] = useState(BLOCK);
  // const animatingRef = useRef(false);
  // const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  //
  // useEffect(() => {
  //   function scheduleNext() {
  //     const pause = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
  //     timerRef.current = setTimeout(startSpin, pause);
  //   }
  //
  //   function startSpin() {
  //     if (animatingRef.current) return;
  //     animatingRef.current = true;
  //     let frame = 0;
  //     let elapsed = 0;
  //
  //     function spin() {
  //       if (!animatingRef.current) return;
  //       setBlockChar(SPIN_FRAMES[frame % SPIN_FRAMES.length]);
  //       frame++;
  //       elapsed += SPIN_MS;
  //       if (elapsed < SPIN_DUR) {
  //         timerRef.current = setTimeout(spin, SPIN_MS);
  //       } else {
  //         setBlockChar(BLOCK);
  //         animatingRef.current = false;
  //         scheduleNext();
  //       }
  //     }
  //     spin();
  //   }
  //
  //   timerRef.current = setTimeout(startSpin, 1000 + Math.random() * 3000);
  //
  //   return () => {
  //     if (timerRef.current) clearTimeout(timerRef.current);
  //     animatingRef.current = false;
  //   };
  // }, []);
  const blockChar = BLOCK;
  const name = appName();
  const slogan = appSlogan();

  return (
    <h1>
      <NetworkNodeSwitcher title={`${name} — switch YPA network node`}>
        <span
          className="header-block"
          style={{
            color: 'var(--accent)',
            // transition: 'color 0.3s ease',
            display: 'inline-block',
            verticalAlign: 'baseline',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          {blockChar}
        </span>
        {' '}{name}
      </NetworkNodeSwitcher>
      <small>{slogan}</small>
    </h1>
  );
}
