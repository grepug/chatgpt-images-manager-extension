import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
const session = 'chat-archive-' + process.pid;
const ab = (...args) => execFileSync('rtk',['proxy','agent-browser','--session',session,...args],{encoding:'utf8',timeout:30000});
function ev(code) {
  writeFileSync('/tmp/chat-archive-browser-query.js',code);
  return JSON.parse(execFileSync('rtk',['proxy','agent-browser','--session',session,'eval','--stdin'],{input:readFileSync('/tmp/chat-archive-browser-query.js'),encoding:'utf8',timeout:30000}));
}
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
let checks=[];
function check(value,label) { if(!value) throw Error(label+'\n'+JSON.stringify(ev("({count:document.getElementById('grid-selection-count').textContent,toast:document.getElementById('status-text').textContent,calls:window.archiveCalls,clicks:window.gridClicks,filter:document.getElementById('grid-chat-filter').value})"))); checks.push(label); }
async function until(code) { for(let i=0;i<100;i++){if(ev(code))return;await wait(50);}throw Error('Timed out: '+code); }
const selected = () => ev("document.getElementById('grid-selection-count').textContent");
const badge = id => ev("document.querySelector('[data-id=fixture-"+id+"] .chat-archive-badge')?.dataset.state");
async function choose(ids) {
  if(!ev("document.body.classList.contains('grid-selecting')"))ab('click','#grid-select');
  ab('click','#grid-clear-selection');
  for(const id of ids){
    ev("document.querySelector('[data-id=fixture-"+id+"] .grid-open').scrollIntoView({block:'nearest'});true");
    await wait(100);ab('click','[data-id=fixture-'+id+'] .grid-open');await wait(80);
  }
}
async function confirm() { ab('click','#grid-archive-selected');await until("document.getElementById('archive-confirm').open");ab('click','#archive-execute'); }
async function idle() { await until("document.getElementById('grid-selection-stop').hidden");await wait(300); }
try {
  ab('set','viewport','1280','800');ab('open','http://127.0.0.1:4173/library.html?preview=1');
  await until("Boolean(document.querySelector('[data-id=fixture-0] .grid-open'))");
  ev("window.gridClicks=[];document.getElementById('grid-canvas').addEventListener('click',e=>window.gridClicks.push(e.target.closest('[data-id]')?.dataset.id));true");
  await ev("(async()=>{const db=await import('/db.js');const images=await db.getImages('preview-account');await db.mergeLibrary('preview-account',images.map((x,i)=>({...x,conversationId:'c'+Math.floor(Number(x.id.split('-')[1])/3)})));await db.putValue('conversations',{key:'preview-account:c1',id:'c1',account:'preview-account',archived:true,checkedAt:Date.now()});window.dispatchEvent(new Event('preview-library-event'));window.archiveCalls=[];window.addEventListener('preview-archive-chat',e=>window.archiveCalls.push(e.detail.id));return true;})()");
  await until("document.querySelector('[data-id=fixture-3] .chat-archive-badge')?.dataset.state==='archived'");
  await until("[...document.querySelectorAll('.grid-image')].every(i=>i.naturalWidth>0)");
  check(badge(0)==='unarchived'&&badge(3)==='archived','Every card retains verified archived or unarchived chat state');
  check(ev("(()=>{const b=document.querySelector('[data-id=fixture-0] .chat-archive-badge');return !b.hidden&&!b.textContent&&b.querySelector('use').getAttribute('href')==='#icon-chat'&&b.title.includes('聊天未归档')})()"),'Unarchived state uses a compact icon with a readable tooltip');
  check(ev("(()=>{const n=document.querySelector('[data-id=fixture-3]');return getComputedStyle(n.querySelector('.chat-archive-badge')).display==='none'&&n.querySelector('.grid-open').getAttribute('aria-label').includes('聊天已归档')&&n.getBoundingClientRect().width>0})()"),'Archived badge is hidden while its image and accessible status remain');
  await ev("(async()=>{const db=await import('/db.js');await db.putValue('conversations',{key:'preview-account:c0',id:'c0',account:'preview-account',archived:false,checkedAt:Date.now(),error:'读取失败',errorAt:Date.now()});return true;})()");
  ab('reload');await until("document.querySelector('[data-id=fixture-0] .chat-archive-badge')?.dataset.state==='unknown'");
  check(ev("(()=>{const b=document.querySelector('[data-id=fixture-0] .chat-archive-badge');return !b.hidden&&!b.textContent&&b.querySelector('use').getAttribute('href')==='#icon-info'&&b.title.includes('归档状态未能确认')})()"),'Unknown state uses a distinct icon without claiming unarchived');
  await ev("(async()=>{const db=await import('/db.js');await db.putValue('conversations',{key:'preview-account:c0',id:'c0',account:'preview-account',archived:false,checkedAt:Date.now()});return true;})()");
  ab('reload');await until("document.querySelector('[data-id=fixture-0] .chat-archive-badge')?.dataset.state==='unarchived'");
  ev("window.archiveCalls=[];window.addEventListener('preview-archive-chat',e=>window.archiveCalls.push(e.detail.id));true");
  ev("window.cachedArchiveImages=new Map([...document.querySelectorAll('.grid-card')].map(n=>[n.dataset.id,{node:n,img:n.querySelector('img'),src:n.querySelector('img').src}]));true");
  await choose([0,1,3]);ab('click','#grid-archive-selected');await until("document.getElementById('archive-confirm').open");
  check(ev("document.getElementById('archive-summary').textContent.includes('3 张图片，涉及 2 个聊天')"),'Confirmation distinguishes image count from deduplicated chat count');
  ab('click','#archive-dismiss');check(selected()==='已选 3 张','Cancel keeps selection');
  await confirm();await idle();
  check(ev("window.archiveCalls.length===2&&new Set(window.archiveCalls).size===2"),'Batch processes each chat once');
  check(selected()==='已选 0 张','Success and already archived results leave selection');
  check(badge(2)==='archived'&&badge(4)==='archived','Unselected pictures in the same chats synchronize');
  check(ev("document.getElementById('status-text').textContent.includes('已归档 1 个聊天')&&document.getElementById('status-text').textContent.includes('跳过已归档 1 个')"),'Toast reports success and skip separately');
  check(ev("[...window.cachedArchiveImages].every(([id,r])=>{const n=document.querySelector('[data-id='+id+']');return n===r.node&&n.querySelector('img')===r.img&&n.querySelector('img').src===r.src})"),'Chat state updates preserve card nodes and image URLs');
  ab('click','#grid-selection-done');ab('select','#grid-chat-filter','archived');await wait(300);
  check(ev("document.getElementById('grid-all-count').textContent==='6'"),'Archived filter shows all images of archived chats');
  ab('select','#grid-chat-filter','unarchived');await wait(300);
  check(ev("document.getElementById('grid-all-count').textContent==='6'"),'Unarchived filter excludes archived chats');
  ab('select','#grid-chat-filter','any');await wait(300);
  await choose([6,9]);check(selected()==='已选 2 张','Two different chats are selected before failure');ev("localStorage.setItem('previewArchiveFail','c2');true");await confirm();await idle();
  check(selected()==='已选 2 张','Failure and unprocessed chat pictures remain selected');
  check(ev("document.getElementById('status-text').textContent.includes('1 个失败')&&document.getElementById('status-text').textContent.includes('1 个未处理')"),'Failure does not claim completion');
  ev("localStorage.removeItem('previewArchiveFail');true");await confirm();await idle();check(selected()==='已选 0 张'&&badge(8)==='archived','Retry succeeds and updates related images');
  ab('click','#grid-selection-done');
  await ev("(async()=>{const db=await import('/db.js');for(const id of ['c2','c3'])await db.putValue('conversations',{key:'preview-account:'+id,id,account:'preview-account',archived:false,checkedAt:Date.now()+1});return true;})()");
  // New local session state is read on reload, mirroring a website-side change.
  ab('reload');await until("document.querySelector('[data-id=fixture-6] .chat-archive-badge')?.dataset.state==='unarchived'");
  await choose([6,9]);ev("window.addEventListener('preview-archive-chat',()=>setTimeout(()=>document.getElementById('grid-selection-stop').click(),30),{once:true});true");
  await confirm();await idle();check(selected()==='已选 1 张','Stop finishes the current chat and preserves the next selection');
  check(ev("document.getElementById('status-text').textContent.includes('1 个未处理')"),'Stopped work is reported as unprocessed');
  ab('click','#grid-selection-done');ab('click','[data-id=fixture-9] .grid-open');await until("document.getElementById('main-image').naturalWidth>0");
  check(ev("document.getElementById('image-meta').textContent.includes('聊天未归档')"),'Viewer details show chat status');
  ab('click','#toggle-more');await wait(100);ab('click','[data-action=archive-chat]');
  await until("document.getElementById('archive-chat').querySelector('span').textContent==='所在聊天已归档'");
  check(ev("document.getElementById('archive-chat').disabled"),'Single-image archive updates its menu without a batch confirmation');
  ab('click','#toggle-sidebar');ab('select','#chat-filter','archived');await wait(350);
  check(ev("(()=>{const badges=[...document.querySelectorAll('.virtual-thumbnail .chat-archive-badge')];return badges.length>0&&badges.every(b=>getComputedStyle(b).display==='none')})()"),'Archived thumbnail sidebar also omits status badges');
  ab('reload');await until("document.getElementById('main-image').naturalWidth>0&&!document.getElementById('main-image').hidden");
  check(ev("document.getElementById('image-title').textContent==='柔和的光影'&&document.getElementById('chat-filter').value==='archived'"),'Reopening a filtered viewer restores its saved image after cached chat states load');
  ab('select','#chat-filter','unarchived');await wait(300);
  check(ev("document.getElementById('main-image').hidden&&!document.getElementById('empty-state').hidden"),'An empty chat filter clears the old viewer image');
  ab('select','#chat-filter','any');
  ab('mouse','move','600','400');
  ab('click','#return-grid');
  for(const width of [1280,800,580,390,320]){
    ab('set','viewport',String(width),'720');await wait(200);
    check(ev("[...document.querySelectorAll('.grid-toolbar > *, .grid-filters > *')].every(n=>{const r=n.getBoundingClientRect();return r.width===0||r.left>=0&&r.right<=innerWidth+.5})"),'Toolbar fits '+width+'px');
    ab('click','#grid-select');ab('click','[data-id=fixture-0] .grid-open');ab('click','#grid-toggle-actions');await wait(100);
    check(ev("Boolean(document.querySelector('[data-action=grid-archive-selected]'))"),'Same menu provides archive at '+width+'px');
    ab('press','Escape');ab('click','#grid-selection-done');
  }
  ab('set','viewport','1280','800');await wait(200);
  mkdirSync('artifacts',{recursive:true});ab('screenshot','artifacts/chat-archive-grid.png');
  writeFileSync('artifacts/chat-archive-verification.json',JSON.stringify({checks},null,2));
  console.log(checks.length+' archive browser checks passed');
} finally { ab('close'); }
