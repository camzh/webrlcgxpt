const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendMiniMediaSignature,
  hasValidMiniMediaSignature
} = require("../lib/mini-media-signing");

const SECRET = "unit-test-secret";

test("appends a stable signature to local upload urls", () => {
  const first = appendMiniMediaSignature("/uploads/web/images/a.jpg", SECRET);
  const second = appendMiniMediaSignature("/uploads/web/images/a.jpg", SECRET);

  assert.equal(first, second);
  assert.match(first, /^\/uploads\/web\/images\/a\.jpg\?miniSig=[0-9a-f]{32}$/);
  assert.equal(hasValidMiniMediaSignature(first, SECRET), true);
});

test("preserves existing query parameters while signing uploads", () => {
  const signed = appendMiniMediaSignature("/uploads/web/images/a.jpg?foo=1", SECRET);

  assert.match(signed, /^\/uploads\/web\/images\/a\.jpg\?foo=1&miniSig=[0-9a-f]{32}$/);
  assert.equal(hasValidMiniMediaSignature(signed, SECRET), true);
});

test("does not sign non-upload or data urls", () => {
  assert.equal(appendMiniMediaSignature("https://example.com/photo.jpg", SECRET), "https://example.com/photo.jpg");
  assert.equal(appendMiniMediaSignature("data:image/jpeg;base64,AAAA", SECRET), "data:image/jpeg;base64,AAAA");
  assert.equal(hasValidMiniMediaSignature("https://example.com/photo.jpg?miniSig=abc", SECRET), false);
});

test("rejects tampered upload urls", () => {
  const signed = appendMiniMediaSignature("/uploads/web/images/a.jpg", SECRET);
  const tampered = signed.replace("a.jpg", "b.jpg");

  assert.equal(hasValidMiniMediaSignature(tampered, SECRET), false);
});
