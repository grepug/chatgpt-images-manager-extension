import test from 'node:test';
import assert from 'node:assert/strict';
import { openEditWindow } from '../extension/edit-window.js';

function browser(result) {
  const calls = [];
  return { calls, windows: { create: async args => { calls.push(args); return { id: 8, tabs: [{ id: 12 }] }; } },
    tabs: { get: async () => ({ url: 'https://chatgpt.com/images', status: 'complete' }) },
    scripting: { executeScript: async args => { calls.push(args); return [{ frameId: 0, result }]; } } };
}
test('Describe edits opens a separate native window and passes exact image identity once', async () => {
  const extension = browser({ ok: true, submitted: true });
  const input = { account: 'account', image: { fileId: 'file-image', conversationId: 'source', messageId: 'message' }, prompt: 'Edit request', jobId: 'job' };
  assert.equal((await openEditWindow(extension, input)).submitted, true);
  assert.deepEqual(extension.calls[0], { url: 'https://chatgpt.com/images', type: 'normal', focused: true });
  assert.equal(extension.calls[1].world, 'MAIN');
  assert.deepEqual(extension.calls[1].target, { tabId: 12 });
  assert.deepEqual(extension.calls[1].args, [input]);
  assert.equal(extension.calls.length, 2);
});
test('An uncertain dispatch is surfaced and never automatically resubmitted', async () => {
  const extension = browser({ ok: false, dispatched: true, error: 'Check the new window' });
  await assert.rejects(openEditWindow(extension, {}), /Check the new window/);
  assert.equal(extension.calls.length, 2);
});
test('A window navigated away from ChatGPT receives no script or edit', async () => {
  const extension = browser({ ok: true });
  extension.tabs.get = async () => ({ url: 'https://example.com', status: 'complete' });
  await assert.rejects(openEditWindow(extension, {}), /已离开/);
  assert.equal(extension.calls.length, 1);
});
test('A dry run is passed through without changing to a submission', async () => {
  const extension = browser({ ok: true, verified: true });
  assert.equal((await openEditWindow(extension, { dryRun: true })).verified, true);
  assert.equal(extension.calls[1].args[0].dryRun, true);
});
