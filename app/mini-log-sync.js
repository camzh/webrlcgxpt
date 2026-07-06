function text(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function logItem(payload = null) {
  if (!payload || typeof payload !== 'object') return null;
  const side = payload.side === 'demand' ? 'demand' : 'supply';
  return {
    id: text(payload.id, 100),
    side,
    title: text(payload.title || payload.summaryTitle || '未命名记录', 200),
    status: text(payload.status, 40),
    deleted: payload.deleted === true,
    offlineReviewStatus: text(payload.offlineReviewStatus, 40),
    offlineReason: text(payload.offlineReason || payload.reason, 500)
  };
}

function toMiniLog(log = {}) {
  const before = logItem(log.before);
  const after = logItem(log.after);
  return {
    id: text(log.id, 100),
    action: text(log.action, 40),
    actorName: text(log.actorName || '系统', 80),
    actorRole: text(log.actorRole, 40),
    itemId: text(log.itemId || (after && after.id) || (before && before.id), 100),
    at: text(log.at, 40),
    note: text(log.note, 500),
    side: (after && after.side) || (before && before.side) || '',
    before,
    after
  };
}

module.exports = {
  toMiniLog
};
