import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
const session = 'image-filters-' + process.pid;
const ab = (...args) => execFileSync('rtk',['proxy','agent-browser','--session',session,...args],{encoding:'utf8',timeout:30000});
function ev(code) {
  writeFileSync('/tmp/image-filter-browser-query.js',code);
  return JSON.parse(execFileSync('rtk',['proxy','agent-browser','--session',session,'eval','--stdin'],{input:readFileSync('/tmp/image-filter-browser-query.js'),encoding:'utf8',timeout:30000}));
}
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
function foreground() { const id = ab('tab','list').match(/\[(t\d+)\]/)[1]; ab('tab',id); }
function reload() { ab('reload'); foreground(); }
const checks = [];
function check(value,label) { if (!value) throw Error(label + '\n' + JSON.stringify(ev('window.gridFilterBridge.state()'))); checks.push(label); if (checks.length % 5 === 0) console.log('Passed ' + checks.length + ': ' + label); }
async function until(code) { for (let i=0;i<100;i++) { if (ev(code)) return; await wait(50); } throw Error('Timed out: ' + code); }
const count = () => ev("Number(document.getElementById('grid-all-count').textContent)");
const state = () => ev('window.gridFilterBridge.state()');
// The CLI types text into segmented date inputs. Use the native value setter
// and normal input events for these controls; other fields use real typing.
function date(label,value) {
  foreground(); ab('focus','[aria-label="' + label + '"]');
  ev('(()=>{const input=document.querySelector(' + JSON.stringify('[aria-label="' + label + '"]') + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,' + JSON.stringify(value) + ');input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));return input.value;})()');
}
function query(rules,mode = 'all') { ev('window.gridFilterBridge.setQuery(' + JSON.stringify({mode,rules}) + ');true'); }
async function hover(selector) { foreground(); ab('hover',selector); await until('document.querySelector(' + JSON.stringify(selector) + ')?.getAttribute("aria-expanded")==="true"'); await wait(60); }
async function save(name) {
  ab('click','#grid-view-trigger'); await hover('[data-branch=view-save]');
  ab('fill','[aria-label="View 名称"]',name); ab('click','.filter-save');
  await until('!window.viewerMenus.isOpen() && Boolean(window.gridFilterBridge.state().viewId)');
}
try {
  ab('set','viewport','1280','800'); ab('open','http://127.0.0.1:4173/library.html?preview=1');
  await until("Boolean(document.querySelector('[data-id=fixture-0] .grid-open'))");
  await ev("(async()=>{const db=await import('/db.js');const images=await db.getImages('preview-account');for(const x of images){const i=Number(x.id.split('-')[1]);await db.updateValue('images',x.key,{width:i%3===0?900:i%3===1?1024:1600,height:i%3===0?1600:i%3===1?1792:900,createdAt:new Date(2026,9,9-i,12).getTime(),conversationId:'chat-'+i});await db.putValue('conversations',{key:'preview-account:chat-'+i,account:'preview-account',id:'chat-'+i,archived:i%2===0,checkedAt:Date.now()});}await db.setHidden('preview-account','fixture-0',true);await db.putValue('settings',{key:'image-views:other-account',views:[{id:'private-other',name:'其它账户 View',scope:'all',query:{mode:'all',rules:[]}}]});return true;})()");
  reload(); await until("document.getElementById('grid-all-count').textContent==='11'");
  check(state().views.length === 0,'Saved View definitions stay account isolated');
  check(!ev("Boolean(document.getElementById('grid-chat-filter')||document.getElementById('chat-filter'))"),'Archive filter is unified and viewer has no separate filter control');
  ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-ratio]');
  check(ev("document.querySelectorAll('.component-menu').length===3 && document.activeElement.tagName!=='INPUT'"),'Hover opens the property editor while retaining every ancestor and without stealing focus');
  ab('find','role','button','click','--name','9:16','--exact'); await until("document.getElementById('grid-all-count').textContent==='3'");
  check(state().query.rules.length === 1,'Preset applies exactly one condition');
  ab('select','[aria-label="比例匹配方式"]','near'); await until("document.getElementById('grid-all-count').textContent==='7'");
  check(state().query.rules.length === 1,'Changing a new condition updates it instead of appending duplicates');
  ab('fill','[aria-label="比例高"]',''); await wait(100); check(count() === 7,'Incomplete custom ratio leaves the previous result active');
  ab('fill','[aria-label="比例高"]','16'); ab('press','Escape'); ab('press','Escape'); ab('press','Escape');
  await save('接近 9:16'); const ratioView = state().viewId;
  check(ev("document.getElementById('grid-view-trigger').textContent.includes('接近 9:16')"),'Saved View name replaces the generic trigger label');
  query([{id:'date',field:'date',op:'range',value:'2026-10-07',end:'2026-10-09'}]); await until("document.getElementById('grid-all-count').textContent==='2'");
  check(state().dirty,'Changing a View is marked modified');
  check(ev("(async()=>{const db=await import('/db.js');return (await db.getValue('settings','image-views:preview-account')).views[0].query.rules[0].field==='ratio';})()"),'Temporary exploration does not overwrite saved View rules');
  ab('click','#grid-view-trigger'); ab('find','role','menuitem','click','--name','恢复已保存条件','--exact'); await until("document.getElementById('grid-all-count').textContent==='7'");
  check(!state().dirty,'Restore returns to the saved definition');
  query([{id:'direction',field:'direction',value:'landscape'}]);
  ab('click','#grid-view-trigger'); ab('find','role','menuitem','click','--name','更新此 View','--exact'); await until('!window.gridFilterBridge.state().dirty');
  check(count() === 4,'Explicit update stores the current rules');
  reload(); await until("document.getElementById('grid-all-count').textContent==='4'");
  check(state().viewId === ratioView && !state().dirty,'View and rules survive a full page reload');
  ab('click','#grid-view-trigger'); await hover('[data-branch=view-manage]'); await hover('[data-branch=view-rename]');
  ab('fill','[aria-label="View 名称"]','横图'); ab('click','.filter-save'); await until("document.getElementById('grid-view-trigger').textContent.includes('横图')");
  check(state().views[0].name === '横图','Rename changes the name without altering rules');
  ab('click','#grid-view-trigger'); await hover('[data-branch=view-manage]'); await hover('[data-branch=view-copy]');
  ab('fill','[aria-label="View 名称"]','横图'); check(ev("document.querySelector('.filter-save').disabled"),'Duplicate names cannot overwrite an existing View');
  ab('fill','[aria-label="View 名称"]','横图副本'); ab('click','.filter-save'); await until('window.gridFilterBridge.state().views.length===2');
  check(state().viewId !== ratioView,'Duplicate creates a distinct View');
  ab('click','#grid-view-trigger'); ab('fill','[aria-label="搜索 View"]','副本');
  check(ev("[...document.querySelectorAll('[role=menuitem]')].filter(n=>n.textContent==='横图').length===0"),'View search narrows saved View choices');
  ab('press','Escape');
  ab('click','#grid-filter-favorites'); await wait(100);
  check(state().viewId === null && state().query.rules[0].field === 'direction','Changing the outer column leaves the View and keeps temporary rules');
  ab('click','#grid-filter-all'); query([]);
  query([{id:'direction',field:'direction',value:'landscape'},{id:'archive',field:'archive',value:'archived'}]);
  await until("document.getElementById('grid-all-count').textContent==='2'");
  check(count() === 2,'All combines orientation and verified archive status');
  query(state().query.rules,'any'); await until("document.getElementById('grid-all-count').textContent==='7'");
  check(count() === 7 && !ev("Boolean(document.querySelector('[data-id=fixture-0]'))"),'Any combines conditions without leaking hidden images');
  ab('click','#grid-select'); ab('click','#grid-select-all'); check(ev("document.getElementById('grid-selection-count').textContent==='已选 7 张'"),'Select all includes only the current filtered result');
  query([{id:'direction',field:'direction',value:'landscape'}]); check(!ev("document.body.classList.contains('grid-selecting')"),'Changing conditions exits multi-select and clears selection');
  ab('click','[data-id=fixture-2] .grid-open'); await until("document.getElementById('main-image').naturalWidth>0&&!document.getElementById('main-image').hidden");
  ab('press','ArrowRight'); await until("document.getElementById('image-title').textContent==='窗边的日落'");
  check(ev("getComputedStyle(document.getElementById('grid-filter-controls')).display!=='none'&&getComputedStyle(document.getElementById('grid-view')).display==='none'"),'Filter entry stays in grid while viewer navigation follows the result');
  ab('mouse','move','600','350'); ab('click','#return-grid');
  check(count() === 4,'Returning from viewer preserves the filter');
  query([{id:'direction',field:'direction',value:'landscape'},{id:'year',field:'date',op:'year',value:'2026'}]);
  ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-ratio]');
  check(ev("document.querySelector('.filter-replacement').textContent.includes('替换图片方向')") && state().query.rules.some(rule=>rule.field==='direction'),'Ratio editor explains replacement without applying it on hover');
  ab('fill','[aria-label="比例高"]',''); check(count() === 4,'Incomplete replacement preserves the active direction and result');
  ab('fill','[aria-label="比例高"]','16'); await until("document.getElementById('grid-all-count').textContent==='3'");
  check(state().query.rules.some(rule=>rule.field==='ratio') && !state().query.rules.some(rule=>rule.field==='direction') && state().query.rules.some(rule=>rule.field==='date'),'Applying a ratio replaces direction and preserves the date condition');
  ab('press','Escape'); ab('press','Escape'); ab('press','Escape');
  ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-direction]');
  check(ev("[...document.querySelectorAll('.filter-menu-label')].some(node=>node.textContent.includes('替换比例'))"),'Direction menu explains the inverse replacement');
  ab('find','role','menuitem','click','--name','竖图','--exact'); await until("document.getElementById('grid-all-count').textContent==='7'");
  check(state().query.rules.some(rule=>rule.field==='direction') && !state().query.rules.some(rule=>rule.field==='ratio') && state().query.rules.some(rule=>rule.field==='date'),'Applying direction replaces ratios and preserves other conditions');
  ab('press','Escape'); ab('press','Escape'); ab('press','Escape');
  query([]);
  await ev("(async()=>{const db=await import('/db.js');await db.updateValue('images','preview-account:fixture-1',{width:0,height:0});await db.putValue('assetInfo',{key:'preview-account:fixture-1:thumbnail',id:'fixture-1',account:'preview-account',kind:'thumbnail',sourceWidth:1024,sourceHeight:1792});await db.updateValue('images','preview-account:fixture-2',{createdAt:0});window.dispatchEvent(new Event('preview-library-event'));return true;})()");
  await wait(250); query([{id:'geometry',field:'direction',value:'portrait'}]); await until("(async()=>{const db=await import('/db.js');const row=(await db.getImages('preview-account')).find(x=>x.id==='fixture-1');return row.width>0&&row.height>0;})()");
  check(state().geometry !== 'failed','Local thumbnail properties fill missing geometry without downloading');
  query([{id:'unknown-date',field:'date',op:'unknown'}]); await until("document.getElementById('grid-all-count').textContent==='1'");
  check(Boolean(ev("document.querySelector('[data-id=fixture-2]')")),'Unknown dates have an explicit filter instead of matching old-date comparisons');
  query([]);
  ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-date]');
  ab('select','[aria-label="日期条件"]','range'); date('开始日期','2026-10-06');
  check(count() === 11,'Half-filled date range leaves the previous result active');
  date('结束日期','2026-10-08'); await until("document.getElementById('grid-all-count').textContent==='2'");
  check(state().query.rules.length === 1,'Date editor applies an inclusive range as one condition');
  date('结束日期','2026-10-05'); check(count() === 2,'Reversed date range does not change the result');
  ab('select','[aria-label="日期条件"]','month'); ab('fill','[aria-label="月份"]','2026-10'); await until("document.getElementById('grid-all-count').textContent==='7'");
  check(state().query.rules.length === 1,'Month editor updates the same date condition');
  ab('select','[aria-label="日期条件"]','year'); ab('fill','[aria-label="年份"]','2026'); await until("document.getElementById('grid-all-count').textContent==='10'");
  check(count() === 10,'Year editor excludes unknown dates');
  ab('select','[aria-label="日期条件"]','unknown'); await until("document.getElementById('grid-all-count').textContent==='1'");
  check(state().query.rules[0].op === 'unknown','Date-unknown editor applies without requiring a value');
  ab('press','Escape'); ab('press','Escape'); ab('press','Escape'); query([]);
  for (const width of [1280,800,580,390,320]) {
    ab('set','viewport',String(width),'720'); foreground(); await until('!document.hidden'); await wait(200);
    check(ev("[...document.querySelectorAll('.grid-toolbar > *, .grid-filters > *')].every(n=>{const r=n.getBoundingClientRect();return r.width===0||r.left>=0&&r.right<=innerWidth+.5})"),'Toolbar fits ' + width + 'px');
    ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-ratio]');
    await until("(()=>{const cards=[...document.querySelectorAll('.component-menu')];return cards.length===3&&cards.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+.5&&r.top>=0&&r.bottom<=innerHeight+.5})})()");
    check(ev("(()=>{const cards=[...document.querySelectorAll('.component-menu')];return cards.length===3&&cards.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+.5&&r.top>=0&&r.bottom<=innerHeight+.5})})()"),'Every menu ancestor remains visible at ' + width + 'px');
    ab('press','Escape'); ab('press','Escape'); ab('press','Escape');
  }
  ab('set','viewport','1280','800'); query([{id:'direction',field:'direction',value:'portrait'}]);
  await ev('window.gridFilterBridge.openView(' + JSON.stringify(ratioView) + ');true');
  ab('click','#grid-view-trigger'); await hover('[data-branch=view-manage]'); await hover('[data-branch=view-delete]'); ab('find','role','menuitem','click','--name','确认删除','--exact');
  await until('window.gridFilterBridge.state().views.length===1');
  check(state().viewId === null && count() === 4,'Deleting a View keeps the current images and temporary rules');
  check(ev("(async()=>{const db=await import('/db.js');return (await db.getImages('preview-account')).length===12;})()"),'View deletion never deletes pictures');
  query([]); await save('图库');
  const allView = state().viewId;
  ev("document.getElementById('grid-scroll').scrollTop=400;true"); await wait(220);
  const savedScroll = ev("document.getElementById('grid-scroll').scrollTop");
  check(savedScroll > 100,'Saved View can be scrolled independently');
  const otherView = state().views.find(view => view.id !== allView).id;
  ev('window.gridFilterBridge.openView(' + JSON.stringify(otherView) + ');true');
  ev('window.gridFilterBridge.openView(' + JSON.stringify(allView) + ');true');
  await wait(100);
  check(Math.abs(ev("document.getElementById('grid-scroll').scrollTop") - savedScroll) < 1,'Returning to a View restores its own image anchor and scroll position');
  query([{id:'keep-anchor',field:'date',op:'gte',value:'2026-01-01'},{id:'include-unknown',field:'date',op:'unknown'}],'any');
  check(Math.abs(ev("document.getElementById('grid-scroll').scrollTop") - savedScroll) < 1,'Condition changes preserve an anchor that still matches');
  query([{id:'missing-anchor',field:'date',op:'day',value:'2026-10-08'}]);
  check(ev("document.getElementById('grid-scroll').scrollTop") === 0,'A removed anchor returns to the first result');
  query([]);
  mkdirSync('artifacts',{recursive:true}); ab('click','#grid-filter-trigger'); await hover('[data-branch=filter-add]'); await hover('[data-branch=filter-add-ratio]');
  ab('screenshot','artifacts/image-filter-menu.png');
  writeFileSync('artifacts/image-filter-verification.json',JSON.stringify({checks},null,2)); console.log(checks.length + ' filter browser checks passed');
} catch (error) {
  mkdirSync('artifacts',{recursive:true});
  console.log(JSON.stringify(ev("({viewport:[innerWidth,innerHeight],menus:[...document.querySelectorAll('.component-menu')].map(n=>({depth:n.dataset.depth,root:n.dataset.rootTrigger,rect:n.getBoundingClientRect().toJSON()}))})"),null,2));
  console.log(JSON.stringify({checks,state:state(),count:count(),persisted:ev("(async()=>{const db=await import('/db.js');return {view:await db.getValue('views','preview-account'),definitions:await db.getValue('settings','image-views:preview-account')};})()")},null,2));
  ab('screenshot','artifacts/image-filter-failure.png');
  throw error;
} finally { ab('close'); }
