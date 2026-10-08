// Explicitly synthetic: never reads or migrates the user's library.
(async () => {
  if (!location.protocol.startsWith('safari-web-extension')) throw new Error('Safari extension only');
  const { nativeRequest, nativeWrite, nativeRead } = await import('./native-storage.js');
  const ping = await nativeRequest('ping', { probe:true });
  if (!ping.persistent || !ping.appProof?.app) throw new Error('App and native extension did not share the container');
  const results = [];
  for (const size of [65536, 2097152, 8388608]) {
    const bytes = new Uint8Array(size); for (let n = 0; n < size; n++) bytes[n] = n % 251;
    const blob = new Blob([bytes], { type:'application/octet-stream' }), key = `probe-account:fixture-${size}:original`;
    const writeStart = performance.now();
    const info = await nativeWrite({key,account:'probe-account',id:`fixture-${size}`,kind:'original',pinned:false},blob,{probe:true});
    const readStart = performance.now(), restored = await nativeRead(key,{probe:true});
    const end = performance.now(), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',await restored.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if (restored.size !== size || digest !== info.digest) throw new Error('Byte integrity failed');
    results.push({bytes:size,writeMs:Math.round(readStart-writeStart),readMs:Math.round(end-readStart),verified:true});
  }
  await nativeRequest('batch',{store:'hidden',rows:[{key:'probe-account',ids:['hidden-fixture']}],probe:true});
  const hidden = await nativeRequest('get',{store:'hidden',key:'probe-account',probe:true});
  if (hidden.ids[0] !== 'hidden-fixture') throw new Error('Metadata did not persist');
  const verified = await nativeRequest('verify-assets',{probe:true});
  return {sharedContainer:true,results,verified:verified.verified,appReadNative:ping.appProof.nativeRead};
})()
