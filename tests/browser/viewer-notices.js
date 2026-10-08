// Local fixture validates clipboard fallback without touching system clipboard.
(async()=>{
 const $=id=>document.getElementById(id), wait=ms=>new Promise(r=>setTimeout(r,ms));
 if(location.hostname!=='127.0.0.1'||!location.search.includes('preview=1')) throw Error('Local preview only');
 const original=Object.getOwnPropertyDescriptor(navigator,'clipboard');
 const hadSidebar=document.body.classList.contains('sidebar-hidden');
 if(hadSidebar) $('toggle-sidebar').click();
 const image=$('main-image').style.transform;
 try {
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
   $('toggle-more').click(); await wait(100);
   document.querySelector('[data-action="copy-prompt"]').click();
   for(let i=0;i<200&&!$('prompt-dialog').open;i++) await wait(20);
   if(!$('prompt-dialog').open||$('prompt-dialog').matches(':modal')||!$('prompt-dialog').classList.contains('viewer-dialog')) throw Error('Prompt fallback must be compact nonmodal content');
   if(!/测试图片/.test($('prompt-text').value)) throw Error('Prompt text missing');
   const toast=$('status').getBoundingClientRect();
   if($('status').hidden||!$('status-text').textContent||getComputedStyle($('status-text')).clipPath==='inset(50%)') throw Error('Toast must show text directly');
   if(Math.abs(toast.left+toast.width/2-innerWidth/2)>1||toast.width>420) throw Error('Toast must remain narrow and centered');
   if($('main-image').style.transform!==image) throw Error('Prompt fallback moved picture');
   $('prompt-dialog').close();
   return JSON.stringify({manualPromptReadable:true,toastDirect:true,toastCentered:true,imageStable:true});
 } finally {if(hadSidebar) $('toggle-sidebar').click();if(original)Object.defineProperty(navigator,'clipboard',original);else delete navigator.clipboard;}
})()
