import { useEffect } from 'react';
import * as bridge from '../lib/tauri-bridge';

/**
 * Calls `refresh` whenever the user comes back to this window and whenever a lookup finishes,
 * in any window: those are the moments at which what a page shows may have gone out of date.
 * Passing a new `refresh` function starts listening afresh, so keep it stable.
 */
export function useRefreshWhenActive(refresh: () => void): void {
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);

    // A lookup made in another window finishes after it was recorded, so this is the moment to read.
    let stop: (() => void) | undefined;
    let disposed = false;
    bridge
      .listenLookupDone(() => refresh())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error) => console.error('Failed to listen for finished lookups:', error));

    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      stop?.();
    };
  }, [refresh]);
}
