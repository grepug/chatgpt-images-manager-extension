import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { nativeDescribeEdit } from '../extension/native-edit.js';

async function fixture({ legacy = false, latest = false, renamed = false, ambiguous = false, unsupported = false, targetId = legacy ? 'local-edit' : 'local-chatgpt:11111111-2222-4333-8444-555555555555', reject = false, modelReady = true } = {}) {
  const calls = [], root = {}, saved = {}, localIds = {}, state = { ids: [], saved: false };
  const scope = { scope: root,
    get(atom) {
      if (atom === localIds) return state.ids;
      if (atom === saved) return state.saved;
      return { accountId: 'workspace', userId: 'user', logged: true, modelKey: 'key', model: modelReady ? { slug: 'image-model' } : null }[atom];
    },
    set(atom, id, value) {
      if (atom === 'conversation') { calls.push({ op: 'create', id }); state.ids.push(id); }
      else if (atom === localIds) { state.ids = id(state.ids); calls.push({ op: 'cleanup' }); }
    }
  };
  function create(e) {
    const id = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : targetId;
    return e.get('conversation', id) || e.set('conversation', id, {}), id;
  }
  // Same old export key, different three-argument operation after the site update.
  function shifted(e, id, operation) { calls.push({ op: 'wrong-export' }); return operation; }
  const native = latest ? { hb: shifted, ib: create, j: saved, k: localIds } : legacy ? { ib: create, k: saved, l: localIds } : { hb: create, ib: shifted, j: saved, k: localIds };
  if (unsupported) native[legacy ? 'ib' : 'hb'] = shifted;
  if (renamed) { delete native.hb; delete native.ib; native.Xb = create; native.Yb = create; }
  if (ambiguous) native.Zb = function other(e) {
    const id = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : targetId;
    return e.get('conversation', id) || e.set('conversation', id, {}), id;
  };
  const image = { src: 'file-image', status: 'completed' };
  const submit = async (e, args) => {
    const { sourceConversationId, isSubmissionCurrent } = args;
    assert.equal(e, scope); assert.equal(sourceConversationId, 'source'); assert.equal(isSubmissionCurrent(), true);
    args.beforeRequest(); calls.push({ op: 'submit', args });
    if (reject) throw Error('completion interrupted');
    state.saved = true; return true;
  };
  const modules = {
    OW: { a: root }, LPf: { d: 'accountId', i: 'userId', m: 'logged' }, no: native, ezq: { d: 'modelKey' },
    Ow: { s: 'model', P: (e, id, model) => { assert.equal(e, scope); calls.push({ op: 'model', id, slug: model.slug }); } },
    RW7: { d: submit }, jA: { c: id => `/c/${id}` }, iq: { c: value => value }, ccw: { b: () => [image] },
    Kwu: { Request: { safeGet: async () => { calls.push({ op: 'conversation' }); return { mapping: { result: { message: { id: 'message' } } } }; } } }
  };
  const require = id => { assert.ok(modules[id], id); return modules[id]; };
  require.m = { RW7: function prepareChatGptImageEditOperation() {}, ccw: () => {}, ezq: () => {}, no: () => {} };
  const window = { __reactRouterManifest: { entry: { imports: ['/cdn/assets/runtime.js'] } },
    __reactRouterDataRouter: { navigate: async path => calls.push({ op: 'navigate', path }) } };
  const element = { __reactFiber$test: { memoizedState: { memoizedState: { current: scope } } } };
  // Mock only module loading; execute the complete shipped injection function.
  const source = nativeDescribeEdit.toString().replace('await import(runtimePath)', 'await loadRuntime(runtimePath)');
  const run = vm.runInNewContext(`(${source})`, { window, location: { origin: 'https://chatgpt.com' },
    document: { querySelectorAll: () => [element] }, crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout,
    loadRuntime: async path => { assert.equal(path, '/cdn/assets/runtime.js'); return { __webpack_require__: require }; }
  });
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('user:workspace'));
  const input = { account: Buffer.from(digest).toString('hex'), image: { fileId: 'file-image', conversationId: 'source', messageId: 'message' }, prompt: 'Add a star', jobId: 'job' };
  return { run, input, calls, state, image };
}

test('current website exports create a valid new conversation and submit the exact image once', async () => {
  const { run, input, calls, image } = await fixture();
  assert.equal((await run(input)).submitted, true);
  assert.deepEqual(calls.map(call => call.op), ['conversation', 'create', 'model', 'submit', 'navigate']);
  const { args } = calls.find(call => call.op === 'submit');
  assert.equal(args.conversationId, 'local-chatgpt:11111111-2222-4333-8444-555555555555'); assert.equal(args.image, image); assert.equal(args.request.prompt, input.prompt);
  assert.equal(args.request.attribution.editEntryPoint, 'images');
  assert.equal(calls.at(-1).path, `/c/${args.conversationId}`);
  assert.equal((await run(input)).submitted, true); assert.equal(calls.filter(call => call.op === 'submit').length, 1);
});
test('previous website exports remain supported with their matching state atoms', async () => {
  const { run, input, calls } = await fixture({ legacy: true });
  assert.equal((await run(input)).submitted, true);
  assert.equal(calls.some(call => call.op === 'wrong-export'), false);
});
test('updated website constructor with unchanged state exports is submission-ready', async () => {
  const { run, input, calls } = await fixture({ latest: true });
  const result = await run({ ...input, dryRun: true });
  assert.equal(result.submissionReady, true, result.error);
  assert.deepEqual(calls.map(call => call.op), ['conversation']);
});
test('constructor export renaming and duplicate aliases do not break submission', async () => {
  const { run, input, calls } = await fixture({ renamed: true });
  assert.equal((await run(input)).submitted, true);
  assert.equal(calls.filter(call => call.op === 'create').length, 1);
});
test('ambiguous constructor contracts fail before creating or submitting anything', async () => {
  const { run, input, calls } = await fixture({ ambiguous: true });
  const result = await run(input);
  assert.equal(result.dispatched, false);
  assert.match(result.error, /新会话接口已更新/);
  assert.deepEqual(calls, []);
});
test('updated website exports submit once and clean only their own local conversation on failure', async () => {
  const successful = await fixture({ latest: true });
  assert.equal((await successful.run(successful.input)).submitted, true);
  assert.deepEqual(successful.calls.map(call => call.op), ['conversation', 'create', 'model', 'submit', 'navigate']);
  assert.equal(successful.calls.some(call => call.op === 'wrong-export'), false);
  const failed = await fixture({ latest: true, reject: true });
  failed.state.ids.push('existing-chat');
  const result = await failed.run(failed.input);
  assert.equal(result.dispatched, true);
  assert.deepEqual(failed.state.ids, ['existing-chat']);
  await failed.run(failed.input);
  assert.equal(failed.calls.filter(call => call.op === 'submit').length, 1);
});
test('dry run validates submission bindings but creates no conversation or edit', async () => {
  const { run, input, calls } = await fixture();
  const result = await run({ ...input, dryRun: true });
  assert.equal(result.verified, true); assert.equal(result.submissionReady, true);
  assert.deepEqual(calls.map(call => call.op), ['conversation']);
});
test('changed constructor exports fail before mutable operations even during a dry run', async () => {
  const { run, input, calls } = await fixture({ unsupported: true });
  const result = await run({ ...input, dryRun: true });
  assert.equal(result.ok, false); assert.equal(result.dispatched, false); assert.match(result.error, /新会话接口已更新/);
  assert.deepEqual(calls, []);
});
test('invalid new conversation IDs never reach model selection or completion', async () => {
  const { run, input, calls } = await fixture({ targetId: null });
  const result = await run(input);
  assert.equal(result.dispatched, false); assert.match(result.error, /有效的新会话/);
  assert.equal(calls.some(call => ['model', 'submit', 'navigate'].includes(call.op)), false);
});
test('uncertain completion is not retried and cleans only the matching new local conversation', async () => {
  const { run, input, calls, state } = await fixture({ reject: true });
  state.ids.push('existing-chat');
  const result = await run(input);
  assert.equal(result.ok, false); assert.equal(result.dispatched, true); assert.match(result.error, /检查新窗口/);
  assert.deepEqual(state.ids, ['existing-chat']);
  await run(input); assert.equal(calls.filter(call => call.op === 'submit').length, 1);
});
test('an unhydrated image model waits without creating a conversation', async () => {
  const { run, input, calls } = await fixture({ modelReady: false });
  assert.equal((await run(input)).ready, false); assert.deepEqual(calls, []);
});
