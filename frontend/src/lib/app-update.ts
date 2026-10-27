export interface AppUpdateState {
  supported: boolean;
  testBuild?: boolean;
  currentVersion: string;
  phase: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'preparing' | 'installing' | 'error' | 'closed-error';
  reason?: string;
  installSupported: boolean;
  installReason?: string | null;
  notice: string | null;
  remoteMayContinue: boolean;
  update?: { version: string; releaseNotes: string };
  downloadMode?: 'preparing' | 'differential-attempt' | 'differential' | 'full' | 'full-fallback' | 'cached' | 'unknown';
  fallbackReason?: 'old_installer_missing' | 'old_installer_unreadable' | 'blockmap_failed' | 'transfer_failed' | 'checksum_failed' | 'unknown';
  baselineReason?: 'cache_missing' | 'baseline_missing' | 'baseline_invalid' | 'identity_mismatch' | 'version_mismatch' | 'installer_missing' | 'installer_unreadable' | 'installer_corrupt' | 'cache_changed' | 'map_unusable' | 'cache_invalid' | 'unknown';
  progress?: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number };
  error?: { code: string; message: string };
}
export interface UpdateResult { ok: boolean; code?: string; message?: string; state?: AppUpdateState }
export function updateUnsupportedMessage(state: AppUpdateState) {
  if (state.reason === 'UPDATE_METADATA_INVALID') return '此安装的更新信息未通过校验，请手动安装受支持的新版本。';
  return '此版本尚未启用应用内更新。请使用支持更新的 Windows 安装版。';
}
