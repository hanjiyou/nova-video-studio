import type { HistoryTask } from './workbench-client';
export const MAX_WORK_NAME_CHARACTERS = 60;
export const workNameLength = (value: string) => Array.from(value).length;
export function workNameError(value: string) {
  return /[\p{Cc}\uD800-\uDFFF]/u.test(value) || workNameLength(value.trim()) > MAX_WORK_NAME_CHARACTERS ? '作品名称最多60个字符，不能包含换行或控制字符。' : '';
}
export const workTitle = (task: Pick<HistoryTask, 'workName' | 'prompt'>, fallback = '未填写提示词') => task.workName?.trim() || task.prompt || fallback;
