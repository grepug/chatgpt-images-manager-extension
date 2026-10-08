import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
const session=process.env.GRID_TEST_SESSION || `grid-multiselect-${process.pid}`;
const ab=(...args)=>execFileSync('rtk',['proxy','agent-browser','--session',session,...args],{encoding:'utf8',timeout:30000});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ev(code) {const file='/tmp/grid-selection-query.js';writeFileSync(file,code);return JSON.parse(execFileSync('rtk',['proxy','agent-browser','--session',session,'eval','--stdin'],{input:readFileSync(file),encoding:'utf8',timeout:30000}));}
const q=()=>ev(`(() => {
 const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
 return {active:document.body.classList.contains('grid-selecting'),grid:document.body.classList.contains('grid-layout'),
 count:document.getElementById('grid-selection-count').textContent,scroll:document.getElementById('grid-scroll').scrollTop,
 selected:[...document.querySelectorAll('.is-batch-selected')].map(n=>n.dataset.id),mounted:document.querySelectorAll('.grid-card').length,
 total:document.getElementById('grid-all-count').textContent,hidden:document.getElementById('grid-hidden-count').textContent,
 toolbar:rect(document.querySelector('.grid-toolbar')),tools:rect(document.querySelector('.grid-tools')),
 favoriteDisabled:document.getElementById('grid-favorite-selected').disabled,
 toast:document.getElementById('status-text').textContent,animations:document.getAnimations().filter(a=>a.playState==='running').length,
 stop:!document.getElementById('grid-selection-stop').hidden};
})()`);
let checks=[];
function check(value,label){if(!value)throw Error(label+'\n'+JSON.stringify(q(),null,2));checks.push(label);}
async function idle(){for(let i=0;i<100&&q().stop;i++)await wait(50);await wait(320);check(!q().stop,'Batch completes');}
async function init(){ab('set','viewport','1280','800');ab('open','http://127.0.0.1:4173/library.html?preview=1');ab('tab','t1');
 for(let i=0;i<50&&!ev('Boolean(document.querySelector("[data-id=fixture-0] .grid-open"))');i++)await wait(100);
 if(!q().grid)ev("document.getElementById('return-grid').click();true");}
await init();
await ev(`(async()=>{const db=await import('/db.js');await db.setBulkFlags('preview-account',Array.from({length:12},(_,i)=>'fixture-'+i),'hidden',false);for(let i=0;i<12;i++)await db.setFavorite('preview-account','fixture-'+i,[0,3,6].includes(i));window.dispatchEvent(new Event('preview-library-event'));return true;})()`);
await wait(350);
for(let i=0;i<100&&!ev("[...document.querySelectorAll('.grid-image')].every(i=>i.naturalWidth>0)");i++) await wait(50);
check(ev("[...document.querySelectorAll('.grid-image')].length>0&&[...document.querySelectorAll('.grid-image')].every(i=>i.naturalWidth>0)"),'Grid thumbnails actually display');
let toolbar=q().toolbar;
ab('click','#grid-select');await wait(180);check(q().active&&q().toolbar.h===toolbar.h,'Entering selection preserves toolbar height');
ab('click','[data-id=fixture-0] .grid-open');check(q().grid&&q().selected.includes('fixture-0'),'Card click selects without opening viewer');
check(ev("getComputedStyle(document.querySelector('[data-id=fixture-0] .grid-favorite')).display==='none'"),'Individual card actions are suppressed');
ab('focus','[data-id=fixture-1] .grid-open');ab('press','Enter');check(q().selected.includes('fixture-1'),'Enter selects focused card');
ab('press','Space');check(!q().selected.includes('fixture-1'),'Space toggles focused selection');
ev("document.querySelector('[data-id=fixture-3] .grid-open').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));true");
check(q().count==='已选 4 张','Shift range follows last clicked anchor');
ab('click','#grid-size-small');await wait(100);check(q().count==='已选 4 张','Size change retains selection');
ab('click','#grid-favorite-selected');await idle();check(q().active&&q().count==='已选 0 张','Successful favorite clears successes and stays in selection');
check(await ev("(async()=>{const db=await import('/db.js');return (await db.getImages('preview-account')).filter(i=>[1,2,3].includes(+i.id.split('-')[1])).every(i=>i.favorite)})()"),'Bulk favorite sets true for both mixed and already favorite items');
ab('click','[data-id=fixture-3] .grid-open');check(q().favoriteDisabled,'Already favorite selection disables repeat favorite');
ab('click','#grid-toggle-actions');await wait(100);ab('click','[data-action=grid-unfavorite-selected]');await idle();
check(await ev("(async()=>{const db=await import('/db.js');return !(await db.getImages('preview-account')).find(i=>i.id==='fixture-3').favorite&&Boolean(await db.getAsset('preview-account','fixture-3'));})()"),'Secondary unfavorite preserves original bytes');
ab('click','[data-id=fixture-1] .grid-open');ab('click','[data-id=fixture-2] .grid-open');
ev("window.batchAnimationCount=0;const animate=Element.prototype.animate;Element.prototype.animate=function(...args){window.batchAnimationCount++;return animate.apply(this,args)};true");
ab('click','#grid-hide-selected');await idle();check(q().hidden==='2'&&!ev("Boolean(document.querySelector('[data-id=fixture-1]'))"),'Bulk hide removes selected images from all');
check(ev('window.batchAnimationCount>0'),'Hide uses existing exit and layout animations');
ab('click','#grid-filter-hidden');check(!q().active,'Column switch exits and clears selection');
ab('click','#grid-select');ab('click','#grid-select-all');check(q().count==='已选 2 张','Select all respects hidden column');
check(ev("document.getElementById('grid-hide-selected').ariaLabel==='取消隐藏'"),'Hidden column offers unhide');
ab('click','#grid-hide-selected');await idle();check(q().hidden==='0','Bulk unhide restores all without deleting data');
ab('click','#grid-filter-all');ab('click','#grid-select');ab('press','Meta+a');check(q().count==='已选 12 张','Cmd+A selects whole current column');
ab('press','Escape');check(!q().active,'Escape exits and clears idle selection');
for(const width of [1280,800,580,390,320]){
 ab('set','viewport',String(width),'720');await wait(120);const before=q();ab('click','#grid-select');await wait(180);const after=q();
 check(before.toolbar.h===after.toolbar.h&&Math.abs(before.scroll-after.scroll)<1,`Toolbar and scroll stay stable at ${width}px`);
 check(after.tools.right<=width+.5&&after.tools.x>=0,`Toolbar fits at ${width}px`);
 if(width===320){ab('click','#grid-toggle-actions');await wait(100);check(ev("(()=>{const r=document.querySelector('.component-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+.5})()"),'Compact menu fits narrow viewport');ab('press','Escape');}
 ab('click','#grid-selection-done');
}
ab('set','viewport','1280','800');await wait(120);ab('click','#grid-select');ab('click','[data-id=fixture-0] .grid-open');
await ev(`(async()=>{const db=await import('/db.js');const connection=await db.database();window.originalTransaction=connection.transaction.bind(connection);connection.transaction=(stores,mode,...args)=>{const tx=window.originalTransaction(stores,mode,...args);if(mode==='readwrite'&&stores.includes('hidden')){const original=tx.objectStore.bind(tx);tx.objectStore=name=>{const store=original(name);if(name==='images')store.put=()=>{throw new Error('测试磁盘写入失败')};return store;};}return tx;};return true;})()`);
ab('click','#grid-toggle-actions');await wait(60);ab('click','[data-action=grid-unfavorite-selected]');await idle();
check(q().count==='已选 1 张'&&q().toast.includes('1 张失败'),'Storage failure retains selection with direct failure Toast');
await ev("(async()=>{const db=await import('/db.js');(await db.database()).transaction=window.originalTransaction;return true;})()");
ab('click','#grid-toggle-actions');await wait(60);ab('click','[data-action=grid-unfavorite-selected]');await idle();check(q().count==='已选 0 张','Failed selected items can be retried');
mkdirSync('artifacts',{recursive:true});
for(const id of [0,1,3]) ab('click',`[data-id=fixture-${id}] .grid-open`);
ab('click','#grid-size-medium');await wait(200);
for(let i=0;i<50&&!ev("[...document.querySelectorAll('.grid-image')].every(i=>i.naturalWidth>0)");i++) await wait(50);
check(ev("[...document.querySelectorAll('.grid-image')].every(i=>i.naturalWidth>0)"),'Selected and unselected thumbnails remain visible');
ab('screenshot','artifacts/grid-multiselect-wide.png');
ab('set','viewport','390','720');await wait(180);ab('click','#grid-toggle-actions');await wait(100);ab('screenshot','artifacts/grid-multiselect-narrow.png');ab('press','Escape');
ab('set','viewport','1280','800');await wait(120);ab('click','#grid-clear-selection');
await ev(`(async()=>{const db=await import('/db.js');await db.mergeLibrary('preview-account',Array.from({length:2000},(_,i)=>({id:'stress-'+i,title:'测试图片 '+i,width:900,height:900,createdAt:1+i})));window.dispatchEvent(new Event('preview-library-event'));return true;})()`);
await wait(700);ab('press','Meta+a');check(q().count==='已选 2012 张'&&q().mounted<80,'Full selection includes unmounted cards without mounting the library');
ev("document.getElementById('grid-scroll').scrollTop=50000;true");await wait(200);check(q().count==='已选 2012 张'&&q().mounted<80,'Deep scrolling keeps full selection and bounded DOM');
const scroll=q().scroll;ab('click','#grid-size-large');await wait(180);check(q().count==='已选 2012 张','Large size retains offscreen selection');
ev("window.stopObserver=new MutationObserver(()=>{if(document.getElementById('grid-selection-count').textContent.match(/收藏 50 \\/ /)){window.stopObserver.disconnect();document.getElementById('grid-selection-stop').click();}});window.stopObserver.observe(document.getElementById('grid-selection-count'),{subtree:true,childList:true});true");
ev("document.getElementById('grid-favorite-selected').click();true");await idle();check(q().count==='已选 1962 张'&&q().toast.includes('1962 张未处理'),'Stop finishes current chunk and leaves remaining work selected');
check(q().mounted<80,'Bulk completion retains bounded DOM');
await ev(`(async()=>{const db=await import('/db.js');const connection=await db.database(), tx=connection.transaction('images','readwrite');tx.objectStore('images').delete('preview-account:stress-1000');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject});window.dispatchEvent(new Event('preview-library-event'));return true;})()`);
await wait(400);check(q().count==='已选 1961 张','Refresh prunes missing selected IDs without exiting');
ab('set','viewport','390','720');await wait(180);ab('click','#grid-toggle-actions');await wait(100);
ab('press','Escape');
ab('click','#grid-selection-done');ev("document.getElementById('grid-scroll').scrollTop=0;true");ab('set','viewport','1280','800');await wait(180);
ab('set','media','dark','reduced-motion');ab('click','#grid-select');ab('click','[data-id=fixture-0] .grid-open');
check(ev("getComputedStyle(document.querySelector('.grid-card')).transitionDuration==='0s'&&getComputedStyle(document.querySelector('.grid-tools-normal')).transitionDuration==='0s'"),'Reduced motion disables selection and toolbar transitions');
ev('window.batchAnimationCount=0;true');ab('click','#grid-hide-selected');await idle();
check(ev('window.batchAnimationCount===0'),'Reduced motion skips exit and layout animations');
check(JSON.parse(ab('errors','--json')).data.errors.length===0,'No uncaught browser errors');
writeFileSync('artifacts/grid-multiselect-verification.json',JSON.stringify({checks,at:new Date().toISOString()},null,2));
console.log(JSON.stringify({passed:checks.length,checks},null,2));
ab('close');
