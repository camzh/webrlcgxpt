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

// 测试：末尾空列问题
const csvWithTrailingEmpty = `类型,品类,成色
货源,整机服务器,`; // 注意最后有一个逗号，后面是空值

console.log('CSV内容:');
console.log(csvWithTrailingEmpty);

const rows = parseCsv(csvWithTrailingEmpty);
console.log('\n解析结果:');
console.log('表头列数:', rows[0].length, rows[0]);
console.log('数据列数:', rows[1].length, rows[1]);

if (rows[0].length !== rows[1].length) {
  console.log('\n❌ 问题：表头和数据列数不一致！');
  console.log('   原因：CSV最后是空列时，解析函数没有正确处理');
  console.log('   这就是导致数据大面积错位的根本原因！');
}

// 测试：带引号的末尾空列
const csvWithQuotes = `"类型","品类","成色"
"货源","整机服务器",""`; // 最后是空字符串，带引号

console.log('\n' + '='.repeat(50));
const rows2 = parseCsv(csvWithQuotes);
console.log('带引号的末尾空列:');
console.log('表头列数:', rows2[0].length, rows2[0]);
console.log('数据列数:', rows2[1].length, rows2[1]);

// 测试：多个末尾空列
const csvMultiEmpty = `a,b,c,d
1,2,,`;

console.log('\n' + '='.repeat(50));
const rows3 = parseCsv(csvMultiEmpty);
console.log('多个末尾空列:');
console.log('表头列数:', rows3[0].length, rows3[0]);
console.log('数据列数:', rows3[1].length, rows3[1]);

console.log('\n' + '='.repeat(50));
console.log('结论：');
console.log('当CSV最后一列为空且没有引号时，解析函数会丢失这一列');
console.log('导致表头和数据列数不一致，后面所有数据错位！');
console.log('这就是导出→导入时数据不对应的根本原因！');
