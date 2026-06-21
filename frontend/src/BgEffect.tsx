import { useEffect } from 'react';
import { bg } from './bg.js';

export function BgEffect() {
  useEffect(() => {
    bg.init();
    return () => bg.destroy();
  }, []);
  return null;
}
