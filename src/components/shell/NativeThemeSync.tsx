import { useEffect } from 'react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { isTauri } from '../../lib/tauri-bridge';

/**
 * Keeps the main window's own frame (its title bar) in step with the theme chosen in the app: the
 * frame belongs to the system and follows the system's theme, not the page's, so a dark page under
 * a light title bar was what "dark" looked like on a light system. It renders nothing.
 */
export function NativeThemeSync() {
  const { settings } = useLexNote();
  const theme = settings.theme === 'system' ? null : settings.theme;

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => (cancelled ? undefined : getCurrentWindow().setTheme(theme)))
      .catch((error) => console.warn('Could not set the theme of the window frame:', error));
    return () => {
      cancelled = true;
    };
  }, [theme]);

  return null;
}
