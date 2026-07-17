const REQUIRED_FIELDS = [
  ['title', '货源标题'],
  ['category', '品类'],
  ['condition', '成色'],
  ['quantity', '数量'],
  ['person', '联系人'],
  ['phone', '电话/微信']
];

const INVALID_CONDITIONS = new Set(['未标注', '未标记', '未设置']);
const MINI_MACHINE_CONFIG_KEYS = [
  'brand', 'model', 'capacity', 'frequency', 'memoryType', 'rank',
  'interfaceType', 'formFactor', 'grade', 'power', 'cpuCount', 'memoryBrand',
  'diskCount', 'diskBrand', 'diskCapacity', 'gpu', 'cpu', 'memory',
  'systemDisk', 'dataDisk', 'nic1', 'nic2', 'nic3', 'nic4', 'extraNics',
  'raid', 'psu', 'pcieSwitch'
];

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

function mergeDefinedObject(oldValue = {}, patch = {}) {
  const merged = { ...(oldValue || {}) };
  Object.keys(patch || {}).forEach(key => {
    if (patch[key] !== undefined) merged[key] = patch[key];
  });
  return merged;
}

function mergeMiniMachineConfig(oldValue = {}, patch = {}) {
  const safePatch = {};
  MINI_MACHINE_CONFIG_KEYS.forEach(key => {
    if (patch && patch[key] !== undefined) {
      safePatch[key] = String(patch[key] ?? '').slice(0, 200);
    }
  });
  return mergeDefinedObject(oldValue, safePatch);
}

function hasRentalPrice(pricing = {}) {
  return Object.values(pricing.rentalQuotes || {}).some(hasText);
}

function synchronizedOwnerInfo(value) {
  return {
    cargoOwnerInfo: value,
    ownerInfo: value
  };
}

function validateMiniSupply(item = {}) {
  if (item.side !== 'supply') return '';

  const missing = REQUIRED_FIELDS
    .filter(([field]) => !hasText(item[field]))
    .map(([, label]) => label);
  if (item.scope !== 'company' && !hasText(item.cargoOwnerInfo || item.ownerInfo)) {
    missing.push('货主信息');
  }
  if (missing.length) return `请填写：${missing.join('、')}`;

  if (INVALID_CONDITIONS.has(String(item.condition || '').trim())) {
    return '请选择明确成色';
  }

  const pricing = item.pricing || {};
  if (!pricing.saleEnabled && !pricing.rentalEnabled) {
    return '请填写：出售价格或租赁报价';
  }
  const pricingMissing = [];
  if (pricing.saleEnabled && !hasText(pricing.salePrice)) pricingMissing.push('出售价格');
  if (pricing.rentalEnabled && !hasRentalPrice(pricing)) pricingMissing.push('租赁报价');
  return pricingMissing.length ? `请填写：${pricingMissing.join('、')}` : '';
}

module.exports = {
  MINI_MACHINE_CONFIG_KEYS,
  mergeDefinedObject,
  mergeMiniMachineConfig,
  synchronizedOwnerInfo,
  validateMiniSupply
};
