import { beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../toastStore.js';

const reset = () =>
  useToastStore.setState({ toasts: [], position: 'bottom-right', enabled: true, maxVisible: 5 });

describe('toastStore', () => {
  beforeEach(reset);

  describe('show()', () => {
    it('adds a toast and returns its id', () => {
      const id = useToastStore.getState().show('hello');
      expect(id).toMatch(/^toast-/);
      const { toasts } = useToastStore.getState();
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe('hello');
      expect(toasts[0].type).toBe('info');
    });

    it('normalises type aliases ok→success, err→error', () => {
      useToastStore.getState().show('a', 'ok');
      useToastStore.getState().show('b', 'err');
      const { toasts } = useToastStore.getState();
      expect(toasts[0].type).toBe('success');
      expect(toasts[1].type).toBe('error');
    });

    it('respects opts.duration override', () => {
      useToastStore.getState().show('hi', 'info', { duration: 9999 });
      expect(useToastStore.getState().toasts[0].duration).toBe(9999);
    });

    it('respects legacy numeric duration argument', () => {
      useToastStore.getState().show('hi', 'info', 1234);
      expect(useToastStore.getState().toasts[0].duration).toBe(1234);
    });

    it('respects opts.title', () => {
      useToastStore.getState().show('msg', 'info', { title: 'My Title' });
      expect(useToastStore.getState().toasts[0].title).toBe('My Title');
    });

    it('enforces maxVisible by slicing oldest entries', () => {
      useToastStore.setState({ maxVisible: 3 });
      for (let i = 0; i < 5; i++) useToastStore.getState().show(`msg ${i}`);
      expect(useToastStore.getState().toasts).toHaveLength(3);
      expect(useToastStore.getState().toasts[0].message).toBe('msg 2');
    });

    it('returns empty string and adds nothing when enabled=false', () => {
      useToastStore.setState({ enabled: false });
      const id = useToastStore.getState().show('ignored');
      expect(id).toBe('');
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('sets duration=0 for running type (persistent)', () => {
      useToastStore.getState().show('running…', 'running');
      expect(useToastStore.getState().toasts[0].duration).toBe(0);
    });
  });

  describe('dismiss()', () => {
    it('removes the toast with the given id', () => {
      const id = useToastStore.getState().show('bye');
      useToastStore.getState().dismiss(id);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('is a no-op for unknown ids', () => {
      useToastStore.getState().show('keep');
      useToastStore.getState().dismiss('nonexistent');
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  describe('clear()', () => {
    it('removes all toasts', () => {
      useToastStore.getState().show('a');
      useToastStore.getState().show('b');
      useToastStore.getState().clear();
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
