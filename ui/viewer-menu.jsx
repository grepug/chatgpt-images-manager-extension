// Radix owns hover, focus, keyboard and dismissal; the gallery owns commands.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { roots, layoutMenus, Icon, Card, Branch } from './menu-components.jsx';
import { GridFilters } from './grid-filters.jsx';

const $ = id => document.getElementById(id);
function Action({ id, label, icon, shortcut }) {
  const node = $(id);
  if (node?.hidden) return null;
  return <Menu.Item className="component-item" data-action={id} disabled={node?.disabled}
    onSelect={() => window.viewerMenuBridge.action(id)}>
    {icon && <Icon name={icon}/>}<span>{label || node?.querySelector('span')?.textContent.trim() || node?.textContent.trim()}</span>{shortcut && <kbd>{shortcut}</kbd>}
  </Menu.Item>;
}
function Embedded({ id }) {
  const ref = React.useRef(null);
  useLayoutEffect(() => {
    const node = $(id), parent = node.parentElement, next = node.nextSibling;
    node.hidden = false; node.classList.add('component-embedded');
    ref.current.append(node);
    // Embedded content is already inside the menu's focus layer. Native
    // dialog.show() would autofocus it during a mere hover opening.
    if (node.tagName === 'DIALOG') node.setAttribute('open', '');
    window.viewerMenuBridge.prepare(id); layoutMenus();
    const close = () => window.viewerMenus.close();
    node.addEventListener('close', close);
    return () => {
      node.removeEventListener('close', close);
      if (node.tagName === 'DIALOG') node.close(); else node.hidden = true;
      node.classList.remove('component-embedded');
      parent.insertBefore(node,next?.parentElement === parent ? next : null);
    };
  },[id]);
  return <div ref={ref} onKeyDown={event => {
    if (event.target.closest('input,textarea,select') && event.key !== 'Escape') event.stopPropagation();
  }}/>;
}
function Dropdown({ zoom=false, grid=false }) {
  const [open,setOpen] = useState(false), [,rerender] = useState(0);
  const triggerId = grid ? 'grid-toggle-actions' : zoom ? 'toggle-zoom' : 'toggle-more';
  const changeOpen = value => {
    if (value) {
      for (const root of roots) root.close();
      window.viewerMenuBridge.closeEditor();
    }
    setOpen(value);
  };
  useEffect(() => {
    const controller = { close: () => setOpen(false), isOpen: () => open };
    roots.add(controller); return () => roots.delete(controller);
  },[open]);
  useEffect(() => {
    const observer = new MutationObserver(() => rerender(value => value + 1));
    // Read existing command state without replacing the gallery controller.
    for (const id of grid ? ['grid-select-all','grid-clear-selection','grid-hide-selected','grid-favorite-selected','grid-unfavorite-selected','grid-archive-selected'] : ['more-panel','actual-size'])
      observer.observe($(id), {subtree:true,attributes:true,childList:true,characterData:true});
    return () => observer.disconnect();
  },[]);
  return <Menu.Root modal={false} open={open} onOpenChange={changeOpen}>
    <Menu.Trigger id={triggerId} className={zoom ? 'zoom-trigger' : 'icon-button'}
      aria-label={grid ? '多选操作' : zoom ? '缩放选项' : '更多图片操作'} title={grid ? '多选操作' : zoom ? '缩放选项' : '更多图片操作'}
      disabled={zoom && $('actual-size').disabled}
      onClick={event => { if (event.detail === 0) changeOpen(!open); }}>
      {zoom ? <><span id="zoom-percentage">{$('actual-size').textContent}</span><span className="menu-chevron">⌄</span></> : <Icon name="more"/>}
    </Menu.Trigger>
    <Card depth={0} rootTrigger={triggerId}>
      {grid ? <>
        <Action id="grid-select-all" icon="check"/>
        <Action id="grid-clear-selection" icon="minus"/>
        <Menu.Separator className="component-separator"/>
        <Action id="grid-hide-selected" icon="hide"/>
        <Action id="grid-favorite-selected" icon="star" shortcut="F"/>
        <Action id="grid-unfavorite-selected" icon="star"/>
        <Menu.Separator className="component-separator"/>
        <Action id="grid-archive-selected" icon="archive"/>
      </> : zoom ? <ZoomItems/> : <>
        <Action id="menu-favorite" icon="star" shortcut="F"/>
        <Branch label="缩放" icon="fit" id="zoom" depth={1}><ZoomItems/></Branch>
        <Menu.Separator className="component-separator"/>
        <Action id="hide-image" icon="hide"/>
        <Action id="locate-all" label="在全部图片中定位" icon="locate"/>
        <Action id="copy-prompt" label="复制 prompt" icon="copy"/>
        <Action id="conversation" label="打开原聊天" icon="chat"/>
        <Action id="archive-chat" icon="archive"/>
        <Action id="download" label="下载图片" icon="download"/>
        <Menu.Separator className="component-separator"/>
        <Branch label="图片详情" icon="info" id="details" depth={1} form><Embedded id="details-panel"/></Branch>
        <Branch label="图片库" icon="images" id="library" depth={1}>
          <Action id="viewer-refresh" label="刷新图片库" icon="refresh"/>
          <Branch label="缓存设置" icon="settings" id="settings" depth={2} form><Embedded id="settings-dialog"/></Branch>
          <Branch label="快捷键说明" icon="help" id="help" depth={2} form><Embedded id="help-dialog"/></Branch>
        </Branch>
      </>}
    </Card>
  </Menu.Root>;
}
function ZoomItems() { return <>
  <Action id="fit" label="适应窗口" icon="fit" shortcut="0"/>
  <Action id="actual-size" label="原始尺寸" icon="images" shortcut="1"/>
  <Action id="zoom-in" label="放大图片" icon="plus"/>
  <Action id="zoom-out" label="缩小图片" icon="minus"/>
</>; }

if (!window.viewerMenuBridge) await new Promise(resolve => window.addEventListener('viewer-menu-ready',resolve,{once:true}));
window.viewerMenus = {
  close() { for (const root of roots) root.close(); },
  isOpen() { return [...roots].some(root => root.isOpen()); },
  layout: layoutMenus,
};
for (const options of [{},{zoom:true},{grid:true}]) {
  const original = $(options.grid ? 'grid-toggle-actions' : options.zoom ? 'toggle-zoom' : 'toggle-more'), host = document.createElement('span');
  host.className = 'component-menu-mount'; original.replaceWith(host);
  flushSync(() => createRoot(host).render(<Dropdown {...options}/>));
}
window.addEventListener('resize',layoutMenus);

const filterHost = $('grid-filter-controls');
flushSync(() => createRoot(filterHost).render(<GridFilters/>));
