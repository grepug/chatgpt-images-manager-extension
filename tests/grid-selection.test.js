import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GridSelection, runBulk, bulkRequest } from '../extension/grid-selection.js';
import { mergeLibrary, setBulkFlags, setFavorite, getImages, getHiddenIds, storeAsset, getAsset, getValue, database } from '../extension/db.js';

test('selection includes unmounted items, ranges follow source order and refresh prunes scope', () => {
  const s = new GridSelection(), images = Array.from({length:30000},(_,i)=>({id:String(i)}));
  s.reconcile(images); s.enter(); s.toggle('100'); s.toggle('1000',true);
  assert.equal(s.ids.size,901); assert.ok(s.ids.has('500'));
  s.all(); assert.equal(s.ids.size,30000);
  s.locked=true; s.clear(); s.exit(); s.toggle('0'); assert.equal(s.ids.size,30000); assert.equal(s.active,true);
  s.complete(['0']); assert.equal(s.ids.size,29999);
  s.locked=false; s.reconcile([{id:'1'},{id:'new'}]); assert.deepEqual([...s.ids],['1']);
  s.exit(); assert.equal(s.active,false); assert.equal(s.ids.size,0); assert.equal(s.anchor,null);
});
test('batch applies explicit values, reports partial results and retains stopped work', async () => {
  let stop=false, calls=[], progress=[];
  const result=await runBulk({ids:['a','b','c','d','e'],size:2,stopped:()=>stop,
    apply:async ids=>{calls.push(ids);return {succeeded:[ids[0]],failed:[{id:ids[1],error:'failed'}]};},
    progress:r=>{progress.push(r.succeeded.length);stop=true;}});
  assert.deepEqual(calls,[['a','b']]); assert.deepEqual(result.succeeded,['a']);
  assert.deepEqual(result.failed,[{id:'b',error:'failed'}]); assert.deepEqual(result.pending,['c','d','e']);
  assert.equal(result.stopped,true); assert.deepEqual(progress,[1]);
});
test('storage errors stop future chunks and unconfirmed IDs never count as success',async()=>{
  const failed=await runBulk({ids:['a','b','c'],size:2,apply:async()=>{throw new Error('disk full');}});
  assert.deepEqual(failed.succeeded,[]);assert.equal(failed.failed.length,2);assert.deepEqual(failed.pending,['c']);
  const uncertain=await runBulk({ids:['a'],apply:async()=>({succeeded:[]})});
  assert.equal(uncertain.failed[0].id,'a');
  await assert.rejects(runBulk({ids:['a'],size:0,apply:()=>{}}));
});
test('bulk protocol validates before writes and deduplicates bounded requests',()=>{
  assert.deepEqual(bulkRequest('a',['x','x'],'favorite',true).ids,['x']);
  for(const args of [['a',[],'hidden',true],['', ['x'],'hidden',true],['a',Array(101).fill('x'),'hidden',true],['a',['x'],'favorite','true'],['a',['x'],'delete',true]]) assert.throws(()=>bulkRequest(...args));
});
test('bulk hidden is account scoped, ID only, and does not touch original bytes',async()=>{
  await mergeLibrary('bulk-a',[{id:'a'},{id:'b'}]);await mergeLibrary('bulk-b',[{id:'a'}]);
  await storeAsset('bulk-a','a','original',new Blob(['retained']));
  const result=await setBulkFlags('bulk-a',['a','b','missing','a'],'hidden',true);
  assert.deepEqual(result.succeeded,['a','b']); assert.deepEqual(result.failed,[{id:'missing',error:'图片不存在'}]);
  assert.deepEqual([...await getHiddenIds('bulk-a')],['a','b']);assert.equal((await getHiddenIds('bulk-b')).size,0);
  assert.deepEqual(await getValue('hidden','bulk-a'),{key:'bulk-a',ids:['a','b']});
  await setBulkFlags('bulk-a',['a','b'],'hidden',false);
  assert.equal((await getHiddenIds('bulk-a')).size,0);assert.equal(await (await getAsset('bulk-a','a')).text(),'retained');
});
test('bulk favorite is idempotent and cancellation unpins without deleting originals',async()=>{
  await mergeLibrary('bulk-fav',[{id:'a'},{id:'b'}]);await storeAsset('bulk-fav','a','original',new Blob(['keep']));
  await setFavorite('bulk-fav','a',true);
  for(let i=0;i<2;i++) await setBulkFlags('bulk-fav',['a','b'],'favorite',true);
  const images=await getImages('bulk-fav');assert.ok(images.every(i=>i.favorite));
  assert.equal(images.find(i=>i.id==='a').saved,true);assert.equal(images.find(i=>i.id==='b').saved,false);
  await setBulkFlags('bulk-fav',['a','b'],'favorite',false);
  assert.ok((await getImages('bulk-fav')).every(i=>!i.favorite));
  assert.equal((await getValue('assetInfo','bulk-fav:a:original')).pinned,false);
  assert.equal(await (await getAsset('bulk-fav','a')).text(),'keep');
});
test('transaction failure rolls back earlier items in the same chunk',async()=>{
  await mergeLibrary('bulk-rollback',[{id:'a'},{id:'b'}]);
  const db=await database(), original=db.transaction.bind(db);
  db.transaction=(stores,mode,...args)=>{
    const tx=original(stores,mode,...args);
    if(mode==='readwrite'&&stores.includes('hidden')){
      const objectStore=tx.objectStore.bind(tx);
      tx.objectStore=name=>{
        const store=objectStore(name);
        if(name==='images') {const put=store.put.bind(store);store.put=row=>{if(row.id==='b')throw new Error('injected quota');return put(row);};}
        return store;
      };
    }
    return tx;
  };
  try {await assert.rejects(setBulkFlags('bulk-rollback',['a','b'],'favorite',true),/injected quota/);}
  finally {db.transaction=original;}
  assert.ok((await getImages('bulk-rollback')).every(i=>!i.favorite));
});
