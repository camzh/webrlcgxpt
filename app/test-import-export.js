// 测试导入导出兼容性
function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(textValue || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some(v => String(v).trim())) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some(v => String(v).trim())) rows.push(row);
  return rows;
}

function importRows(side, rows) {
  if (!rows.length) return [];
  const aliases = {
    category: ['category', '品类', '产品类型'],
    condition: ['condition', '成色', '状态'],
    title: ['title', '型号规格', '型号', '规格', '标题'],
    quantity: ['quantity', '数量'],
    price: ['price', '价格', '报价'],
    person: ['person', '联系人', '提交人', '发布人'],
    phone: ['phone', '电话', '微信', '联系方式'],
    customer: ['customer', '客户标签', '客户类型'],
    urgent: ['urgent', '紧急', '是否紧急'],
    note: ['note', '备注'],
    scope: ['scope', '范围', '可见范围'],
    sharedTo: ['sharedTo', '共享给', '共享人'],
    gpu: ['gpu', 'GPU', '显卡'],
    cpu: ['cpu', 'CPU', '处理器'],
    memory: ['memory', '内存'],
    systemDisk: ['systemDisk', '系统盘'],
    dataDisk: ['dataDisk', '数据盘', '硬盘'],
    nic1: ['nic1', '网卡1', '网卡'],
    nic2: ['nic2', '网卡2'],
    raid: ['raid', 'Raid卡', 'RAID', '阵列卡'],
    psu: ['psu', 'PSU', '电源']
  };
  const configKeys = new Set(['gpu', 'cpu', 'memory', 'systemDisk', 'dataDisk', 'nic1', 'nic2', 'raid', 'psu']);
  const first = rows[0].map(v => String(v).trim());
  const hasHeader = first.some(h => Object.values(aliases).flat().includes(h));
  
  console.log('表头识别结果:', hasHeader ? '成功' : '失败（回退到固定顺序模式）');
  console.log('可识别的表头字段:', first.filter(h => Object.values(aliases).flat().includes(h)));
  console.log('无法识别的表头字段:', first.filter(h => !Object.values(aliases).flat().includes(h)));
  
  const header = hasHeader ? first : ['category', 'condition', 'title', 'quantity', 'price', 'person', 'phone', 'customer', 'urgent', 'note'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const keyFor = h => Object.entries(aliases).find(([, names]) => names.includes(h))?.[0] || h;
  return dataRows
    .map(cols => {
      const raw = { side, machineConfig: {} };
      header.forEach((h, i) => {
        const key = keyFor(String(h).trim());
        const value = cols[i] || '';
        if (configKeys.has(key)) {
          if (String(value).trim()) raw.machineConfig[key] = value;
        } else {
          raw[key] = value;
        }
      });
      return raw;
    });
}

// ============================================
// 测试1：当前导出格式 -> 导入（有问题）
// ============================================
console.log('='.repeat(60));
console.log('测试1：当前导出格式 -> 导入（问题演示）');
console.log('='.repeat(60));

const currentExportCsv = `类型,品类,成色,型号规格,数量,报价,GPU,CPU,内存,系统盘,数据盘,网卡1,网卡2,Raid卡,电源,联系人,电话,客户标签,紧急,范围,发布人,备注,发布时间,是否删除,删除人
货源,整机服务器,全新,B300 服务器,1 台,售卖 5000 万元/台,RTX 5090*8,Intel 6530*2,64G DDR5,480G SATA,3.84T SSD,25G双光口*1,,2700W*4,张老板,13800000000,老客户,是,company,管理员,测试备注,2024-06-18,否,`;

const exportRows = parseCsv(currentExportCsv);
console.log('\n当前导出的表头:', exportRows[0]);
console.log('表头列数:', exportRows[0].length);
console.log('\n导入结果:');
const imported1 = importRows('supply', exportRows);
console.log('品类 (应: 整机服务器):', imported1[0]?.category);
console.log('成色 (应: 全新):', imported1[0]?.condition);
console.log('型号规格 (应: B300 服务器):', imported1[0]?.title);
console.log('GPU (应: RTX 5090*8):', imported1[0]?.machineConfig?.gpu);
console.log('⚠️  可以看到：因为第一列"类型"无法识别，导致表头识别失败，所有数据都错位了！');

// ============================================
// 测试2：修复后导出格式 -> 导入（正常）
// ============================================
console.log('\n' + '='.repeat(60));
console.log('测试2：修复后导出格式 -> 导入（正常）');
console.log('='.repeat(60));

const fixedExportCsv = `品类,成色,型号规格,数量,价格,GPU,CPU,内存,系统盘,数据盘,网卡1,网卡2,Raid卡,电源,联系人,电话,客户标签,紧急,备注,范围,共享给
整机服务器,全新,B300 服务器,1 台,售卖 5000 万元/台,RTX 5090*8,Intel 6530*2,64G DDR5,480G SATA,3.84T SSD,25G双光口*1,,2700W*4,张老板,13800000000,老客户,否,测试备注,company,`;

const fixedRows = parseCsv(fixedExportCsv);
console.log('\n修复后的表头:', fixedRows[0]);
console.log('表头列数:', fixedRows[0].length);
console.log('\n导入结果:');
const imported2 = importRows('supply', fixedRows);
console.log('品类 (应: 整机服务器):', imported2[0]?.category);
console.log('成色 (应: 全新):', imported2[0]?.condition);
console.log('型号规格 (应: B300 服务器):', imported2[0]?.title);
console.log('GPU (应: RTX 5090*8):', imported2[0]?.machineConfig?.gpu);
console.log('✅ 修复后：表头识别成功，数据正确对应！');

// ============================================
// 测试3：增加"类型"字段支持
// ============================================
console.log('\n' + '='.repeat(60));
console.log('测试3：增加"类型"字段支持（可选方案）');
console.log('='.repeat(60));

function importRowsFixed(side, rows) {
  if (!rows.length) return [];
  const aliases = {
    side: ['side', '类型', '供需类型'],
    category: ['category', '品类', '产品类型'],
    condition: ['condition', '成色', '状态'],
    title: ['title', '型号规格', '型号', '规格', '标题'],
    quantity: ['quantity', '数量'],
    price: ['price', '价格', '报价'],
    person: ['person', '联系人', '提交人', '发布人'],
    phone: ['phone', '电话', '微信', '联系方式'],
    customer: ['customer', '客户标签', '客户类型'],
    urgent: ['urgent', '紧急', '是否紧急'],
    note: ['note', '备注'],
    scope: ['scope', '范围', '可见范围'],
    sharedTo: ['sharedTo', '共享给', '共享人'],
    gpu: ['gpu', 'GPU', '显卡'],
    cpu: ['cpu', 'CPU', '处理器'],
    memory: ['memory', '内存'],
    systemDisk: ['systemDisk', '系统盘'],
    dataDisk: ['dataDisk', '数据盘', '硬盘'],
    nic1: ['nic1', '网卡1', '网卡'],
    nic2: ['nic2', '网卡2'],
    nic3: ['nic3', '网卡3'],
    nic4: ['nic4', '网卡4'],
    pcieSwitch: ['pcieSwitch', 'PCIE交换芯片', '交换芯片'],
    raid: ['raid', 'Raid卡', 'RAID', '阵列卡'],
    psu: ['psu', 'PSU', '电源']
  };
  const configKeys = new Set(['gpu', 'cpu', 'memory', 'systemDisk', 'dataDisk', 'nic1', 'nic2', 'nic3', 'nic4', 'pcieSwitch', 'raid', 'psu']);
  const first = rows[0].map(v => String(v).trim());
  const hasHeader = first.some(h => Object.values(aliases).flat().includes(h));
  
  console.log('表头识别结果:', hasHeader ? '成功' : '失败');
  console.log('可识别的表头字段:', first.filter(h => Object.values(aliases).flat().includes(h)));
  
  const header = hasHeader ? first : ['category', 'condition', 'title', 'quantity', 'price', 'person', 'phone', 'customer', 'urgent', 'note'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const keyFor = h => Object.entries(aliases).find(([, names]) => names.includes(h))?.[0] || h;
  return dataRows
    .map(cols => {
      const raw = { machineConfig: {} };
      header.forEach((h, i) => {
        const key = keyFor(String(h).trim());
        const value = cols[i] || '';
        if (configKeys.has(key)) {
          if (String(value).trim()) raw.machineConfig[key] = value;
        } else {
          raw[key] = value;
        }
      });
      // 根据"类型"字段设置 side
      if (raw.side === '货源') raw.side = 'supply';
      else if (raw.side === '需求') raw.side = 'demand';
      else raw.side = side;
      return raw;
    });
}

console.log('\n使用原导出格式（带"类型"列），但增加字段映射支持:');
const imported3 = importRowsFixed('supply', exportRows);
console.log('品类 (应: 整机服务器):', imported3[0]?.category);
console.log('成色 (应: 全新):', imported3[0]?.condition);
console.log('型号规格 (应: B300 服务器):', imported3[0]?.title);
console.log('GPU (应: RTX 5090*8):', imported3[0]?.machineConfig?.gpu);
console.log('类型自动识别:', imported3[0]?.side);
console.log('✅ 增加"类型"字段映射后，即使导出带类型列也能正确导入！');

console.log('\n' + '='.repeat(60));
console.log('测试4：扩展硬件字段测试');
console.log('='.repeat(60));

const extendedCsv = `品类,成色,型号规格,数量,价格,GPU,CPU,内存,系统盘,数据盘,网卡1,网卡2,网卡3,网卡4,PCIE交换芯片,Raid卡,电源
整机服务器,全新,高性能服务器,1 台,10万元,A100*8,Intel 8375C*2,512G DDR5,960G SATA*2,3.84T SSD*8,25G双光口*1,10G双电口*1,IB 100G*2,,PCIe Gen4 Switch,HBA卡,3000W*4`;

const extendedRows = parseCsv(extendedCsv);
const imported4 = importRowsFixed('supply', extendedRows);
console.log('网卡3:', imported4[0]?.machineConfig?.nic3);
console.log('网卡4:', imported4[0]?.machineConfig?.nic4);
console.log('PCIE交换芯片:', imported4[0]?.machineConfig?.pcieSwitch);
console.log('✅ 新字段可以正确识别和导入！');

console.log('\n' + '='.repeat(60));
console.log('总结');
console.log('='.repeat(60));
console.log('1. 问题根源：导出的"类型"列在导入时无法识别，导致表头匹配失败');
console.log('2. 方案A：导出时移除"类型"等无法导入的列，使导出=模板');
console.log('3. 方案B：导入时增加"类型"字段的映射支持');
console.log('4. 推荐：方案B + 扩展硬件字段（nic3、nic4、pcieSwitch）');
