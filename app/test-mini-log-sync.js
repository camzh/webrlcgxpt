const test = require('node:test');
const assert = require('node:assert/strict');
const { toMiniLog } = require('./mini-log-sync');

test('maps server status log to mini log payload without exposing full item payload', () => {
  const log = {
    id: 'log_remote_1',
    action: 'mini_status',
    actorName: '大润',
    actorRole: 'superadmin',
    itemId: 'item_1',
    at: '2026-07-05T01:02:00.000Z',
    before: {
      id: 'item_1',
      side: 'demand',
      title: '待下架需求',
      status: 'pending',
      phone: '13800000000',
      media: [{ type: 'image', url: 'https://example.com/a.jpg' }]
    },
    after: {
      id: 'item_1',
      side: 'demand',
      title: '待下架需求',
      status: 'offline',
      deleted: true,
      offlineReviewStatus: 'approved',
      offlineReason: '客户已在别处完成采购',
      phone: '13800000000',
      media: [{ type: 'image', url: 'https://example.com/a.jpg' }]
    }
  };

  assert.deepEqual(toMiniLog(log), {
    id: 'log_remote_1',
    action: 'mini_status',
    actorName: '大润',
    actorRole: 'superadmin',
    itemId: 'item_1',
    at: '2026-07-05T01:02:00.000Z',
    note: '',
    side: 'demand',
    before: {
      id: 'item_1',
      side: 'demand',
      title: '待下架需求',
      status: 'pending',
      deleted: false,
      offlineReviewStatus: '',
      offlineReason: ''
    },
    after: {
      id: 'item_1',
      side: 'demand',
      title: '待下架需求',
      status: 'offline',
      deleted: true,
      offlineReviewStatus: 'approved',
      offlineReason: '客户已在别处完成采购'
    }
  });
});
