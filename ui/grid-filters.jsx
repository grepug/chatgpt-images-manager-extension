import React, { useEffect, useState, useRef } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { roots, Card, Branch, Icon, layoutMenus } from './menu-components.jsx';
import { DATE_OPERATORS, RELATIVE_DATES, DIRECTIONS, ARCHIVE_STATES, RATIO_PRESETS, validRule, describeRule, viewNameError } from '../extension/image-filters.js';

const labels = { date:'生成日期', ratio:'宽高比例', direction:'图片方向', archive:'聊天归档状态' };
const icons = { date:'calendar', ratio:'ratio', direction:'images', archive:'archive' };
const bridge = () => window.gridFilterBridge;
const item = 'component-item';
function Command({ label, icon, disabled, keep = false, onSelect, children }) {
  return <Menu.Item className={item} disabled={disabled} onSelect={event => { if (keep) event.preventDefault(); onSelect?.(); }}>
    {icon && <Icon name={icon}/>}<span>{label}</span>{children}
  </Menu.Item>;
}
function useRoot() {
  const [open,setOpen] = useState(false);
  useEffect(() => {
    const root = { close: () => setOpen(false), isOpen: () => open };
    roots.add(root); return () => roots.delete(root);
  },[open]);
  return [open,value => { if (value) for (const root of roots) root.close(); setOpen(value); }];
}
function RuleEditor({ field, rule, onRule, replacement }) {
  const id = useRef(rule?.id || crypto.randomUUID());
  const initial = rule || (field === 'date' ? { op:'day', value:'' } : { op:'exact', width:9, height:16 });
  const [draft,setDraft] = useState(initial), [touched,setTouched] = useState(false);
  const changed = changes => {
    const next = { ...draft, ...changes }; setDraft(next); setTouched(true);
    const candidate = { ...next, id:id.current, field };
    if (field === 'ratio') { candidate.width = Number(next.width); candidate.height = Number(next.height); }
    if (validRule(candidate)) onRule(candidate);
  };
  const candidate = { ...draft, field, width:Number(draft.width), height:Number(draft.height) };
  return <div className="filter-form" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <h3>{labels[field]}</h3>
    {replacement && <p className="filter-hint filter-replacement">应用比例后将替换图片方向条件</p>}
    {field === 'date' ? <>
      <label>条件<select aria-label="日期条件" value={draft.op} onChange={event => changed({ op:event.target.value })}>{Object.entries(DATE_OPERATORS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {draft.op === 'relative' ? <label>时间范围<select aria-label="相对日期" value={draft.value || ''} onChange={event => changed({ value:event.target.value })}><option value="" disabled>选择时间范围</option>{Object.entries(RELATIVE_DATES).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        : draft.op !== 'unknown' && <>
          <label>{draft.op === 'range' ? '开始日期' : draft.op === 'month' ? '月份' : draft.op === 'year' ? '年份' : '日期'}<input aria-label={draft.op === 'range' ? '开始日期' : draft.op === 'month' ? '月份' : draft.op === 'year' ? '年份' : '日期'} type={draft.op === 'year' || draft.op === 'month' ? 'text' : 'date'} placeholder={draft.op === 'year' ? '2026' : draft.op === 'month' ? '2026-10' : undefined} value={draft.value || ''} onChange={event => changed({ value:event.target.value })}/></label>
          {draft.op === 'range' && <label>结束日期<input aria-label="结束日期" type="date" value={draft.end || ''} onChange={event => changed({ end:event.target.value })}/></label>}
        </>}
      <p className="filter-hint">系统时区 · 日期区间包含起止日</p>
    </> : <>
      <div className="ratio-presets">{RATIO_PRESETS.map(ratio => <button key={ratio} type="button" className={Number(draft.width) / Number(draft.height) === Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]) ? 'active' : ''} onClick={() => { const [width,height] = ratio.split(':').map(Number); changed({width,height}); }}>{ratio}</button>)}</div>
      <label>匹配方式<select aria-label="比例匹配方式" value={draft.op} onChange={event => changed({op:event.target.value})}><option value="exact">精确匹配</option><option value="near">接近匹配（±2%）</option></select></label>
      <label>自定义比例<div className="ratio-inputs"><input aria-label="比例宽" inputMode="decimal" value={draft.width} onChange={event => changed({width:event.target.value})}/><span>:</span><input aria-label="比例高" inputMode="decimal" value={draft.height} onChange={event => changed({height:event.target.value})}/></div></label>
    </>}
    {touched && !validRule(candidate) && <p className="filter-validation" role="status">请输入完整有效的值，当前结果尚未改变</p>}
    {!touched && !rule && field === 'ratio' && <button className="filter-save" onClick={() => changed({})}>添加此比例</button>}
    {touched && validRule(candidate) && <p className="filter-hint">已应用</p>}
  </div>;
}
function RuleChoices({ field, rule, onRule, replacement }) {
  const id = useRef(rule?.id || crypto.randomUUID());
  if (['date','ratio'].includes(field)) return <RuleEditor field={field} rule={rule} onRule={onRule} replacement={replacement}/>;
  const choices = field === 'direction' ? DIRECTIONS : ARCHIVE_STATES;
  return <>{replacement && <Menu.Label className="filter-menu-label">选择后将替换比例条件</Menu.Label>}{Object.entries(choices).map(([value,label]) => <Command key={value} label={label} icon={value === 'unknown' ? 'info' : icons[field]} keep onSelect={() => onRule({ id:id.current, field, value })}>{rule?.value === value && <Icon name="check"/>}</Command>)}</>;
}
function FilterMenu({ state }) {
  const [open,changeOpen] = useRoot();
  return <Menu.Root modal={false} open={open} onOpenChange={changeOpen}>
    <Menu.Trigger id="grid-filter-trigger" className="grid-query-button" disabled={state.busy || !state.account} aria-label="筛选图片" title={state.query.rules.map(describeRule).join(state.query.mode === 'all' ? ' 且 ' : ' 或 ')}>
      <Icon name="filter"/><span>筛选</span>{state.query.rules.length > 0 && <span className="filter-count">{state.query.rules.length}</span>}
    </Menu.Trigger>
    <Card depth={0} rootTrigger="grid-filter-trigger">
      <Menu.Label className="filter-menu-label">筛选条件</Menu.Label>
      <Menu.RadioGroup value={state.query.mode} onValueChange={mode => bridge().setQuery({ ...state.query, mode })}>
        {[['all','满足全部条件'],['any','满足任一条件']].map(([value,label]) => <Menu.RadioItem key={value} className={item} value={value} onSelect={event => event.preventDefault()}><span>{label}</span><Menu.ItemIndicator><Icon name="check"/></Menu.ItemIndicator></Menu.RadioItem>)}
      </Menu.RadioGroup>
      <Menu.Separator className="component-separator"/>
      {state.query.rules.map(rule => <Branch key={rule.id} label={describeRule(rule)} icon={icons[rule.field]} id={'filter-rule-' + rule.id} depth={1} form={['date','ratio'].includes(rule.field)} rootTrigger="grid-filter-trigger">
        <RuleChoices field={rule.field} rule={rule} onRule={value => bridge().putRule(value)}/>
        <Menu.Separator className="component-separator"/>
        <Command label="删除此条件" icon="minus" keep onSelect={() => bridge().removeRule(rule.id)}/>
      </Branch>)}
      <Branch label="添加条件" icon="plus" id="filter-add" depth={1} rootTrigger="grid-filter-trigger">
        {Object.keys(labels).map(field => <Branch key={field} label={labels[field]} icon={icons[field]} id={'filter-add-' + field} depth={2} form={['date','ratio'].includes(field)} rootTrigger="grid-filter-trigger"><RuleChoices field={field} replacement={state.query.rules.some(rule => rule.field === (field === 'ratio' ? 'direction' : field === 'direction' ? 'ratio' : null))} onRule={rule => bridge().putRule(rule)}/></Branch>)}
      </Branch>
      {state.geometry === 'working' && <Menu.Label className="filter-menu-label" role="status">正在补齐本地图片尺寸…</Menu.Label>}
      {state.geometry === 'failed' && <Command label="尺寸补齐失败，点击重试" icon="refresh" keep onSelect={() => bridge().retryGeometry()}/>}
      <Menu.Separator className="component-separator"/>
      <Command label="清除全部条件" icon="minus" disabled={!state.query.rules.length} keep onSelect={() => bridge().setQuery({ mode:'all', rules:[] })}/>
    </Card>
  </Menu.Root>;
}
function NameForm({ view, views, onSave, error }) {
  const [name,setName] = useState(view?.name || '');
  const validation = viewNameError(name, views, view?.id);
  return <form className="filter-form" onSubmit={event => { event.preventDefault(); if (!validation) onSave(name.trim()); }} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <label>View 名称<input aria-label="View 名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：最近 7 天的竖图"/></label>
    {(name && validation || error) && <p className="filter-validation" role="status">{error || validation}</p>}
    <button type="submit" className="filter-save" disabled={Boolean(validation)}>保存</button>
  </form>;
}
function ViewsMenu({ state }) {
  const [open,changeOpen] = useRoot(), [search,setSearch] = useState('');
  const current = state.views.find(view => view.id === state.viewId);
  const choices = state.views.filter(view => view.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Menu.Root modal={false} open={open} onOpenChange={changeOpen}>
    <Menu.Trigger id="grid-view-trigger" className="grid-query-button view-trigger" disabled={state.busy || !state.account} aria-label="切换 View" title={current?.name || 'View'}><Icon name="views"/><span>{current?.name || 'View'}</span>{state.dirty && <span className="view-modified" title="已修改" aria-label="已修改">•</span>}<span className="component-chevron">⌄</span></Menu.Trigger>
    <Card depth={0} rootTrigger="grid-view-trigger">
      <div className="view-search" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}><input aria-label="搜索 View" placeholder="搜索 View…" value={search} onChange={event => { setSearch(event.target.value); layoutMenus(); }}/></div>
      {choices.map(view => <Command key={view.id} label={view.name} icon="views" onSelect={() => bridge().openView(view.id)}>{view.id === state.viewId && <Icon name="check"/>}</Command>)}
      {!choices.length && <Menu.Label className="filter-menu-label">{state.views.length ? '没有匹配的 View' : '还没有保存的 View'}</Menu.Label>}
      <Menu.Separator className="component-separator"/>
      <Branch label={current ? '另存为新 View' : '保存为 View'} icon="plus" id="view-save" depth={1} form rootTrigger="grid-view-trigger"><NameForm views={state.views} error={state.error} onSave={name => bridge().saveNew(name)}/></Branch>
      {current && <>
        {state.dirty && <><Command label="更新此 View" icon="check" disabled={state.saving} onSelect={() => bridge().updateView()}/><Command label="恢复已保存条件" icon="refresh" onSelect={() => bridge().restoreView()}/></>}
        <Branch label="管理此 View" icon="settings" id="view-manage" depth={1} rootTrigger="grid-view-trigger">
          <Branch label="重命名" icon="edit" id="view-rename" depth={2} form rootTrigger="grid-view-trigger"><NameForm view={current} views={state.views} error={state.error} onSave={name => bridge().renameView(name)}/></Branch>
          <Branch label="复制" icon="copy" id="view-copy" depth={2} form rootTrigger="grid-view-trigger"><NameForm views={state.views} error={state.error} onSave={name => bridge().duplicateView(name)}/></Branch>
          <Branch label="删除此 View" icon="minus" id="view-delete" depth={2} rootTrigger="grid-view-trigger"><Menu.Label className="filter-menu-label">只删除 View，图片保持保留</Menu.Label><Command label="确认删除" icon="minus" onSelect={() => bridge().deleteView()}/></Branch>
        </Branch>
        <Command label="退出 View，保留临时条件" icon="grid" onSelect={() => bridge().leaveView()}/>
      </>}
      {state.saving && <Menu.Label className="filter-menu-label" role="status">正在保存…</Menu.Label>}
      {state.error && <Menu.Label className="filter-validation" role="alert">{state.error}</Menu.Label>}
    </Card>
  </Menu.Root>;
}
export function GridFilters() {
  const [state,setState] = useState(() => bridge().state());
  useEffect(() => {
    const changed = () => setState(bridge().state());
    window.addEventListener('grid-filter-state',changed); changed();
    return () => window.removeEventListener('grid-filter-state',changed);
  },[]);
  return <><ViewsMenu state={state}/><FilterMenu state={state}/></>;
}
