// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { selectReconnectPlaceholder } from '../reconnect-placeholder.js';

(globalThis as any).document = {
  createElement: () => ({ dataset: {} }),
};

function pushed(): HTMLElement {
  const el = { dataset: { mid: 'new' } } as unknown as HTMLElement;
  return el;
}

describe('selectReconnectPlaceholder', () => {
  it('reuses an existing live DOM node instead of pushing a duplicate agent bubble', () => {
    const existing = { dataset: { mid: '42' } } as unknown as HTMLElement;
    let pushCount = 0;

    const choice = selectReconnectPlaceholder(
      [{ role: 'agent', typing: true, _mid: 42, blocks: [{ type: 'text', text: 'partial' }] as any }],
      (mid) => (mid === 42 ? existing : null),
      () => { pushCount++; return pushed(); },
    );

    expect(choice.placeholder).toBe(existing);
    expect(choice.reusedExistingDom).toBe(true);
    expect(choice.pushedNewPlaceholder).toBe(false);
    expect(choice.persistedBlocksReused).toEqual([{ type: 'text', text: 'partial' }]);
    expect(pushCount).toBe(0);
  });

  it('creates a detached _mid placeholder during the React commit race', () => {
    let pushCount = 0;
    const choice = selectReconnectPlaceholder(
      [{ role: 'agent', streaming: true, _mid: 7, blocks: [{ type: 'text', text: 'snapshot' }] as any }],
      () => null,
      () => { pushCount++; return pushed(); },
    );

    expect(choice.placeholder.dataset.mid).toBe('7');
    expect(choice.createdDetachedForPendingReactCommit).toBe(true);
    expect(choice.pushedNewPlaceholder).toBe(false);
    expect(choice.persistedBlocksReused).toEqual([{ type: 'text', text: 'snapshot' }]);
    expect(pushCount).toBe(0);
  });

  it('pushes a new placeholder only when no live agent message exists', () => {
    let pushCount = 0;
    const choice = selectReconnectPlaceholder(
      [{ role: 'user', text: 'hello' } as any],
      () => null,
      () => { pushCount++; return pushed(); },
    );

    expect(choice.placeholder.dataset.mid).toBe('new');
    expect(choice.pushedNewPlaceholder).toBe(true);
    expect(choice.persistedBlocksReused).toBeNull();
    expect(pushCount).toBe(1);
  });
});

