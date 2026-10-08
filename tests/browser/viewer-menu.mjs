import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
const session=process.env.COMPONENT_TEST_SESSION || 'viewer-menu-integration';
const ab=(...args)=>execFileSync('rtk',['proxy','agent-browser','--session',session,...args],{encoding:'utf8',timeout:30000});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ev(code) {const file='/tmp/component-query.js';writeFileSync(file,code);return JSON.parse(execFileSync('rtk',['proxy','agent-browser','--session',session,'eval','--stdin'],{input:readFileSync(file),encoding:'utf8',timeout:30000}));}
const q=()=>ev(`(() => {
 const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
 return {size:[innerWidth,innerHeight],title:document.getElementById('image-title').textContent,
 idle:document.body.classList.contains('controls-idle'),error:document.getElementById('image-error').hidden ? null : document.getElementById('image-error-text').textContent,
 loaded:!document.getElementById('main-image').hidden,focus:document.activeElement.dataset.branch||document.activeElement.dataset.action||document.activeElement.id,
 image:rect(document.getElementById('main-image')),cards:[...document.querySelectorAll('.component-menu')].map(n=>({depth:n.dataset.depth,form:n.dataset.form,side:n.dataset.side,rect:rect(n),scroll:n.scrollTop})),
 draft:document.getElementById('edit-prompt').value,editor:!document.getElementById('edit-panel').hidden,
 opacity:getComputedStyle(document.querySelector('.action-group')).opacity,
 branches:[...document.querySelectorAll('[data-branch]')].filter(n=>n.getAttribute('aria-expanded')==='true').map(n=>n.dataset.branch),
 toast:!document.getElementById('status').hidden};
})()`);
mkdirSync('artifacts',{recursive:true});
let checks=[];
function check(value,label) {if(!value) throw Error(label+'\n'+JSON.stringify(q(),null,2));checks.push(label);}
const move=(x,y)=>ab('mouse','move',String(Math.round(x)),String(Math.round(y)));
async function more() {move(600,400);ab('click','#toggle-more');await wait(80);}
async function hover(branch) {
  const target=ev(`(() => {const r=document.querySelector('[data-branch="${branch}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const start=ev('window.componentTestPointer || {x:600,y:400}');
  for(let step=1;step<=8;step++) {move(start.x+(target.x-start.x)*step/8,start.y+(target.y-start.y)*step/8);await wait(12);}
  await wait(150);
}
const stable=(a,b)=>Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&Math.abs(a.w-b.w)<1&&Math.abs(a.h-b.h)<1;
ab('set','viewport','1280','800');ab('open','http://127.0.0.1:4173/library.html?preview=1');ab('tab','t1');
for (let i=0;i<50&&!ev('Boolean(document.querySelector("[data-id=fixture-3] .grid-open"))');i++) await wait(200);
if(!ev("document.body.classList.contains('grid-layout')")) ev("document.getElementById('return-grid').click();true");
ab('click','[data-id=fixture-3] .grid-open');
for (let i=0;i<30&&!q().loaded;i++) await wait(200);
check(q().loaded&&!q().error,'Image loaded without errors');
ev("document.addEventListener('pointermove',event=>window.componentTestPointer={x:event.clientX,y:event.clientY});true");
await more();let root=q().cards[0].rect, image=q().image;
await hover('library');check(q().cards.length===2,'Hover opens library child');check(stable(root,q().cards[0].rect),'Parent anchor stays fixed');check(stable(image,q().image),'Picture stays fixed');
check(q().focus==='library','Hover opening keeps focus in ancestor');
let child=q().cards[1].rect;
move(root.x+8,root.bottom-18);move(root.x-2,root.bottom-14);await wait(90);check(q().cards.length===2,'Crossing gap retains submenu');
move(child.right-10,child.y+18);await wait(90);check(q().cards.length===2,'Entering child retains ancestor');
await hover('settings');check(q().cards.length===3,'Third level preserves both ancestors');check(stable(root,q().cards[0].rect),'Third level leaves root stationary');
check(ev("document.getElementById('settings-dialog').open"),'Settings content remains functional');
ab('focus','#cache-mode');await wait(60);check(q().cards.length===3,'Focus on form does not dismiss ancestors');
await wait(2100);check(q().idle&&q().cards.length===3,'Idle hides toolbar while active menus remain');
ab('press','Escape');await wait(100);check(q().cards.length===0,'Escape closes menu chain');
await more();await hover('details');check(q().cards.length===2,'Details submenu opens');await hover('library');check(q().branches.includes('library')&&!q().branches.includes('details'),'Hover switches sibling submenu');
ab('hover','[data-action="download"]');await wait(100);check(q().cards.length===1,'Hover leaf closes child');
ab('press','Escape');await more();ab('press','ArrowDown');let title=q().title;ab('press','End');ab('press','ArrowRight');await wait(100);check(q().cards.length===2&&q().title===title,'Keyboard opens child without image navigation');
ab('press','ArrowLeft');await wait(60);check(q().cards.length===1,'Keyboard returns to retained parent');ab('press','Escape');
move(607,404);ab('press','ArrowRight');await wait(180);check(q().idle,'Image arrow hides controls immediately');let after=q().title;await wait(300);check(q().title===after&&q().idle,'Image completion does not reveal controls');
ev("document.getElementById('status-text').textContent='直接显示的 Toast';document.getElementById('status').hidden=false;true");check(q().toast&&q().idle,'Toast stays visible without revealing controls');ab('press','0');check(q().idle,'Other keyboard does not reveal controls');
move(608,405);check(!q().idle,'Actual mouse movement reveals controls');
ab('hover','#favorite');ab('focus','#favorite');await wait(2300);check(q().idle&&q().opacity==='0','Stationary hovered focused button fades after two seconds');
move(609,406);ab('click','#toggle-edit');ab('fill','#edit-prompt','保留编辑草稿');const editTitle=q().title;ab('press','ArrowLeft');check(q().title===editTitle,'Text arrows do not change picture');await wait(2100);check(q().editor,'Draft input persists during idle');
ab('press','Escape');check(!q().editor&&q().draft==='保留编辑草稿','Closing editor preserves draft');
ab('set','viewport','390','720');await wait(150);move(190,400);ab('click','#toggle-more');await wait(80);await hover('library');await hover('settings');let narrow=q();
check(narrow.cards.length===3,'Narrow view keeps three levels');
check(narrow.cards.every(c=>c.rect.x>=0&&c.rect.right<=390.5&&c.rect.y>=0&&c.rect.bottom<=720.5),'Narrow stack stays within viewport');
check(narrow.cards.slice(1).every((c,i)=>c.rect.y>=narrow.cards[i].rect.bottom+4),'Narrow levels stack separately');
const ns=narrow.cards[0].scroll;ev("document.querySelectorAll('.component-menu')[2].scrollTop=100; true");check(q().cards[0].scroll===ns,'Child scroll does not scroll parent');
ev("document.querySelectorAll('.component-menu')[2].scrollTop=0; true");
ab('screenshot','artifacts/viewer-v0.8-narrow.png');
check(q().cards.length===3,'Narrow chain stays open after render');
ab('press','Escape');ab('set','viewport','1280','800');await wait(100);await more();await hover('library');await hover('settings');await wait(250);ab('screenshot','artifacts/viewer-v0.8-wide.png');
check(q().cards.length===3,'Wide chain stays open after render');
ab('press','Escape');await more();await hover('library');ab('hover','[data-branch="settings"]');await wait(350);check(q().cards.length===3,'Fast movement directly into child preserves ancestors');
move(320,520);ab('mouse','down');ab('mouse','up');await wait(80);check(q().cards.length===0,'Outside click dismisses menu chain');
for(let i=0;i<10;i++){ab('press',i%2?'ArrowLeft':'ArrowRight');await wait(40);check(q().idle,`Keyboard image switch ${i+1} keeps controls hidden`);}
move(610,408);ab('click','#toggle-zoom');await wait(100);check(q().cards.length===1,'Zoom dropdown also uses component');ab('click','[data-action="fit"]');await wait(80);check(q().cards.length===0,'Zoom action dismisses dropdown');
const errors=JSON.parse(ab('errors','--json')).data.errors;check(errors.length===0,'No uncaught page errors in fresh test session');
writeFileSync('artifacts/viewer-v0.8-verification.json',JSON.stringify({component:'@radix-ui/react-dropdown-menu@2.1.16',checks,at:new Date().toISOString()},null,2));
console.log(JSON.stringify({passed:checks.length,checks},null,2));
