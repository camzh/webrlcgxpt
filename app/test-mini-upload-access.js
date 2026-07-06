const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicUploadMediaPath } = require('./upload-access');

test('allows mini-program and web item media files to be public', () => {
  assert.equal(isPublicUploadMediaPath('/uploads/mini/images/item.jpg'), true);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/videos/item.mp4'), true);
  assert.equal(isPublicUploadMediaPath('/uploads/web/images/1782899997832-ce67e08342c308d5f03cbf0668f48f29.jpg'), true);
  assert.equal(isPublicUploadMediaPath('/uploads/web/videos/item.mp4'), true);
});

test('keeps non-media upload paths private', () => {
  assert.equal(isPublicUploadMediaPath('/uploads/images/item.jpg'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/private/item.jpg'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/web/private/item.jpg'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/web/images/readme.txt'), false);
});

test('rejects directory access and traversal attempts', () => {
  assert.equal(isPublicUploadMediaPath('/uploads/mini/images/'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/videos/'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/web/images/'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/images/../secret.jpg'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/images/%2e%2e/secret.jpg'), false);
  assert.equal(isPublicUploadMediaPath('/uploads/mini/images\\..\\secret.jpg'), false);
});
