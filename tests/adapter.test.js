import test from 'node:test';
import assert from 'node:assert/strict';
await import('../extension/adapter.js');
const adapter = globalThis.ImageLibraryAdapter;

test('signed URL rotation preserves the image identity', () => {
  const first = adapter.libraryPage({ items: [{ image_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_123&sig=first' }] });
  const second = adapter.libraryPage({ items: [{ image_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_123&sig=second' }] });
  assert.equal(first.images[0].id, second.images[0].id);
});
test('library pages preserve explicit completion and source conversation metadata', () => {
  const result = adapter.libraryPage({ items: [{ conversation_id: 'conversation', title: 'Title', create_time: 1700000000,
    images: [{ asset_pointer: 'sediment://file_123', width: 1024, height: 768 }] }], has_more: false, total: 1 });
  assert.equal(result.images[0].id, 'file_123'); assert.equal(result.images[0].conversationId, 'conversation');
  assert.equal(result.images[0].createdAt, 1700000000000); assert.equal(result.hasMore, false);
});
test('unrecognized payload throws rather than treating old pictures as deleted', () => {
  assert.throws(() => adapter.libraryPage({ unexpected: [] }), /数据结构/);
});
test('conversation fallback excludes user-uploaded images', () => {
  const result = adapter.conversationImages({ mapping: {
    user: { message: { author: { role: 'user' }, content: { parts: [{ asset_pointer: 'sediment://file_upload' }] } } },
    generated: { message: { id: 'message', author: { role: 'assistant' }, content: { parts: [{ asset_pointer: 'sediment://file_generated' }] } } }
  } }, { conversationId: 'conversation' });
  assert.deepEqual(result.map(image => image.id), ['file_generated']);
});
test('remote images are restricted to ChatGPT and its asset hosts', () => {
  assert.equal(adapter.imageURL('https://evil.example/pixel'), '');
  assert.equal(adapter.imageURL('javascript:alert(1)'), '');
  assert.equal(adapter.imageURL('https://chatgpt.com.evil.example/pixel'), '');
  assert.ok(adapter.imageURL('https://files.oaiusercontent.com/image.png'));
});
test('official pagination sends the cursor as after with the website page sizes', () => {
  const first = new URL(adapter.libraryURL(null));
  const next = new URL(adapter.libraryURL('opaque+cursor/='));
  assert.equal(first.searchParams.get('limit'), '25');
  assert.equal(first.searchParams.has('after'), false);
  assert.equal(next.searchParams.get('limit'), '20');
  assert.equal(next.searchParams.get('after'), 'opaque+cursor/=');
  assert.equal(next.searchParams.has('cursor'), false);
  assert.equal(next.searchParams.has('offset'), false);
});
test('archived entries follow the official library filter without corrupting pagination', () => {
  const result = adapter.libraryPage({ items: [{ file_id: 'file_archived', is_archived: true }, { file_id: 'file_visible' }], cursor: 'next' });
  assert.deepEqual(result.images.map(image => image.id), ['file_visible']);
  assert.equal(result.itemCount, 2); assert.equal(result.skippedCount, 1); assert.equal(result.cursor, 'next');
});
