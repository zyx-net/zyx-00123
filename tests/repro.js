const path = require('path')
const fs = require('fs')

const store = require('../src/store')
const importer = require('../src/importer')
const classifier = require('../src/classifier')
const validator = require('../src/validator')
const reviewer = require('../src/reviewer')
const undo = require('../src/undo')
const archiver = require('../src/archiver')

let pass = 0
let fail = 0

function assert(cond, msg) {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

function cleanup() {
  const dataDir = store.DATA_DIR
  for (const f of ['commits', 'config', 'archives', 'undo']) {
    const fp = path.join(dataDir, `${f}.json`)
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  }
}

function makeCsv(lines, outPath) {
  const header = 'hash,message,author,date,ticket,version\n'
  const content = header + lines.join('\n')
  fs.writeFileSync(outPath, content, 'utf-8')
}

const tmpCsv1 = path.join(store.DATA_DIR, '_test1.csv')
const tmpCsv2 = path.join(store.DATA_DIR, '_test2.csv')

function test1_batchImportDedup() {
  console.log('\n== 测试1: 同批导入内部去重（整批重复不会写进DB）==')
  cleanup()
  undo.clear()

  const lines = [
    'aaa1111,feat: 模块A,张三,2025-01-01,PROJ-1,v1.0.0',
    'bbb2222,fix: bugX,李四,2025-01-02,PROJ-2,v1.0.0',
    'aaa1111,feat: 模块A(重复行),张三,2025-01-01,PROJ-1,v1.0.0',
    'ccc3333,fix: bugY,王五,2025-01-03,PROJ-3,v1.0.0',
    'bbb2222,fix: bugX(重复行),李四,2025-01-02,PROJ-2,v1.0.0'
  ]
  makeCsv(lines, tmpCsv1)

  const before = store.loadCommits().length
  const result = importer.importFromCsv(tmpCsv1)
  const after = store.loadCommits().length

  console.log(`   导入报告: 新增=${result.added} 重复=${result.duplicates} 总=${result.total}`)
  assert(result.added === 3, `应新增3条实际新增了${result.added}`)
  assert(result.duplicates >= 2, `应报告重复>=2实际为${result.duplicates}`)
  assert(after - before === 3, `DB中条数净增3实际增了${after - before}`)

  const uniqueIds = new Set(store.loadCommits().map(c => c.id))
  assert(uniqueIds.size === store.loadCommits().length, 'DB中不应有重复id')
  assert(uniqueIds.has('aaa1111') && uniqueIds.has('bbb2222') && uniqueIds.has('ccc3333'), '三条唯一id都在')
}

function test2_crossBatchDedup() {
  console.log('\n== 测试2: 跨批去重（同一文件导入两次，第二次不增加）==')
  cleanup()
  undo.clear()

  const lines = [
    'aaa1111,feat: 模块A,张三,2025-01-01,PROJ-1,v1.0.0',
    'bbb2222,fix: bugX,李四,2025-01-02,PROJ-2,v1.0.0'
  ]
  makeCsv(lines, tmpCsv2)

  const r1 = importer.importFromCsv(tmpCsv2)
  const r2 = importer.importFromCsv(tmpCsv2)

  const total = store.loadCommits().length
  assert(r1.added === 2, `首次新增2实际${r1.added}`)
  assert(r2.added === 0, `第二次新增0实际${r2.added}`)
  assert(r2.duplicates === 2, `第二次重复2实际${r2.duplicates}`)
  assert(total === 2, `DB最终2条实际${total}`)
}

function test3_setCategoryThenUndo() {
  console.log('\n== 测试3: 手工改分类后撤销应回到分类前状态 ==')
  cleanup()
  undo.clear()

  const lines = [
    'aaa1111,docs: 更新说明,张三,2025-01-01,PROJ-1,v1.0.0',
    'bbb2222,fix: bugX,李四,2025-01-02,PROJ-2,v1.0.0'
  ]
  makeCsv(lines, tmpCsv2)
  importer.importFromCsv(tmpCsv2)

  classifier.classify()

  const aaaBefore = store.loadCommits().find(c => c.id === 'aaa1111').category
  console.log(`   自动分类后 aaa1111 category=${aaaBefore}`)

  classifier.setCategory('aaa1111', 'feature')
  const aaaMid = store.loadCommits().find(c => c.id === 'aaa1111').category
  assert(aaaMid === 'feature', `改分类后应为feature实际${aaaMid}`)

  const top = undo.peek()
  assert(top && top.type === 'set-category', `栈顶应为set-category实际=${top ? top.type : '空'}`)
  console.log(`   栈顶: [${top.type}] ${top.description}`)

  const sizeBefore = undo.size()
  const u1 = undo.pop()
  assert(u1.success && u1.action === 'set-category', `pop1应弹出set-category实际=${u1.action}`)
  console.log(`   pop1: ${u1.action} / ${u1.description}`)

  const aaaAfter = store.loadCommits().find(c => c.id === 'aaa1111').category
  console.log(`   撤销1次后 aaa1111 category=${aaaAfter}`)
  assert(aaaAfter === aaaBefore, `撤销后category应=${aaaBefore}实际=${aaaAfter}`)

  const u2 = undo.pop()
  assert(u2.success && u2.action === 'classify', `pop2应弹出classify实际=${u2.action}`)

  const u3 = undo.pop()
  assert(u3.success && u3.action === 'import', `pop3应弹出import实际=${u3.action}`)

  const u4 = undo.pop()
  assert(u4.success === false, 'pop4应失败')
  assert(u4.reason === '没有历史可撤销: 撤销栈为空', `失败原因应为"没有历史可撤销: 撤销栈为空"，实际=${u4.reason}`)
  console.log(`   pop4 failed (正确): ${u4.reason}`)
}

function test4_reviewAfterUndoConsistency() {
  console.log('\n== 测试4: 手工改分类->撤销->复核，状态应连贯不被带乱 ==')
  cleanup()
  undo.clear()

  const lines = [
    'aaa1111,feat: 模块A,张三,2025-01-01,PROJ-1,v1.0.0',
    'bbb2222,fix: bugX,李四,2025-01-02,PROJ-2,v1.0.0'
  ]
  makeCsv(lines, tmpCsv2)
  importer.importFromCsv(tmpCsv2)

  classifier.classify()

  classifier.setCategory('aaa1111', 'fix')
  undo.pop()

  const commits = store.loadCommits()
  const aaa = commits.find(c => c.id === 'aaa1111')
  assert(!aaa.reviewed, '此时aaa还未被复核')
  assert(aaa.category === 'feature', `撤销setCategory后aaa应恢复到classify结果feature，实际=${aaa.category}`)

  reviewer.review('aaa1111', '已验证OK')
  reviewer.review('bbb2222', '已验证')

  validator.validate()
  const check = validator.checkArchiveReadiness('v1.0.0')
  console.log(`   归档就绪: ${check.ready}${!check.ready ? ' 原因=' + check.reason : ''}`)
  assert(check.ready, '应能正常归档')

  const snap = archiver.archive('v1.0.0')
  assert(snap.commitCount === 2, `归档后应为2条实际${snap.commitCount}`)

  assert(store.loadCommits().length <= 1, '归档后非ignored提交应从pending清空')
  assert(archiver.listArchives().length === 1, '归档列表应含1个版本')

  const md = require('../src/exporter').generateMarkdown('v1.0.0')
  assert(md.includes('aaa1111'), 'md中应包含来源提交hash')
  assert(md.includes('已验证OK'), 'md中应包含人工备注')
  console.log(`   MD预览(前300字): ${md.substring(0, 300)}...`)
}

function test5_archiveSnapshotInsulatedFromRuleChanges() {
  console.log('\n== 测试5: 重启后导出归档，应使用当时快照，规则改动不影响 ==')
  test4_reviewAfterUndoConsistency()

  const cfg = require('../src/config')
  const before = JSON.parse(JSON.stringify(cfg.get()))

  cfg.update({
    ticketPattern: 'DOES-NOT-MATCH-ANYTHING',
    keywords: { feature: ['UNLIKELY_WORD_XYZ'], fix: ['UNLIKELY_WORD_FIX'], breaking: ['UNLIKELY_BRK'] }
  })

  const md = require('../src/exporter').generateMarkdown('v1.0.0')
  assert(md.includes('模块A'), '即使规则变化，快照仍保留原始message')
  assert(md.includes('PROJ-1'), '即使ticketPattern变化，快照中的工单不变')

  cfg.reset()
  cfg.update(before)
  const mdAfter = require('../src/exporter').generateMarkdown('v1.0.0')
  assert(md === mdAfter, '规则恢复前后导出的md完全一致')

  console.log('   重启模拟: 重新加载归档数据')
  delete require.cache[require.resolve('../src/archiver')]
  delete require.cache[require.resolve('../src/exporter')]
  delete require.cache[require.resolve('../src/store')]
  const exporter2 = require('../src/exporter')
  const mdRestart = exporter2.generateMarkdown('v1.0.0')
  assert(md === mdRestart, '重启后(清require缓存)导出内容与归档时一致')
}

function test6_emptyUndoStackReport() {
  console.log('\n== 测试6: 清空撤销栈后再次撤销应明确报原因 ==')
  cleanup()
  undo.clear()

  const top = undo.peek()
  assert(top === null, 'peek应返回null')

  const r = undo.pop()
  assert(r.success === false, 'pop应失败')
  assert(r.reason === '没有历史可撤销: 撤销栈为空', `原因应精确，实际=${r.reason}`)
}

try {
  test1_batchImportDedup()
  test2_crossBatchDedup()
  test3_setCategoryThenUndo()
  test4_reviewAfterUndoConsistency()
  test5_archiveSnapshotInsulatedFromRuleChanges()
  test6_emptyUndoStackReport()

  console.log(`\n========== 汇总: 通过 ${pass} / ${pass + fail} ==========`)
  if (fail > 0) {
    console.log(`  ❗ ${fail} 个失败 —— 这就是当前代码的真实 Bug，开始修复`)
    process.exit(1)
  } else {
    console.log('  ✓ 全部通过')
    process.exit(0)
  }
} finally {
  for (const f of [tmpCsv1, tmpCsv2]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f) } catch {}
    }
  }
}
