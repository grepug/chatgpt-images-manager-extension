(async()=>{
const $=id=>document.getElementById(id), wait=ms=>new Promise(r=>setTimeout(r,ms));
if(location.hostname!=='127.0.0.1'||!location.search.includes('preview=1'))throw Error('Local preview only');
const original=Object.getOwnPropertyDescriptor(navigator,'clipboard');
try{
Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
$('toggle-more').click(); $('copy-prompt').click();
for(let i=0;i<200&&!$('prompt-dialog').open;i++)await wait(20);
if(!$('prompt-dialog').open||$('prompt-dialog').parentElement!==$('viewer-panel')||$('prompt-dialog').matches(':modal'))throw Error('Prompt must use independent panel');
await wait(150);
const outside=id=>{const a=$('viewport').getBoundingClientRect(),b=$(id).getBoundingClientRect();if(Math.min(a.right,b.right)>Math.max(a.left,b.left)+.5&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+.5)throw Error(id+' covers picture');};
outside('prompt-dialog'); outside('status');
$('notice-toggle').click(); await wait(150); outside('notice-panel');
if(!$('notice-text').textContent.includes('手动复制'))throw Error('Full notification missing');
$('notice-panel').querySelector('button').click(); await wait(100);
if(!$('viewer-panel').hidden)throw Error('Notice close must restore rail');
return JSON.stringify({manualPromptOutsideImage:true,toastOutsideImage:true,fullNoticeReadable:true});
}finally{if(original)Object.defineProperty(navigator,'clipboard',original);else delete navigator.clipboard;}
})()
