export type LibraryDateSelection = { mode: 'all' | 'today' | 'custom'; start: string; end: string };
export const localDay = (date = new Date()) => [String(date.getFullYear()).padStart(4,'0'),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
export function localDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year,month,day] = value.split('-').map(Number), date = new Date(0);
  date.setFullYear(year,month-1,day); date.setHours(0,0,0,0);
  return date.getFullYear()===year && date.getMonth()===month-1 && date.getDate()===day ? date : null;
}
export function libraryDateBounds(value: LibraryDateSelection, now = new Date()): {createdFrom?: string;createdBefore?: string} {
  if(value.mode==='all') return {};
  const start = localDate(value.mode==='today' ? localDay(now) : value.start), end = localDate(value.mode==='today' ? localDay(now) : value.end);
  if(!start || !end || start>end) throw Error('请选择有效的开始和结束日期，开始日期不能晚于结束日期。');
  end.setDate(end.getDate()+1);
  if(end.getFullYear()>9999) throw Error('结束日期超出支持范围。');
  return {createdFrom:start.toISOString(),createdBefore:end.toISOString()};
}
export const libraryDateLabel = (value: LibraryDateSelection) => value.mode==='all'?'全部日期':value.mode==='today'?'今天':(value.start.slice(0,4)!==value.end.slice(0,4)||value.start.slice(0,4)!==String(new Date().getFullYear())?value.start.replaceAll('-','/')+' — '+value.end.replaceAll('-','/'):value.start.slice(5).replace('-','/')+' — '+value.end.slice(5).replace('-','/'));
