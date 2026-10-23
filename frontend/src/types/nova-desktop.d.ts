export {};
declare global {
  interface Window {
    novaDesktop?: {
      versions: Readonly<Record<string, string>>;
      features: Readonly<{ agent: boolean; browserAutomation: boolean; serviceWorker: false }>;
      importReferenceAssets: () => Promise<{ok:boolean;cancelled?:boolean;code?:string;assets?:Array<{assetId:string;kind:string;displayName:string;mimeType:string;byteLength:number;sha256:string;availability:string;previewUrl:string}>}>;
      getRuntimeInfo: () => Promise<{ ok: boolean; version?: string; storageMode?: 'system' | 'portable' | 'override'; code?: string }>;
      chooseOutputDirectory: () => Promise<{ ok: boolean; cancelled?: boolean; selectionId?: string; displayName?: string; code?: string }>;
      saveAssetCopy: (assetId: string) => Promise<{ ok: boolean; code?: string }>;
      revealAsset: (assetId: string) => Promise<{ ok: boolean; code?: string }>;
    };
  }
}
