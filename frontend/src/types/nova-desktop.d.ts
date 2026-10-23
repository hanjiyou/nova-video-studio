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
      validateAndSaveConnection: (input: SaveConnectionInput & { operationId: string; expectedOnboardingRevision?: number }) => Promise<ConnectionResult & Partial<import('@/lib/connection-client').ConnectionModels> & { stale?: boolean; cancelled?: boolean; validationState?: string; currentConnection?: import('@/lib/connection-client').ConnectionSummary; errorCode?: string; httpStatus?: number; onboarding?: import('@/lib/workbench-client').Setting<import('@/lib/workbench-client').OnboardingPreferences> }>;
      cancelConnectionValidation: (input: { operationId: string }) => Promise<{ok: boolean; cancelled?: boolean; code?: string}>;
      completeWorkbenchSetup: (input: ConnectionVersionInput & {defaultImageModel: string; defaultVideoModel: string; expectedOnboardingRevision?: number}) => Promise<ConnectionResult & {onboarding?: import('@/lib/workbench-client').Setting<import('@/lib/workbench-client').OnboardingPreferences>}>;
      checkOutputDirectory: () => Promise<{ok: boolean; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string}>;
      exportDiagnostics: () => Promise<{ok:boolean;cancelled?:boolean;code?:string;exportedTasks?:number;omittedTasks?:number}>;
      getRuntimeInfo: () => Promise<{ ok: boolean; version?: string; storageMode?: 'system' | 'portable' | 'override'; code?: string }>;
      chooseOutputDirectory: () => Promise<{ ok: boolean; cancelled?: boolean; selectionId?: string; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string }>;
      getOutputDirectory: () => Promise<{ ok: boolean; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string }>;
      saveAssetCopy: (assetId: string) => Promise<{ ok: boolean; cancelled?: boolean; assetId?: string; code?: string }>;
      revealAsset: (assetId: string) => Promise<{ ok: boolean; assetId?: string; code?: string }>;
    };
  }
}
