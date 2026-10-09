import React, { useEffect, useLayoutEffect, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { menuStackLayout } from '../extension/viewer-layout.js';

const $ = id => document.getElementById(id);
export const roots = new Set();
let layoutFrame;
export function layoutMenus() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll('.component-menu')].sort((a,b) => +a.dataset.depth - +b.dataset.depth);
    if (!cards.length) return;
    const surface = $(cards[0].dataset.rootTrigger.startsWith('grid-') ? 'grid-view' : 'viewer').getBoundingClientRect();
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
export const Icon = ({ name }) => <svg className="icon" aria-hidden="true"><use href={`#icon-${name}`}/></svg>;
function observeCard(node) {
  if (!node) { layoutMenus(); return; }
  const observer = new ResizeObserver(layoutMenus);
  observer.observe(node);
  layoutMenus();
  return () => { observer.disconnect(); layoutMenus(); };
}
export function Card({ depth, rootTrigger, form, children, ...props }) {
  useLayoutEffect(() => { layoutMenus(); return layoutMenus; });
  const Component = depth ? Menu.SubContent : Menu.Content;
  // Portal content can mount after its parent's layout effect. Recalculate
  // when the actual card mounts, so the newest level is included in the budget.
  return <Menu.Portal><Component ref={observeCard} className="component-menu" data-depth={depth} data-root-trigger={rootTrigger}
    data-form={form || undefined} sideOffset={6} collisionPadding={8} align="end" loop
    onCloseAutoFocus={event => event.preventDefault()} {...props}>{children}</Component></Menu.Portal>;
}
export function Branch({ label, icon, id, depth, children, form, rootTrigger='toggle-more' }) {
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
