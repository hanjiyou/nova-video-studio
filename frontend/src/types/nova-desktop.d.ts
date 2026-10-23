export {};
declare global {
  interface Window {
    novaDesktop?: {
      versions: Readonly<Record<string, string>>;
      features: Readonly<{ agent: boolean; browserAutomation: boolean; serviceWorker: false }>;
      getRuntimeInfo: () => Promise<{ ok: boolean; version?: string; storageMode?: 'system' | 'portable' | 'override'; code?: string }>;
      chooseOutputDirectory: () => Promise<{ ok: boolean; cancelled?: boolean; selectionId?: string; displayName?: string; code?: string }>;
      saveAssetCopy: (assetId: string) => Promise<{ ok: boolean; code?: string }>;
      revealAsset: (assetId: string) => Promise<{ ok: boolean; code?: string }>;
    };
  }
}
