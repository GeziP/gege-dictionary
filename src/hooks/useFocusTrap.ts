import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps the keyboard inside a dialog while it is open: focus moves to its first control when it
 * opens, Tab and Shift+Tab go round within it instead of leaving it for the page behind, and
 * focus goes back to where it was when the dialog closes.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, enabled = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return undefined;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    // A dialog with nothing to press still takes the focus, so that Escape and Tab find it.
    (controls()[0] ?? root).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls();
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const outside = !(current instanceof Node) || !root.contains(current);
      if (event.shiftKey && (current === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    // On the document, not the dialog, so that a Tab pressed while focus is still on the page
    // behind (or on nothing) is caught as well.
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [ref, enabled]);
}
