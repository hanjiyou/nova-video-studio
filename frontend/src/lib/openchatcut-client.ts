'use client';

export type EditorPhase = 'unavailable' | 'idle' | 'starting' | 'ready' | 'failed' | 'stopped';
export interface EditorState {
  phase: EditorPhase;
  available: boolean;
  engineCommit: string;
  code?: string;
}
export interface EditorViewport { visible: boolean; x: number; y: number; width: number; height: number }
export type EditorResult = { ok: true; state: EditorState } | { ok: false; code?: string; state?: EditorState };
export interface EditorBridge {
  getEditorState: () => Promise<EditorResult>;
  openEditor: () => Promise<EditorResult>;
  setEditorViewport: (viewport: EditorViewport) => Promise<{ ok: boolean; code?: string }>;
  hideEditor: () => Promise<{ ok: boolean; code?: string }>;
  onEditorState: (listener: (state: EditorState) => void) => () => void;
}
const PHASES: readonly string[] = ['unavailable', 'idle', 'starting', 'ready', 'failed', 'stopped'];
export const unsupportedEditorState = (): EditorState => ({ phase: 'unavailable', available: false, engineCommit: '', code: 'EDITOR_UNSUPPORTED' });

/** Keep the editor transport narrow: no URL, credentials or host paths enter the page. */
export function readEditorState(value: unknown): EditorState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!PHASES.includes(String(record.phase)) || typeof record.available !== 'boolean'
    || typeof record.engineCommit !== 'string' || !/^(?:[a-f0-9]{40})?$/.test(record.engineCommit)
    || (record.code !== undefined && (typeof record.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,95}$/.test(record.code)))) return null;
  return { phase: record.phase as EditorPhase, available: record.available, engineCommit: record.engineCommit,
    ...(typeof record.code === 'string' ? { code: record.code } : {}) };
}
export function getEditorBridge(): EditorBridge | null {
  if (typeof window === 'undefined') return null;
  const api = window.novaDesktop;
  if (!api || !['getEditorState', 'openEditor', 'setEditorViewport', 'hideEditor', 'onEditorState'].every(name => typeof api[name as keyof typeof api] === 'function')) return null;
  return {
    getEditorState: () => api.getEditorState!(), openEditor: () => api.openEditor!(),
    setEditorViewport: value => api.setEditorViewport!(value), hideEditor: () => api.hideEditor!(),
    onEditorState: listener => api.onEditorState!(listener),
  };
}

/** Use the visible CSS rectangle; the host independently validates its own bounds. */
export function editorViewport(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>, width: number, height: number, visible: boolean): EditorViewport {
  if (![rect.left, rect.top, rect.right, rect.bottom, width, height].every(Number.isFinite)) {
    return { visible: false, x: 0, y: 0, width: 0, height: 0 };
  }
  const x = Math.ceil(Math.max(0, Math.min(width, rect.left)));
  const y = Math.ceil(Math.max(0, Math.min(height, rect.top)));
  const right = Math.floor(Math.max(x, Math.min(width, rect.right)));
  const bottom = Math.floor(Math.max(y, Math.min(height, rect.bottom)));
  const w = Math.max(0, right - x), h = Math.max(0, bottom - y);
  return { visible: visible && w > 0 && h > 0, x, y, width: w, height: h };
}

export function editorMessage(state: EditorState): string {
  if (state.code === 'EDITOR_UNSUPPORTED') return '视频剪辑需要使用支持剪辑组件的 Nova 桌面版。';
  const reasons: Record<string, string> = {
    EDITOR_RUNTIME_NOT_PACKAGED: '当前安装包尚未包含剪辑组件，请使用包含该组件的桌面版本。',
    EDITOR_NODE_UNSUPPORTED: '当前运行环境版本不支持剪辑组件，请使用配套的桌面版本。',
    EDITOR_SOURCE_MISSING: '尚未找到剪辑组件源码，请先准备剪辑组件。',
    EDITOR_VERSION_MISMATCH: '剪辑组件版本与当前工作台不匹配，请重新准备对应版本。',
    EDITOR_DEPENDENCIES_MISSING: '剪辑组件的运行依赖尚未安装，完成组件准备后可以重试。',
    EDITOR_BUILD_MISSING: '剪辑组件尚未构建，请先完成组件准备。',
    EDITOR_BUILD_INVALID: '剪辑组件构建文件不完整，请重新准备组件。',
    EDITOR_START_TIMEOUT: '剪辑组件启动超时，可以重新打开。',
    EDITOR_SERVICE_EXITED: '剪辑服务已退出，可以重新打开；已有工程文件仍保留。',
    EDITOR_CREDENTIAL_BRIDGE_NOT_READY: '剪辑模型配置尚未接入，暂时无法使用需要授权的功能。',
  };
  if (state.code && reasons[state.code]) return reasons[state.code];
  if (state.phase === 'unavailable') return '剪辑组件尚未准备完成，准备好组件后可重新检查。';
  if (state.phase === 'starting') return '正在启动 OpenChatCut 剪辑工作区…';
  if (state.phase === 'stopped') return '剪辑服务已停止，可以重新打开。';
  if (state.phase === 'failed') return '暂时无法打开剪辑工作区，请重试。已有工程文件仍保留。';
  return '正在检查剪辑组件…';
}
