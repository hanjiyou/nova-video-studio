import type { SaveConnectionInput, ConnectionVersionInput, ConnectionResult } from '@/lib/connection-client';
export {};
declare global {
  interface Window {
    novaDesktop?: {
      versions: Readonly<Record<string, string>>;
      features: Readonly<{ agent: boolean; browserAutomation: boolean; serviceWorker: false }>;
      saveConnection: (input: SaveConnectionInput) => Promise<ConnectionResult>;
      clearConnectionCredential: (input: ConnectionVersionInput) => Promise<ConnectionResult>;
      selectConnection: (input: ConnectionVersionInput) => Promise<ConnectionResult>;
      importReferenceAssets: () => Promise<{ok:boolean;cancelled?:boolean;code?:string;assets?:Array<{assetId:string;kind:string;displayName:string;mimeType:string;byteLength:number;sha256:string;availability:string;previewUrl:string}>}>;
      getRuntimeInfo: () => Promise<{ ok: boolean; version?: string; storageMode?: 'system' | 'portable' | 'override'; code?: string }>;
      chooseOutputDirectory: () => Promise<{ ok: boolean; cancelled?: boolean; selectionId?: string; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string }>;
      getOutputDirectory: () => Promise<{ ok: boolean; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string }>;
      saveAssetCopy: (assetId: string) => Promise<{ ok: boolean; cancelled?: boolean; assetId?: string; code?: string }>;
      revealAsset: (assetId: string) => Promise<{ ok: boolean; assetId?: string; code?: string }>;
    };
  }
}
