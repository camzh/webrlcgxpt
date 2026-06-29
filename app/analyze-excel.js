const fs = require('fs');
const zlib = require('zlib');

function colIndex(ref = '') {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(n - 1, 0);
}

function xmlText(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function unzipEntries(buffer) {
  const entries = {};
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效的 xlsx 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const fileNameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + fileNameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.slice(dataStart, dataStart + compressedSize);
      entries[name] = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    }
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function parseXlsxRows(buffer) {
  const entries = unzipEntries(buffer);
  const sharedXml = entries['xl/sharedStrings.xml'] || '';
  const shared = [];
  sharedXml.replace(/<si[\s\S]*?<\/si>/g, block => {
    shared.push(xmlText((block.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
    return block;
  });
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = entries['xl/workbook.xml'] || '';
  const rels = entries['xl/_rels/workbook.xml.rels'] || '';
  const firstSheet = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const relMatch = rels.match(new RegExp(`<Relationship[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`));
    if (relMatch) sheetPath = relMatch[1].startsWith('/') ? relMatch[1].slice(1) : 'xl/' + relMatch[1].replace(/^\/?xl\//, '');
  }
  const sheetXml = entries[sheetPath] || entries['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('xlsx 中没有找到工作表');
  const rows = [];
  sheetXml.replace(/<row\b[^>]*>[\s\S]*?<\/row>/g, rowXml => {
    const row = [];
    rowXml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (_, attrs, cellXml) => {
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      const idx = colIndex(ref);
      let value = '';
      if (type === 'inlineStr') value = xmlText(cellXml);
      else {
        const v = (cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '';
        value = type === 's' ? (shared[Number(v)] || '') : xmlText(v);
      }
      row[idx] = value;
      return '';
    });
    if (row.some(v => String(v || '').trim())) rows.push(row.map(v => v || ''));
    return '';
  });
  return rows;
}

// Analyze business template
const businessBuffer = fs.readFileSync('E:\\上传货源\\货源信息.xlsx');
const businessRows = parseXlsxRows(businessBuffer);
console.log('=== 业务同事收到的货源信息模板 ===');
console.log('列数:', businessRows[0]?.length || 0);
console.log('表头:', JSON.stringify(businessRows[0], null, 2));
console.log('\n数据行数:', businessRows.length - 1);
console.log('\n前3行数据:');
for (let i = 1; i < Math.min(4, businessRows.length); i++) {
  console.log(`行${i}:`, JSON.stringify(businessRows[i]));
}

// Analyze download template
console.log('\n\n=== 系统下载模板 ===');
const templateRows = [
  ['品类', '成色', '型号规格', '数量', '价格', 'GPU', 'CPU', '内存', '系统盘', '数据盘', '网卡1', '网卡2', 'Raid卡', '电源', '联系人', '电话', '客户标签', '紧急', '备注', '范围', '共享给']
];
console.log('列数:', templateRows[0].length);
console.log('表头:', JSON.stringify(templateRows[0], null, 2));

// Analyze export result
console.log('\n\n=== 系统导出结果 ===');
const exportRows = [
  ['类型', '品类', '成色', '型号规格', '数量', '报价', 'GPU', 'CPU', '内存', '系统盘', '数据盘', '网卡1', '网卡2', 'Raid卡', '电源', '联系人', '电话', '客户标签', '紧急', '范围', '发布人', '备注', '发布时间', '是否删除', '删除人']
];
console.log('列数:', exportRows[0].length);
console.log('表头:', JSON.stringify(exportRows[0], null, 2));

// Compare columns
console.log('\n\n=== 字段映射对比 ===');
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

console.log('\n导入时可识别的字段:');
Object.entries(aliases).forEach(([key, names]) => {
  console.log(`  ${key}: ${names.join(', ')}`);
});

console.log('\n\n=== 问题分析 ===');
console.log('1. 导出的CSV第一列是"类型"，但导入时无法识别这个表头字段');
console.log('2. 表头识别失败后，系统回退到固定顺序模式，只有10列：品类,成色,型号规格,数量,价格,联系人,电话,客户标签,紧急,备注');
console.log('3. 但导出的CSV有25列，导致数据完全错位');
console.log('4. "下载模板"功能与导出功能重复，建议移除');
console.log('5. 当前machineConfig只支持nic1/nic2，无法满足多网卡场景');
console.log('6. 当前不支持PCIE交换芯片字段');
