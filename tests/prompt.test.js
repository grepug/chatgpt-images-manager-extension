import test from 'node:test';
import assert from 'node:assert/strict';
await import('../extension/adapter.js');
const { imagePrompt } = globalThis.ImageLibraryAdapter;
const user = (id, parent, parts) => ({ id, parent, message: { id, author: { role: 'user' }, content: { parts } } });
const generated = (id, parent, files) => ({ id, parent, message: { id, author: { role: 'assistant' }, content: { parts: files.map(file => ({ asset_pointer: `sediment://${file}` })) } } });

test('prompt follows the exact image branch and preserves full user text', () => {
  const text = `第一行\n${'完整原文'.repeat(200)}`;
  const mapping = { original: user('original', null, [text]), output: generated('output', 'original', ['file_exact']),
    alternate: user('alternate', null, ['另一个分支，不能复制']), other: generated('other', 'alternate', ['file_other']) };
  assert.equal(imagePrompt({ mapping, current_node: 'other' }, { id: 'file_exact', messageId: 'output' }).text, text);
});
test('edits copy their own instruction; regenerations and sibling images use their common request', () => {
  const mapping = { request: user('request', null, ['画一座山']), first: generated('first', 'request', ['file_first', 'file_second']),
    regenerated: generated('regenerated', 'request', ['file_regenerated']), edit: user('edit', 'first', ['加一只猫']),
    tool: { id: 'tool', parent: 'edit', message: { author: { role: 'assistant' }, content: { parts: ['working'] } } }, edited: generated('edited', 'tool', ['file_edited']) };
  for (const id of ['file_first', 'file_second', 'file_regenerated']) assert.equal(imagePrompt({ mapping }, { id }).text, '画一座山');
  assert.equal(imagePrompt({ mapping }, { id: 'file_edited' }).text, '加一只猫');
});
test('duplicate image references require an exact message match instead of guessing a branch', () => {
  const mapping = { a: user('a', null, ['A']), b: user('b', null, ['B']),
    outA: generated('outA', 'a', ['file_same']), outB: generated('outB', 'b', ['file_same']) };
  assert.throws(() => imagePrompt({ mapping }, { id: 'file_same' }), /无法确定/);
  assert.equal(imagePrompt({ mapping }, { id: 'file_same', messageId: 'outB' }).text, 'B');
});
test('uploads, missing assets, broken parents and cycles never copy unrelated text', () => {
  const mapping = { uploaded: user('uploaded', null, ['upload', { asset_pointer: 'sediment://file_upload' }]),
    cycle: generated('cycle', 'cycle', ['file_cycle']), missing: generated('missing', 'absent', ['file_missing']) };
  for (const id of ['file_upload', 'file_cycle', 'file_missing', 'file_absent']) assert.throws(() => imagePrompt({ mapping }, { id }), /无法确定/);
});
test('an empty edit does not fall back to an earlier prompt; multimodal text excludes uploads', () => {
  const mapping = { request: user('request', null, ['old']), original: generated('original', 'request', ['file_original']),
    edit: user('edit', 'original', [{ asset_pointer: 'sediment://file_upload' }]), output: generated('output', 'edit', ['file_output']) };
  assert.throws(() => imagePrompt({ mapping }, { id: 'file_output' }), /没有可复制/);
  mapping.edit.message.content.parts.push('保持参考图的构图', { content_type: 'text', text: '使用暖色' });
  assert.equal(imagePrompt({ mapping }, { id: 'file_output' }).text, '保持参考图的构图\n使用暖色');
});
