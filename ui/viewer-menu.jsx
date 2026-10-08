// Radix owns hover, focus, keyboard and dismissal; the gallery owns commands.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { menuStackLayout } from '../extension/viewer-layout.js';

const $ = id => document.getElementById(id);
const roots = new Set();
let layoutFrame;
function layoutMenus() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll('.component-menu')].sort((a,b) => +a.dataset.depth - +b.dataset.depth);
    if (!cards.length) return;
    const surface = $('viewer').getBoundingClientRect();
    const stacked = cards.reduce((total,node) => total + (node.dataset.form ? 300 : 232), 0) + 6 * cards.length > surface.width - 16;
    document.body.classList.toggle('component-menu-stacked', stacked);
    for (const card of cards) {
      card.parentElement.classList.toggle('stacked-menu-position', stacked);
      if (!stacked) {
        for (const name of ['left','top','width']) card.parentElement.style.removeProperty(name);
        card.style.removeProperty('max-height');
      }
    }
    if (!stacked) return;
    const trigger = $(cards[0].dataset.rootTrigger).getBoundingClientRect();
    const positions = menuStackLayout({ surface, trigger, windowHeight: innerHeight,
      heights: cards.map(card => card.scrollHeight + 2), widths: cards.map(card => card.dataset.form ? 300 : 232) });
    cards.forEach((card,index) => {
      const { x, y, width, height } = positions[index];
      Object.assign(card.parentElement.style, { left: `${x}px`, top: `${y}px`, width: `${width}px` });
      card.style.maxHeight = `${height}px`;
      // Keep the open branch visible when an ancestor becomes scrollable.
      const selected = card.querySelector('[aria-expanded="true"]');
      if (selected && card.dataset.lastBudget !== `${height}:${selected.id}`) {
        card.dataset.lastBudget = `${height}:${selected.id}`;
        const row = selected.getBoundingClientRect(), box = card.getBoundingClientRect();
        if (row.bottom > box.bottom - 5) card.scrollTop += row.bottom - box.bottom + 5;
        if (row.top < box.top + 5) card.scrollTop -= box.top + 5 - row.top;
      }
    });
  });
}
const Icon = ({ name }) => <svg className="icon" aria-hidden="true"><use href={`#icon-${name}`}/></svg>;
function Action({ id, label, icon, shortcut }) {
  const node = $(id);
  if (node?.hidden) return null;
  return <Menu.Item className="component-item" data-action={id} disabled={node?.disabled}
    onSelect={() => window.viewerMenuBridge.action(id)}>
    {icon && <Icon name={icon}/>}<span>{label || node?.querySelector('span')?.textContent.trim() || node?.textContent.trim()}</span>{shortcut && <kbd>{shortcut}</kbd>}
  </Menu.Item>;
}
function Card({ depth, rootTrigger, form, children, ...props }) {
  useLayoutEffect(() => { layoutMenus(); return layoutMenus; });
  const Component = depth ? Menu.SubContent : Menu.Content;
  return <Menu.Portal><Component className="component-menu" data-depth={depth} data-root-trigger={rootTrigger}
    data-form={form || undefined} sideOffset={6} collisionPadding={8} align="end" loop
    onCloseAutoFocus={event => event.preventDefault()} {...props}>{children}</Component></Menu.Portal>;
}
function Branch({ label, icon, id, depth, children, form, rootTrigger='toggle-more' }) {
  const [open,setOpen] = useState(false);
  useEffect(() => { layoutMenus(); },[open]);
  return <Menu.Sub open={open} onOpenChange={setOpen}>
    <Menu.SubTrigger className="component-item" data-branch={id} onPointerLeave={event => {
      // Portalled descendants can be entered in one fast pointer movement.
      // Keep that explicit transition and vertical gaps outside the horizontal
      // grace polygon. Other items still dismiss through Radix focus handling.
      const destination = event.relatedTarget?.closest?.('.component-menu');
      if (open && (document.body.classList.contains('component-menu-stacked')
        || destination && Number(destination.dataset.depth) >= depth)) event.preventDefault();
    }}>
      <Icon name={icon}/><span>{label}</span><span className="component-chevron">›</span>
    </Menu.SubTrigger>
    <Card depth={depth} rootTrigger={rootTrigger} form={form}>
      {children}
    </Card>
  </Menu.Sub>;
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
function Dropdown({ zoom=false }) {
  const [open,setOpen] = useState(false), [,rerender] = useState(0);
  const triggerId = zoom ? 'toggle-zoom' : 'toggle-more';
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
    observer.observe($('more-panel'), {subtree:true,attributes:true,childList:true,characterData:true});
    observer.observe($('actual-size'), {attributes:true,childList:true,characterData:true});
    return () => observer.disconnect();
  },[]);
  return <Menu.Root modal={false} open={open} onOpenChange={changeOpen}>
    <Menu.Trigger id={triggerId} className={zoom ? 'zoom-trigger' : 'icon-button'}
      aria-label={zoom ? '缩放选项' : '更多图片操作'} title={zoom ? '缩放选项' : '更多图片操作'}
      disabled={zoom && $('actual-size').disabled}
      onClick={event => { if (event.detail === 0) changeOpen(!open); }}>
      {zoom ? <><span id="zoom-percentage">{$('actual-size').textContent}</span><span className="menu-chevron">⌄</span></> : <Icon name="more"/>}
    </Menu.Trigger>
    <Card depth={0} rootTrigger={triggerId}>
      {zoom ? <ZoomItems/> : <>
        <Action id="menu-favorite" icon="star" shortcut="F"/>
        <Branch label="缩放" icon="fit" id="zoom" depth={1}><ZoomItems/></Branch>
        <Menu.Separator className="component-separator"/>
        <Action id="hide-image" icon="hide"/>
        <Action id="locate-all" label="在全部图片中定位" icon="locate"/>
        <Action id="copy-prompt" label="复制 prompt" icon="copy"/>
        <Action id="conversation" label="打开原聊天" icon="chat"/>
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
for (const zoom of [false,true]) {
  const original = $(zoom ? 'toggle-zoom' : 'toggle-more'), host = document.createElement('span');
  host.className = 'component-menu-mount'; original.replaceWith(host);
  flushSync(() => createRoot(host).render(<Dropdown zoom={zoom}/>));
}
window.addEventListener('resize',layoutMenus);
