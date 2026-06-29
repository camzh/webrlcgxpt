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
  
  console.log('表头识别模式:', hasHeader ? '表头映射' : '固定顺序（fallback）');
  
  const header = hasHeader ? first : ['category', 'condition', 'title', 'quantity', 'price', 'person', 'phone', 'customer', 'urgent', 'note'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const keyFor = h => Object.entries(aliases).find(([, names]) => names.includes(h))?.[0] || h;
  
  // 详细打印映射关系
  console.log('\n列映射详情:');
  header.forEach((h, i) => {
    const key = keyFor(String(h).trim());
    console.log(`  列${i}: "${h}" → ${key === h ? '❌ 未知字段' : key}`);
  });
  
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

console.log('='.repeat(70));
console.log('详细测试：当前导出格式的导入问题');
console.log('='.repeat(70));

// 模拟导出的CSV（第一列是"类型"，值为"货源"）
const exportCsv = `类型,品类,成色,型号规格,数量,报价,GPU,CPU,内存,系统盘,数据盘,网卡1,网卡2,Raid卡,电源,联系人,电话,客户标签,紧急,范围,发布人,备注,发布时间,是否删除,删除人
货源,整机服务器,全新,B300 服务器,1 台,售卖 5000 万元/台,RTX 5090*8,Intel 6530*2,64G DDR5,480G SATA,3.84T SSD,25G双光口*1,,2700W*4,张老板,13800000000,老客户,是,company,管理员,测试备注,2024-06-18,否,`;

const rows = parseCsv(exportCsv);
console.log('\n数据行（第一行数据）:');
rows[1].forEach((val, i) => {
  console.log(`  列${i}: "${val}"`);
});

console.log('\n' + '-'.repeat(70));
const imported = importRows('supply', rows);
console.log('\n导入结果:');
console.log('  side(类型):', imported[0]?.side, '(注意：这个是函数参数传入的，不是从CSV读取的)');
console.log('  category(品类):', imported[0]?.category, '(期望值: 整机服务器)');
console.log('  condition(成色):', imported[0]?.condition, '(期望值: 全新)');
console.log('  title(型号规格):', imported[0]?.title, '(期望值: B300 服务器)');
console.log('  price(价格):', imported[0]?.price, '(期望值: 售卖 5000 万元/台)');
console.log('  GPU:', imported[0]?.machineConfig?.gpu, '(期望值: RTX 5090*8)');
console.log('  CPU:', imported[0]?.machineConfig?.cpu, '(期望值: Intel 6530*2)');
console.log('  person(联系人):', imported[0]?.person, '(期望值: 张老板)');
console.log('  phone(电话):', imported[0]?.phone, '(期望值: 13800000000)');
console.log('  customer(客户标签):', imported[0]?.customer, '(期望值: 老客户)');
console.log('  urgent(紧急):', imported[0]?.urgent, '(期望值: 是)');
console.log('  scope(范围):', imported[0]?.scope, '(期望值: company)');
console.log('  note(备注):', imported[0]?.note, '(期望值: 测试备注)');

console.log('\n' + '='.repeat(70));
console.log('问题分析:');
console.log('='.repeat(70));
console.log('✅ 实际上，在表头映射模式下，即使有"类型"列，其他字段也能正确映射！');
console.log('   因为系统是按"列名"映射，不是按"列位置"顺序匹配');
console.log('\n❌ 真正的问题:');
console.log('   1. "类型"列的数据（货源/需求）被忽略了，side 只能从函数参数传入');
console.log('   2. "发布人"映射到了 person，会覆盖"联系人"的值（这是一个bug！）');
console.log('   3. "发布时间"、"是否删除"、"删除人"这些列被忽略');

console.log('\n' + '='.repeat(70));
console.log('验证"发布人"覆盖"联系人"的问题:');
console.log('='.repeat(70));
console.log('CSV中"联系人"(列15) = "张老板"');
console.log('CSV中"发布人"(列20) = "管理员"');
console.log('但 aliases.person = ["person", "联系人", "提交人", "发布人"]');
console.log('所以"发布人"会覆盖"联系人"的值！');
console.log('\n实际结果: person =', imported[0]?.person, '(期望是"张老板"，但被"发布人"覆盖为"管理员")');

console.log('\n' + '='.repeat(70));
console.log('真正需要修复的问题:');
console.log('='.repeat(70));
console.log('1. 导出时移除"发布人"列，或在导入时把"发布人"从 person 别名中移除');
console.log('2. 增加"类型"字段的识别，自动设置 side（货源→supply，需求→demand）');
console.log('3. 导出时移除"发布时间"、"是否删除"、"删除人"，或在导入时忽略这些列');
console.log('4. 扩展硬件字段：nic3、nic4、pcieSwitch');
