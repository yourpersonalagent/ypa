import type { Block } from './chat-utils.js';

export interface ReconnectMessageLike {
  role: string;
  typing?: boolean;
  streaming?: boolean;
  blocks?: Block[];
  _mid?: number;
}

export interface ReconnectPlaceholderChoice {
  placeholder: HTMLElement;
  persistedBlocksReused: Block[] | null;
  reusedExistingDom: boolean;
  createdDetachedForPendingReactCommit: boolean;
  pushedNewPlaceholder: boolean;
}

export function selectReconnectPlaceholder(
  messages: ReconnectMessageLike[],
  queryByMid: (mid: number) => HTMLElement | null,
  pushNewPlaceholder: () => HTMLElement,
): ReconnectPlaceholderChoice {
  const last = messages[messages.length - 1];
  const lastIsLivePlaceholder = !!(
    last &&
    last.role === 'agent' &&
    (last.typing || last.streaming === true)
  );
  const persistedBlocksReused = Array.isArray(last?.blocks) && last.blocks.length
    ? last.blocks.slice()
    : null;

  if (lastIsLivePlaceholder && last?._mid != null) {
    const reuse = queryByMid(last._mid);
    if (reuse) {
      return {
        placeholder: reuse,
        persistedBlocksReused,
        reusedExistingDom: true,
        createdDetachedForPendingReactCommit: false,
        pushedNewPlaceholder: false,
      };
    }

    // React can commit the restored streaming message after reconnectStream's
    // microtask runs. Bind to the existing _mid instead of pushing a duplicate
    // agent bubble; MessageList will attach the real element once it commits.
    const detached = document.createElement('div');
    detached.dataset['mid'] = String(last._mid);
    return {
      placeholder: detached,
      persistedBlocksReused,
      reusedExistingDom: false,
      createdDetachedForPendingReactCommit: true,
      pushedNewPlaceholder: false,
    };
  }

  return {
    placeholder: pushNewPlaceholder(),
    persistedBlocksReused: null,
    reusedExistingDom: false,
    createdDetachedForPendingReactCommit: false,
    pushedNewPlaceholder: true,
  };
}
