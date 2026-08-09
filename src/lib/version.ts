import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from './tauri-bridge';

export const bundledVersion = __APP_VERSION__;

export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return bundledVersion;
  try {
    return await getVersion();
  } catch (error) {
    console.warn('Failed to read native app version; using bundled version.', error);
    return bundledVersion;
  }
}
