import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { ChatStateQueue, archivePlan, runArchive, chatIds, chatStatus } from '../extension/chat-archive.js';
import { mergeLibrary, putValue, getImages, storeAsset, getAsset, storeChatStates, getValue } from '../extension/db.js';
const source = await readFile(new URL('../extension/page-bridge.js', import.meta.url), 'utf8');
async function bridge(responder) {
  const calls = [], context = { URL, TextEncoder, crypto: webcrypto, atob, AbortController, setTimeout, clearTimeout,
    location: { origin: 'https://chatgpt.com' } };
  context.window = { fetch: async (path, options = {}) => {
    if (String(path) === '/api/auth/session') return { ok: true, json: async () => ({ user: { id: 'test' }, accessToken: 'test' }) };
    calls.push({ path: new URL(path, context.location.origin).pathname, options });
    const response = await responder(calls.at(-1), calls.length);
    return { ok: response.status < 400, ...response, json: async () => response.body };
  } };
  vm.runInNewContext(source, context);
  const identity = await context.ImageLibrarySource.request('identity');
  return { calls, request: (command,args = {}) => context.ImageLibrarySource.request(command, { account: identity.result.id, ...args }) };
}
test('status reads are bounded, deduplicated and never infer unknown as false', async () => {
  const b = await bridge(() => ({ status: 200, body: [{ id:'c1',is_archived:false }] }));
  assert.equal((await b.request('chat-status',{ids:['c1','c1']})).result[0].archived,false);
  assert.equal(b.calls[0].path,'/backend-api/conversations/batch');
  assert.equal(b.calls[0].options.body,'{"conversation_ids":["c1"]}');
  assert.equal((await b.request('chat-status',{ids:Array(11).fill('c1')})).ok,false);
  assert.equal(b.calls.length,1);
  const invalid = await bridge(() => ({status:200,body:[{id:'c1'}]}));
  assert.equal((await invalid.request('chat-status',{ids:['c1']})).ok,false);
  assert.equal(chatStatus(), 'unknown'); assert.equal(chatStatus({archived:false,error:'failed'}),'unknown');
});
test('archive verifies before and after exact true-only PATCH and skips known archived chats',async()=>{
  const b=await bridge((call,n)=>({status:200,body:call.options.method==='PATCH'?{}:[{id:'c1',is_archived:n>1}]}));
  const r=await b.request('archive-chat',{id:'c1'});
  assert.equal(r.ok,true);assert.equal(r.result.state.archived,true);assert.equal(r.result.skipped,false);
  assert.deepEqual(b.calls.map(c=>c.options.method),['POST','PATCH','POST']);
  assert.equal(b.calls[1].path,'/backend-api/conversation/c1');
  assert.equal(b.calls[1].options.body,'{"is_archived":true}');
  const skip=await bridge(()=>({status:200,body:[{id:'c1',is_archived:true}]}));
  assert.equal((await skip.request('archive-chat',{id:'c1'})).result.skipped,true);
  assert.equal(skip.calls.length,1);
});
test('account mismatch, invalid IDs and unconfirmed writes cannot produce success',async()=>{
  const b=await bridge(c=>({status:200,body:c.options.method==='PATCH'?{}:[{id:'c1',is_archived:false}]}));
  assert.equal((await b.request('archive-chat',{id:'c1',account:'other'})).code,'ACCOUNT_CHANGED');
  assert.equal(b.calls.length,0);
  assert.equal((await b.request('archive-chat',{id:'../../danger'})).ok,false);
  assert.equal(b.calls.length,0);
  assert.equal((await b.request('archive-chat',{id:'c1'})).code,'UNCERTAIN');
  const missing=await bridge(()=>({status:200,body:[]}));
  assert.equal((await missing.request('archive-chat',{id:'c1'})).code,'NOT_FOUND');assert.equal(missing.calls.length,1);
});
test('a lost PATCH reply can be retried without a second write',async()=>{
  let archived=false,writes=0;
  const b=await bridge(call=>{
    if(call.options.method==='PATCH'){archived=true;writes++;throw new Error('lost reply');}
    return {status:200,body:[{id:'c1',is_archived:archived}]};
  });
  assert.equal((await b.request('archive-chat',{id:'c1'})).ok,false);
  assert.equal((await b.request('archive-chat',{id:'c1'})).result.skipped,true);assert.equal(writes,1);
});
test('batch deduplicates chats, stops at uncertainty, and leaves failures and unprocessed chats',async()=>{
  const plan=archivePlan([{id:'1',conversationId:'c'},{id:'2',conversationId:'c'},{id:'3'}]);
  assert.deepEqual([...plan.conversations.keys()],['c']);assert.deepEqual(plan.missing,['3']);
  const r=await runArchive({ids:['a','a','b','c'],stopped:()=>false,apply:async id=>{
    if(id==='b')throw Object.assign(new Error('rate'),{code:'RATE_LIMIT'});
    return {state:{archived:true},skipped:true};
  }});
  assert.deepEqual(r.skipped,['a']);assert.deepEqual(r.failed.map(x=>x.id),['b']);assert.deepEqual(r.pending,['c']);
  let stopped=false;
  const stop=await runArchive({ids:['a','b'],stopped:()=>stopped,apply:async()=>({state:{archived:true}}),progress:()=>{stopped=true;}});
  assert.deepEqual(stop.succeeded,['a']);assert.deepEqual(stop.pending,['b']);
  assert.throws(()=>chatIds(['bad/path']));assert.throws(()=>chatIds(Array(11).fill('a')));
});
test('visible chats overtake background work, in-flight requests merge, and reset rejects stale results',async()=>{
  let resolve, changed=0, now=1000;
  const q=new ChatStateQueue({now:()=>now,delay:100000,changed:()=>changed++,read:ids=>new Promise(r=>{resolve=r;})});
  q.enqueue(Array.from({length:20},(_,i)=>'b'+i));q.enqueue(['visible'],-1);
  clearTimeout(q.timer);q.timer=null;const run=q.drain();
  assert.equal([...q.inFlight][0],'visible');assert.equal(q.inFlight.size,10);
  q.enqueue(['visible'],-1);assert.ok(!q.pending.has('visible'));
  q.reset();resolve([{id:'visible',archived:true,checkedAt:now}]);await run;
  assert.equal(changed,0);assert.equal(q.states.size,0);
  q.set([{id:'a',archived:true,checkedAt:300}]);q.set([{id:'a',archived:false,checkedAt:200}]);
  assert.equal(q.states.get('a').archived,true);q.reset();
});
test('rate limits preserve last known state and pause metadata requests',async()=>{
  let now=1000000;
  const q=new ChatStateQueue({now:()=>now,delay:100000,changed:()=>{},read:async()=>{throw Object.assign(new Error('rate'),{code:'RATE_LIMIT'});}});
  q.reset([{id:'a',archived:true,checkedAt:1}]);q.enqueue(['a']);clearTimeout(q.timer);q.timer=null;await q.drain();
  assert.equal(q.states.get('a').archived,true);assert.equal(chatStatus(q.states.get('a')),'unknown');
  assert.equal(q.blockedUntil,now+300000);q.enqueue(['b']);assert.equal(q.timer,null);q.reset();
});
test('reconciliation preserves archived-chat pictures and bytes with account isolation',async()=>{
  await mergeLibrary('archive-a',[{id:'a',conversationId:'c'},{id:'b',conversationId:'other'}]);
  await mergeLibrary('archive-b',[{id:'a',conversationId:'c'}]);
  await putValue('conversations',{key:'archive-a:c',account:'archive-a',id:'c',archived:true,checkedAt:1});
  await storeAsset('archive-a','a','original',new Blob(['unchanged']));
  await mergeLibrary('archive-a',[],true);await mergeLibrary('archive-b',[],true);
  const rows=await getImages('archive-a');
  assert.equal(rows.find(x=>x.id==='a').deleted,false);assert.equal(rows.find(x=>x.id==='b').deleted,true);
  assert.equal((await getImages('archive-b'))[0].deleted,true);assert.equal(await(await getAsset('archive-a','a')).text(),'unchanged');
  await putValue('conversations',{key:'archive-a:c',account:'archive-a',id:'c',archived:false,checkedAt:2});
  await mergeLibrary('archive-a',[],true);assert.equal((await getImages('archive-a')).find(x=>x.id==='a').deleted,true);
});
test('verified archive state restores missing indexed pictures atomically and stale reads cannot undo it',async()=>{
  await mergeLibrary('chat-updates',[{id:'a',conversationId:'c'}]);
  await mergeLibrary('chat-updates',[],true);
  assert.equal((await getImages('chat-updates'))[0].deleted,true);
  await storeChatStates('chat-updates',[{id:'c',archived:true,checkedAt:200}]);
  assert.equal((await getImages('chat-updates'))[0].deleted,false);
  const rows=await storeChatStates('chat-updates',[{id:'c',archived:false,checkedAt:100}]);
  assert.equal(rows[0].archived,true);
  assert.equal((await getValue('conversations','chat-updates:c')).checkedAt,200);
  await assert.rejects(storeChatStates('chat-updates',[{id:'c',archived:'true',checkedAt:300}]));
});
