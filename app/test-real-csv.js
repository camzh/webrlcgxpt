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

// 实际导出的CSV（注意最后一列是空值）
const realExportCsv = `类型,品类,成色,型号规格,数量,报价,GPU,CPU,内存,系统盘,数据盘,网卡1,网卡2,Raid卡,电源,联系人,电话,客户标签,紧急,范围,发布人,备注,发布时间,是否删除,删除人
货源,整机服务器,全新,B300 服务器,1 台,售卖 5000 万元/台,RTX 5090*8,Intel 6530*2,64G DDR5,480G SATA,3.84T SSD,25G双光口*1,,2700W*4,张老板,13800000000,老客户,是,company,管理员,测试备注,2024-06-18,否,`;

// 注意上面的CSV末尾是"否,"（最后是逗号，没有内容）
// 让我们数一数逗号的数量

const headerLine = realExportCsv.split('\n')[0];
const dataLine = realExportCsv.split('\n')[1];

console.log('表头行:', headerLine);
console.log('表头逗号数:', (headerLine.match(/,/g) || []).length);
console.log('表头列数（预期）:', (headerLine.match(/,/g) || []).length + 1);

console.log('\n数据行:', dataLine);
console.log('数据行逗号数:', (dataLine.match(/,/g) || []).length);
console.log('数据列数（预期）:', (dataLine.match(/,/g) || []).length + 1);

const rows = parseCsv(realExportCsv);
console.log('\n实际解析结果:');
console.log('表头列数:', rows[0].length);
console.log('数据列数:', rows[1].length);

if (rows[0].length !== rows[1].length) {
  console.log('\n❌ 列数不一致！');
  console.log('这会导致遍历时后面的列发生错位！');
  console.log('\n遍历演示:');
  const header = rows[0];
  const cols = rows[1];
  header.forEach((h, i) => {
    console.log(`  列${i}: "${h}" = "${cols[i] || '（超出范围，值为 undefined）'}"`);
  });
} else {
  console.log('\n✅ 列数一致');
}

console.log('\n' + '='.repeat(60));
console.log('验证：最后一列是 "删除人"，数据是空字符串');
console.log('如果解析正确，数据列数应该是25，最后一个元素是空字符串');
console.log('实际数据列数:', rows[1].length);
console.log('最后一个元素:', JSON.stringify(rows[1][rows[1].length - 1]));
