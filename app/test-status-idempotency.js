const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isIdempotentProcessedStatus,
  normalizeProcessedStatusForResponse,
  normalizeStatusAction
} = require('./status-idempotency');

test('normalizes offline approval action aliases', () => {
  assert.equal(normalizeStatusAction('approve_offline'), 'offline_approve');
  assert.equal(normalizeStatusAction('offlineApproved'), 'offline_approve');
  assert.equal(normalizeStatusAction('rejectOffline'), 'offline_reject');
});

test('treats repeated offline approvals as idempotent success after item is already offline', () => {
  assert.equal(isIdempotentProcessedStatus({
    deleted: true,
    status: 'offline',
    offlineReviewStatus: 'approved'
  }, 'offline_approve'), true);
});

test('treats repeated offline rejection as idempotent success only after item is already rejected', () => {
  assert.equal(isIdempotentProcessedStatus({
    status: 'on_sale',
    offlineReviewStatus: 'rejected'
  }, 'offline_reject'), true);
});

test('does not hide conflicting or pending approval actions', () => {
  assert.equal(isIdempotentProcessedStatus({
    status: 'on_sale',
    offlineReviewStatus: 'pending'
  }, 'offline_approve'), false);
  assert.equal(isIdempotentProcessedStatus({
    deleted: true,
    status: 'offline',
    offlineReviewStatus: 'approved'
  }, 'offline_reject'), false);
});

test('normalizes deleted pending offline approvals in responses without mutating input', () => {
  const dirty = {
    deleted: true,
    status: 'on_sale',
    offlineReviewStatus: 'pending',
    updatedAt: '2026-06-16T01:34:05.167Z'
  };

  const normalized = normalizeProcessedStatusForResponse(dirty);

  assert.deepEqual(normalized, {
    deleted: true,
    status: 'offline',
    offlineReviewStatus: 'approved',
    updatedAt: '2026-06-16T01:34:05.167Z',
    offlineReviewedAt: '2026-06-16T01:34:05.167Z',
    deletedAt: '2026-06-16T01:34:05.167Z'
  });
  assert.equal(dirty.status, 'on_sale');
  assert.equal(dirty.offlineReviewStatus, 'pending');
});
