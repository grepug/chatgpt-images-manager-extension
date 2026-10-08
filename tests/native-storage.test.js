import test from 'node:test';
import assert from 'node:assert/strict';
let call;
globalThis.browser = { runtime: { sendNativeMessage: async (application,message) => {
  assert.equal(application,'local.chatgpt.ChatGPT-Images-Manager'); return call(message);
} } };
const {nativeRead,nativeWrite,nativeRequest,nativeVerify,nativeReceipt,nativeThumbnail} = await import('../extension/native-storage.js');
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
test('legacy IndexedDB undefined fields are normalized before Safari native messaging',async()=>{
  call=async msg=>{assert.equal(Object.hasOwn(msg.rows[0],'width'),false);assert.deepEqual(msg.rows[0].view,{value:null});return {ok:true,result:true};};
  await nativeRequest('batch',{rows:[{key:'a',width:undefined,view:{missing:undefined,value:null}}]});
});
test('originals transfer in bounded ordered chunks, commit only with an exact digest and read intact',async()=>{
  const bytes = new Uint8Array(800000); bytes.fill(51); let saved, chunks=[], ops=[];
  call = async msg => {
    assert.equal(msg.probe,true); ops.push(msg.op);
    if(msg.op==='asset-info') return {ok:true,result:saved || null};
    if(msg.op==='asset-begin') return {ok:true,result:{token:'test-token'}};
    if(msg.op==='asset-chunk') {
      const data=Uint8Array.from(Buffer.from(msg.data,'base64')); assert.ok(data.length<=262144);
      assert.equal(msg.offset,chunks.reduce((n,x)=>n+x.length,0)); chunks.push(data); return {ok:true,result:true};
    }
    if(msg.op==='asset-commit') {
      assert.equal(msg.digest,await digest(bytes)); saved={...msg.info,digest:msg.digest};return {ok:true,result:saved};
    }
    if(msg.op==='asset-read') return {ok:true,result:{...saved,data:Buffer.from(bytes.slice(msg.offset,msg.offset+msg.length)).toString('base64'),offset:msg.offset,size:bytes.length}};
  };
  await nativeWrite({key:'a:id:original'},new Blob([bytes],{type:'image/png'}),{probe:true});
  assert.equal(ops.filter(op=>op==='asset-chunk').length,4); assert.equal(ops.at(-1),'asset-commit');
  const beforeRead=ops.length;
  const blob=await nativeRead('a:id:original',{probe:true}); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
  assert.deepEqual(ops.slice(beforeRead),['asset-read']);
  const before=ops.length; await nativeWrite({key:'a:id:original'},blob,{probe:true});assert.deepEqual(ops.slice(before),['asset-info']);
});
test('truncated and corrupt native reads never report a complete image',async()=>{
  const bytes=new Uint8Array([1,2,3]); const info={size:3,digest:await digest(bytes),mime:'image/png'};
  call = async msg=>({ok:true,result:{...info,data:'',offset:msg.offset}});
  await assert.rejects(nativeRead('a:id:original'),/不完整/);
  call = async msg=>({ok:true,result:{...info,data:'AQIE',offset:msg.offset}});
  await assert.rejects(nativeRead('a:id:original'),/校验失败/);
});
test('large original frames remain ordered, bounded and tied to the same digest',async()=>{
  const bytes=new Uint8Array(5*1024*1024+9); bytes.fill(61);
  const info={size:bytes.length,digest:await digest(bytes),mime:'image/png'}, offsets=[];
  call=async msg=>{assert.equal(msg.op,'asset-read');assert.equal(msg.length,4*1024*1024);offsets.push(msg.offset);return {ok:true,result:{...info,offset:msg.offset,data:Buffer.from(bytes.subarray(msg.offset,msg.offset+msg.length)).toString('base64')}};};
  assert.deepEqual(new Uint8Array(await (await nativeRead('a:large:original')).arrayBuffer()),bytes);
  assert.deepEqual(offsets,[0,4*1024*1024]);
  call=async msg=>({ok:true,result:{...info,digest:msg.offset?'0'.repeat(64):info.digest,offset:msg.offset,data:Buffer.from(bytes.subarray(msg.offset,msg.offset+msg.length)).toString('base64')}});
  await assert.rejects(nativeRead('a:large:original'),/不完整/);
  call=async()=>({ok:true,result:{...info,size:2,offset:0,data:'AQID'}});
  await assert.rejects(nativeRead('a:oversized:original'),/不完整/);
  call=async()=>({ok:true,result:null});assert.equal(await nativeRead('a:missing:original'),null);
});
test('quota failures preserve their code and do not attempt any writes',async()=>{
  const ops=[];call=async msg=>{ops.push(msg.op);return msg.op==='asset-info'?{ok:true,result:null}:{ok:false,code:'QUOTA',error:'full'};};
  await assert.rejects(nativeWrite({key:'a:id:original'},new Blob(['image'])),e=>e.code==='QUOTA');
  assert.deepEqual(ops,['asset-info','asset-begin']);
});
test('a failed commit aborts only its new staging file and leaves existing storage alone',async()=>{
  const ops=[];call=async msg=>{ops.push(msg.op);if(msg.op==='asset-info')return {ok:true,result:null};if(msg.op==='asset-begin')return {ok:true,result:{token:'new-staging'}};if(msg.op==='asset-commit')return {ok:false,error:'integrity'};return {ok:true,result:true};};
  await assert.rejects(nativeWrite({key:'a:id:original'},new Blob(['image'])),/integrity/);
  assert.equal(ops.at(-1),'asset-abort');
});
test('large migrations verify in bounded pages and receipts cannot switch profiles midstream',async()=>{
  const cursors=[];call=async msg=>{cursors.push(msg.after);return {ok:true,result:msg.after?{verified:3,after:null}:{verified:16,after:'next'}};};
  assert.deepEqual(await nativeVerify(),{verified:19});assert.deepEqual(cursors,[null,'next']);
  call=async msg=>({ok:true,result:{schema:1,profileHash:msg.after?'different':'profile',originals:[],after:msg.after?null:'next'}});
  await assert.rejects(nativeReceipt(),/不完整/);
});
test('native thumbnails use bounded verified reads without transferring the original',async()=>{
  const bytes=new Uint8Array([4,5,6]), ops=[];
  const info={token:'cache-token',size:3,digest:await digest(bytes),mime:'image/jpeg',width:898,height:1234,sourceWidth:1024,sourceHeight:1408,thumbnailVersion:2};
  call=async msg=>{ops.push(msg.op);return {ok:true,result:msg.op==='thumbnail-info'?info:{data:'BAUG',offset:0,size:3}};};
  const thumbnail=await nativeThumbnail('account:picture:original',{width:408,height:561,dpr:2});
  assert.deepEqual(new Uint8Array(await thumbnail.blob.arrayBuffer()),bytes);
  assert.equal(thumbnail.width,898);assert.deepEqual(ops,['thumbnail-info','thumbnail-read']);
});
