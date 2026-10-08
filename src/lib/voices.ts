/**
 * The installed voice that a saved voice setting stands for, or an empty string when none does.
 *
 * The speech engine reads with the first installed voice whose name contains the setting,
 * ignoring case (so "Microsoft Zira" is "Microsoft Zira Desktop"); this applies the same
 * rule, so that the list shows the voice that will really be used. An empty setting, or one
 * that matches nothing installed, means "an English voice, chosen by the engine".
 */
export function installedVoiceFor(saved: string, installed: string[]): string {
  const wanted = saved.trim().toLowerCase();
  if (!wanted) return '';
  return installed.find((voice) => voice.toLowerCase().includes(wanted)) ?? '';
}

/** "Microsoft Zira Desktop" is "Zira Desktop" in a list where every entry begins with Microsoft. */
export const voiceLabel = (voice: string): string => voice.replace(/^Microsoft\s+/i, '');
