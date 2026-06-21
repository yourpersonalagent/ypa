// ErrorBoundary — catches render-phase errors in any descendant subtree so a
// single component failure doesn't unmount the whole React tree (which would
// strip every `getElementById`-targeted DOM node and cascade null-deref errors
// into vanilla init() functions in main.ts).
//
// Common trigger: a `createPortal` whose target was disconnected mid-commit
// (e.g. ChatView remounted or a stale ref). React surfaces that as
// "insertBefore: node is not a child of this node". Without a boundary, the
// whole app dies. With one, the offending subtree just renders nothing until
// the next render finds a fresh container.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Logging label so we know which boundary fired in mixed trees. */
  label?: string;
}

interface State {
  hasError: boolean;
  resetCounter: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, resetCounter: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ''}]`, error.message, info.componentStack);
    // Auto-recover on the next tick — most portal target errors resolve as
    // soon as the MutationObserver in the affected component re-discovers the
    // (now-stable) DOM node.
    setTimeout(() => {
      this.setState((s) => ({ hasError: false, resetCounter: s.resetCounter + 1 }));
    }, 0);
  }

  render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
