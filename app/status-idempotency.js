const STATUS_ACTION_ALIASES = {
  approve_offline: 'offline_approve',
  offline_approve: 'offline_approve',
  approveOffline: 'offline_approve',
  offlineApproved: 'offline_approve',
  reject_offline: 'offline_reject',
  offline_reject: 'offline_reject',
  rejectOffline: 'offline_reject',
  offlineRejected: 'offline_reject'
};

function normalizeStatusAction(action) {
  return STATUS_ACTION_ALIASES[action] || action;
}

function isIdempotentProcessedStatus(item = {}, action = '') {
  const normalizedAction = normalizeStatusAction(action);
  if (normalizedAction === 'offline') {
    return item.deleted === true
      || item.status === 'offline'
      || item.offlineReviewStatus === 'approved';
  }
  if (normalizedAction === 'offline_approve') {
    return item.status === 'offline'
      || item.offlineReviewStatus === 'approved'
      || (item.deleted === true && item.offlineReviewStatus === 'pending');
  }
  if (normalizedAction === 'offline_reject') {
    return item.offlineReviewStatus === 'rejected';
  }
  return false;
}

function normalizeProcessedStatusForResponse(item = {}, action = '') {
  const normalizedAction = normalizeStatusAction(action);
  const shouldTreatAsApproved = normalizedAction === 'offline'
    || normalizedAction === 'offline_approve'
    || (!normalizedAction && item.deleted === true && item.offlineReviewStatus === 'pending');

  if (!shouldTreatAsApproved || !isIdempotentProcessedStatus(item, 'offline_approve')) {
    return { ...item };
  }

  const at = item.offlineReviewedAt || item.deletedAt || item.updatedAt || item.createdAt || '';
  return {
    ...item,
    deleted: true,
    status: 'offline',
    offlineReviewStatus: 'approved',
    offlineReviewedAt: at,
    deletedAt: item.deletedAt || at
  };
}

module.exports = {
  isIdempotentProcessedStatus,
  normalizeProcessedStatusForResponse,
  normalizeStatusAction
};
