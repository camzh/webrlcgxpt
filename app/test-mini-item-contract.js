const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeDefinedObject,
  mergeMiniMachineConfig,
  synchronizedOwnerInfo,
  validateMiniSupply
} = require('./mini-item-contract');

function validSupply(overrides = {}) {
  return {
    side: 'supply',
    title: '测试货源',
    category: '内存',
    condition: '全新',
    quantity: '200pcs',
    pricing: { saleEnabled: true, salePrice: '1.9', rentalEnabled: false, rentalQuotes: {} },
    person: '董晓东',
    phone: '有效联系方式',
    scope: 'mine',
    cargoOwnerInfo: '货主资料',
    ...overrides
  };
}

test('merges only supplied nested keys and keeps the old object unchanged', () => {
  const oldValue = { brand: 'Intel', model: 'P5510', gpu: 'H200' };
  const merged = mergeDefinedObject(oldValue, { model: 'P5520', gpu: undefined });

  assert.deepEqual(merged, { brand: 'Intel', model: 'P5520', gpu: 'H200' });
  assert.deepEqual(oldValue, { brand: 'Intel', model: 'P5510', gpu: 'H200' });
});

test('preserves unknown old machine config and accepts every current mini spec key', () => {
  assert.deepEqual(mergeMiniMachineConfig({
    brand: 'Intel',
    model: 'P5510',
    legacyExtension: '必须保留'
  }, {
    model: 'P5520',
    capacity: '7.68T',
    frequency: '5600MHz',
    unsupportedNewKey: '不能写入'
  }), {
    brand: 'Intel',
    model: 'P5520',
    capacity: '7.68T',
    frequency: '5600MHz',
    legacyExtension: '必须保留'
  });
});

test('validates the effective record with exact missing labels', () => {
  assert.equal(validateMiniSupply(validSupply({ cargoOwnerInfo: '' })), '请填写：货主信息');
  assert.equal(validateMiniSupply(validSupply({ quantity: '', phone: '', cargoOwnerInfo: '' })),
    '请填写：数量、电话/微信、货主信息');
});

test('allows company supplies without cargo owner information', () => {
  assert.equal(validateMiniSupply(validSupply({ scope: 'company', cargoOwnerInfo: '' })), '');
});

test('keeps owner info persistence aliases synchronized', () => {
  assert.deepEqual(synchronizedOwnerInfo('新货主资料'), {
    cargoOwnerInfo: '新货主资料',
    ownerInfo: '新货主资料'
  });
});

test('validates condition and active pricing modes', () => {
  assert.equal(validateMiniSupply(validSupply({ condition: '未标注' })), '请选择明确成色');
  assert.equal(validateMiniSupply(validSupply({
    pricing: { saleEnabled: true, salePrice: '', rentalEnabled: false, rentalQuotes: {} }
  })), '请填写：出售价格');
  assert.equal(validateMiniSupply(validSupply({
    pricing: { saleEnabled: false, salePrice: '', rentalEnabled: true, rentalQuotes: {} }
  })), '请填写：租赁报价');
  assert.equal(validateMiniSupply(validSupply({
    pricing: { saleEnabled: false, salePrice: '', rentalEnabled: false, rentalQuotes: {} }
  })), '请填写：出售价格或租赁报价');
});
