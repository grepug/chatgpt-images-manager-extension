// Flat, account-local filters. Compile dates once per result set, never per card.
import { chatStatus } from './chat-archive.js';

export const emptyQuery = () => ({ mode: 'all', rules: [] });
export const RATIO_PRESETS = ['1:1','3:2','2:3','4:3','3:4','16:9','9:16','21:9'];
export const DATE_OPERATORS = { day:'某天', month:'某月', year:'某年', range:'日期区间', before:'早于', after:'晚于', gte:'不早于', lte:'不晚于', relative:'相对日期', unknown:'日期未知' };
export const RELATIVE_DATES = { today:'今天', week:'最近 7 天', thirty:'最近 30 天', month:'本月', year:'今年' };
export const DIRECTIONS = { landscape:'横图', portrait:'竖图', square:'方图', unknown:'尺寸未知' };
export const ARCHIVE_STATES = { archived:'聊天已归档', unarchived:'聊天未归档', unknown:'未能确认' };
export function calendarDate(value, precision = 'day') {
  const pattern = precision === 'year' ? /^\d{4}$/ : precision === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  const [year, month = 1, day = 1] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0,0,0,0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
function nextDate(date, days = 1) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
export function validRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.field === 'archive') return Object.hasOwn(ARCHIVE_STATES, rule.value);
  if (rule.field === 'direction') return Object.hasOwn(DIRECTIONS, rule.value);
  if (rule.field === 'ratio') return ['exact','near'].includes(rule.op) && Number.isFinite(rule.width) && Number.isFinite(rule.height) && rule.width > 0 && rule.height > 0 && rule.width <= Number.MAX_SAFE_INTEGER && rule.height <= Number.MAX_SAFE_INTEGER;
  if (rule.field !== 'date' || !Object.hasOwn(DATE_OPERATORS, rule.op)) return false;
  if (rule.op === 'unknown') return true;
  if (rule.op === 'relative') return Object.hasOwn(RELATIVE_DATES, rule.value);
  if (rule.op === 'range') return Boolean(calendarDate(rule.value) && calendarDate(rule.end) && rule.value <= rule.end);
  return Boolean(calendarDate(rule.value, ['year','month'].includes(rule.op) ? rule.op : 'day'));
}
export function normalizeQuery(query) {
  const valid = (Array.isArray(query?.rules) ? query.rules : []).filter(validRule);
  // Direction and ratio are alternative ways to specify image shape. Existing
  // saved queries use the last valid category, retaining multiple same-category rules.
  const shape = valid.findLast(rule => ['ratio','direction'].includes(rule.field))?.field;
  return { mode: query?.mode === 'any' ? 'any' : 'all', rules: valid.filter(rule => !['ratio','direction'].includes(rule.field) || rule.field === shape).map((rule,index) => {
    const result = { id: typeof rule.id === 'string' ? rule.id : 'restored-' + index, field: rule.field };
    if (rule.field === 'ratio') Object.assign(result, { op: rule.op, width: rule.width, height: rule.height });
    else if (rule.field === 'date') { result.op = rule.op; if (rule.op !== 'unknown') result.value = rule.value; if (rule.op === 'range') result.end = rule.end; }
    else result.value = rule.value;
    return result;
  }) };
}
export function queryKey(query) {
  const normalized = normalizeQuery(query);
  return JSON.stringify({ ...normalized, rules: normalized.rules.map(({ id, ...rule }) => rule) });
}
function dateBounds(rule, now) {
  if (rule.op === 'relative') {
    const start = new Date(now); start.setHours(0,0,0,0);
    const end = nextDate(start);
    if (rule.value === 'week') start.setDate(start.getDate() - 6);
    if (rule.value === 'thirty') start.setDate(start.getDate() - 29);
    if (rule.value === 'month') start.setDate(1);
    if (rule.value === 'year') { start.setMonth(0,1); }
    if (rule.value === 'month') { end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1); }
    if (rule.value === 'year') { end.setFullYear(start.getFullYear() + 1,0,1); }
    return [start.getTime(),end.getTime()];
  }
  const start = calendarDate(rule.value, ['year','month'].includes(rule.op) ? rule.op : 'day');
  const end = nextDate(start);
  if (rule.op === 'month') { end.setDate(1); end.setMonth(start.getMonth() + 1); }
  if (rule.op === 'year') end.setFullYear(start.getFullYear() + 1,0,1);
  if (rule.op === 'range') return [start.getTime(),nextDate(calendarDate(rule.end)).getTime()];
  if (rule.op === 'before') return [-Infinity,start.getTime()];
  if (rule.op === 'after') return [end.getTime(),Infinity];
  if (rule.op === 'gte') return [start.getTime(),Infinity];
  if (rule.op === 'lte') return [-Infinity,end.getTime()];
  return [start.getTime(),end.getTime()];
}
export function compileQuery(query, { now = Date.now(), state = () => undefined } = {}) {
  const { rules, mode } = normalizeQuery(query);
  const predicates = rules.map(rule => {
    if (rule.field === 'archive') return image => chatStatus(state(image.conversationId)) === rule.value;
    if (rule.field === 'date') {
      const known = image => Number.isFinite(image.createdAt) && image.createdAt > 0;
      if (rule.op === 'unknown') return image => !known(image);
      const [start,end] = dateBounds(rule, now);
      return image => known(image) && image.createdAt >= start && image.createdAt < end;
    }
    const known = image => Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0;
    if (rule.field === 'direction') return image => rule.value === 'unknown' ? !known(image) : known(image) && (rule.value === 'landscape' ? image.width > image.height : rule.value === 'portrait' ? image.width < image.height : image.width === image.height);
    return image => known(image) && (rule.op === 'exact' ? image.width * rule.height === image.height * rule.width : Math.abs(image.width / image.height / (rule.width / rule.height) - 1) <= .02 + Number.EPSILON);
  });
  return image => !predicates.length || (mode === 'all' ? predicates.every(test => test(image)) : predicates.some(test => test(image)));
}
export function describeRule(rule) {
  if (rule.field === 'archive') return ARCHIVE_STATES[rule.value];
  if (rule.field === 'direction') return DIRECTIONS[rule.value];
  if (rule.field === 'ratio') return `${rule.op === 'near' ? '接近' : '比例为'} ${rule.width}:${rule.height}${rule.op === 'near' ? '（±2%）' : ''}`;
  if (rule.op === 'unknown') return DATE_OPERATORS.unknown;
  if (rule.op === 'relative') return RELATIVE_DATES[rule.value];
  return `${DATE_OPERATORS[rule.op]} ${rule.value}${rule.op === 'range' ? ' 至 ' + rule.end : ''}`;
}
export function normalizeViews(rows) {
  const ids = new Set(), names = new Set();
  return (Array.isArray(rows) ? rows : []).filter(row => {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || names.has(row.name.trim()) || !['all','favorites','hidden'].includes(row.scope)) return false;
    ids.add(row.id); names.add(row.name.trim()); return true;
  }).map(row => ({ id: row.id, name: row.name.trim(), scope: row.scope, query: normalizeQuery(row.query) }));
}
export function viewNameError(name, views, exceptId) {
  if (!name.trim()) return '请输入 View 名称';
  if (views.some(view => view.id !== exceptId && view.name === name.trim())) return '已有同名 View，请修改名称';
  return '';
}
