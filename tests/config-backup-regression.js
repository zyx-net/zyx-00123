const fs = require('fs')
const path = require('path')
const os = require('os')

const store = require('../src/store')
const config = require('../src/config')
const configBackup = require('../src/configBackup')

const { computeChecksum, detectConflict } = configBackup._testExports

function cleanupAll() {
  const dataDir = store.DATA_DIR
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir)
    files.forEach(f => {
      const fp = path.join(dataDir, f)
      const stat = fs.statSync(fp)
      if (stat.isFile()) fs.unlinkSync(fp)
    })
    const backupsDir = path.join(dataDir, 'backups')
    if (fs.existsSync(backupsDir)) {
      const bf = fs.readdirSync(backupsDir)
      bf.forEach(f => fs.unlinkSync(path.join(backupsDir, f)))
      fs.rmdirSync(backupsDir)
    }
  }
  config.reset()
}

function runTests() {
  let pass = 0, fail = 0
  const assert = (cond, msg) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`) }
    else { fail++; console.error(`  ✗ ${msg}`) }
  }
  const assertEq = (a, b, msg) => {
    const ok = JSON.stringify(a) === JSON.stringify(b)
    if (ok) { pass++; console.log(`  ✓ ${msg}`) }
    else {
      fail++
      console.error(`  ✗ ${msg}\n    期望: ${JSON.stringify(b)}\n    实际: ${JSON.stringify(a)}`)
    }
  }

  console.log('\n====== 配置备份/恢复 Bug 回归验证 ======\n')

  cleanupAll()

  console.log('【Bug 1 & 4】恢复备份打乱关键字顺序 + 撤销不精确')
  console.log('  场景: 配置特定顺序关键字 → 导出备份 → 修改当前配置 → 恢复备份 → 校验顺序字节级一致 → 撤销 → 校验回到修改后顺序 → 模拟重启重新 require → 再校验磁盘与内存一致')
  const ORDERED_FEATURE = ['zebra', 'apple', 'mango', 'feat']
  const ORDERED_FIX = ['zoo', 'bug', 'fix']
  const ORDERED_IGNORE = ['^Zzz', '^AAA', '^Merge']
  config.reset()
  let cfg = config.get()
  cfg.keywords.feature = [...ORDERED_FEATURE]
  cfg.keywords.fix = [...ORDERED_FIX]
  cfg.ignorePatterns = [...ORDERED_IGNORE]
  config.update({ keywords: cfg.keywords, ignorePatterns: cfg.ignorePatterns })
  const afterSetup = config.get()
  assertEq(afterSetup.keywords.feature, ORDERED_FEATURE, '初始 feature 关键字顺序设置正确')
  assertEq(afterSetup.keywords.fix, ORDERED_FIX, '初始 fix 关键字顺序设置正确')
  assertEq(afterSetup.ignorePatterns, ORDERED_IGNORE, '初始 ignorePatterns 顺序设置正确')

  const exp = configBackup.exportBackup('顺序敏感备份')
  assert(fs.existsSync(exp.path), '备份文件已写出')
  const backupOnDisk = JSON.parse(fs.readFileSync(exp.path, 'utf-8'))
  assertEq(backupOnDisk.config.keywords.feature, ORDERED_FEATURE, '备份文件中的 feature 顺序与内存一致')
  assertEq(backupOnDisk.config.keywords.fix, ORDERED_FIX, '备份文件中的 fix 顺序与内存一致')
  assertEq(backupOnDisk.config.ignorePatterns, ORDERED_IGNORE, '备份文件中的 ignorePatterns 顺序与内存一致')

  const MODIFIED_FEATURE = ['modified-a', 'modified-b']
  const MODIFIED_FIX = ['modified-fix']
  const MODIFIED_IGNORE = ['^MODIFIED']
  let cfg2 = config.get()
  cfg2.keywords.feature = [...MODIFIED_FEATURE]
  cfg2.keywords.fix = [...MODIFIED_FIX]
  cfg2.ignorePatterns = [...MODIFIED_IGNORE]
  config.update({ keywords: cfg2.keywords, ignorePatterns: cfg2.ignorePatterns })
  const afterModify = config.get()
  assertEq(afterModify.keywords.feature, MODIFIED_FEATURE, '修改后 feature 顺序已更新')
  assertEq(afterModify.keywords.fix, MODIFIED_FIX, '修改后 fix 顺序已更新')
  assertEq(afterModify.ignorePatterns, MODIFIED_IGNORE, '修改后 ignorePatterns 顺序已更新')

  const rest = configBackup.importBackupFromFile(exp.path)
  assert(rest.success === true, '恢复备份 success')
  const afterRestore = config.get()
  assertEq(afterRestore.keywords.feature, ORDERED_FEATURE, '恢复后 feature 顺序字节级等于备份（Bug 1 回归点）')
  assertEq(afterRestore.keywords.fix, ORDERED_FIX, '恢复后 fix 顺序字节级等于备份（Bug 1 回归点）')
  assertEq(afterRestore.ignorePatterns, ORDERED_IGNORE, '恢复后 ignorePatterns 顺序字节级等于备份（Bug 1 回归点）')

  const peek = configBackup.peekRestoreUndo()
  assert(peek !== null, '撤销快照存在')
  assertEq(peek.previousConfig.keywords.feature, MODIFIED_FEATURE, '撤销快照中 feature 顺序是修改后的值（Bug 4 回归点）')
  assertEq(peek.previousConfig.keywords.fix, MODIFIED_FIX, '撤销快照中 fix 顺序是修改后的值（Bug 4 回归点）')
  assertEq(peek.previousConfig.ignorePatterns, MODIFIED_IGNORE, '撤销快照中 ignorePatterns 顺序是修改后的值（Bug 4 回归点）')

  const undo = configBackup.undoLastRestore()
  assert(undo.success === true, '撤销恢复 success')
  const afterUndo = config.get()
  assertEq(afterUndo.keywords.feature, MODIFIED_FEATURE, '撤销后 feature 精确回到修改后顺序（Bug 1+4 回归点）')
  assertEq(afterUndo.keywords.fix, MODIFIED_FIX, '撤销后 fix 精确回到修改后顺序（Bug 1+4 回归点）')
  assertEq(afterUndo.ignorePatterns, MODIFIED_IGNORE, '撤销后 ignorePatterns 精确回到修改后顺序（Bug 1+4 回归点）')

  delete require.cache[require.resolve('../src/config')]
  delete require.cache[require.resolve('../src/store')]
  const configReboot = require('../src/config')
  const storeReboot = require('../src/store')
  const rebootCfg = configReboot.get()
  assertEq(rebootCfg.keywords.feature, MODIFIED_FEATURE, '模拟重启后 feature 顺序仍精确等于撤销后的值')
  assertEq(rebootCfg.keywords.fix, MODIFIED_FIX, '模拟重启后 fix 顺序仍精确等于撤销后的值')
  assertEq(rebootCfg.ignorePatterns, MODIFIED_IGNORE, '模拟重启后 ignorePatterns 顺序仍精确等于撤销后的值')
  const rebootRaw = storeReboot.loadConfig()
  assertEq(rebootRaw.keywords.feature, MODIFIED_FEATURE, '直接读磁盘 config.json 的 feature 顺序一致')
  assertEq(rebootRaw.keywords.fix, MODIFIED_FIX, '直接读磁盘 config.json 的 fix 顺序一致')
  assertEq(rebootRaw.ignorePatterns, MODIFIED_IGNORE, '直接读磁盘 config.json 的 ignorePatterns 顺序一致')

  console.log('\n【Bug 3】只改关键字内容的备份居然还能被校验成通过')
  console.log('  场景: 导出备份 → 篡改 keywords.feature 内容但保留旧 checksum → 结构校验必须给出"校验和不匹配"警告，且不得出现"校验和验证通过"')
  cleanupAll()
  config.reset()
  const exp2 = configBackup.exportBackup('篡改关键字测试')
  const tampered = JSON.parse(fs.readFileSync(exp2.path, 'utf-8'))
  tampered.config.keywords.feature = ['完全篡改不存在的关键字', '另一个假值']
  const tmpTampered = path.join(os.tmpdir(), `tampered-kw-${Date.now()}.json`)
  fs.writeFileSync(tmpTampered, JSON.stringify(tampered), 'utf-8')
  const val = configBackup.validateBackupStructure(tampered)
  assert(val.valid === true, '结构仍然合法（只是内容被篡改）')
  assert(val.warnings.length >= 1, '至少有一条警告')
  assert(val.warnings.some(w => w.includes('校验和不匹配')), '警告中明确提到校验和不匹配（Bug 3 回归点）')
  assert(!val.info.some(i => i.includes('校验和验证通过')), 'info 中不应出现"校验和验证通过"')
  fs.unlinkSync(tmpTampered)

  console.log('\n【Bug 3 强化】computeChecksum 正确覆盖 keywords 全部层级内容')
  console.log('  场景: 只改 keywords 里的单个字符串或追加数组元素 → checksum 必须变化')
  cleanupAll()
  config.reset()
  const cfgA = config.get()
  const sumA = computeChecksum(cfgA)
  const cfgB = JSON.parse(JSON.stringify(cfgA))
  cfgB.keywords.feature = [cfgB.keywords.feature[0] + 'X']
  const sumB = computeChecksum(cfgB)
  assert(sumA !== sumB, '仅改 keywords.feature 的一个元素后校验和必须不同（Bug 3 根因回归点）')
  const cfgC = JSON.parse(JSON.stringify(cfgA))
  cfgC.keywords.fix.push('额外项')
  const sumC = computeChecksum(cfgC)
  assert(sumA !== sumC, '仅向 keywords.fix 追加一项后校验和必须不同')
  const cfgD = JSON.parse(JSON.stringify(cfgA))
  cfgD.ignorePatterns.push('^X-PATTERN')
  const sumD = computeChecksum(cfgD)
  assert(sumA !== sumD, '仅向 ignorePatterns 追加一项后校验和必须不同')

  console.log('\n【Bug 1 根因强化】detectConflict 不能污染传入对象')
  console.log('  场景: 准备两份独立配置（含关键字顺序） → 调 detectConflict → 原对象必须字节级不变')
  const a = {
    ticketPattern: 'A', versionPattern: 'A', versionPrefix: 'A',
    keywords: { feature: ['z', 'a', 'm'], fix: ['x'], breaking: [] },
    ignorePatterns: ['Z', 'A']
  }
  const b = {
    ticketPattern: 'B', versionPattern: 'B', versionPrefix: 'B',
    keywords: { feature: ['z', 'a', 'm'], fix: ['y'], breaking: [] },
    ignorePatterns: ['Z', 'A']
  }
  const aBefore = JSON.stringify(a)
  const bBefore = JSON.stringify(b)
  const conflictRes = detectConflict(b, a)
  assert(conflictRes.hasConflict === true, '确实检测到差异')
  assertEq(JSON.stringify(a), aBefore, 'detectConflict 调用后 a 对象字节级不变（Bug 1 根因回归点）')
  assertEq(JSON.stringify(b), bBefore, 'detectConflict 调用后 b 对象字节级不变（Bug 1 根因回归点）')

  console.log('\n【不破坏现有功能】导入、归档、Markdown 导出')
  cleanupAll()
  config.reset()
  store.saveCommits([])
  store.saveArchives([])
  const importer = require('../src/importer')
  const classifier = require('../src/classifier')
  const validator = require('../src/validator')
  const reviewer = require('../src/reviewer')
  const archiver = require('../src/archiver')
  const exporter = require('../src/exporter')
  const ir = importer.importFromCsv('sample.csv')
  assert(ir.added === 5, 'CSV 导入新增 5 条')
  const cr = classifier.classify()
  assert(cr.feature >= 1 && cr.fix >= 1 && cr.breaking >= 1, '三分类均有结果')
  const commits = store.loadCommits()
  for (const c of commits) {
    if (c.category === 'ignored') continue
    if (c.message.includes('更新 API 文档')) reviewer.setTicket(c.id, 'PROJ-104')
    reviewer.review(c.id, '回归测试备注')
  }
  const vr = validator.validate()
  assert(vr.errors.length === 0, '无校验错误')
  const ar = archiver.archive('v9.8.7')
  assert(ar.commitCount >= 3, '归档至少 3 条')
  const md = exporter.generateMarkdown('v9.8.7')
  assert(typeof md === 'string' && md.length > 0, 'Markdown 导出生成内容')
  assert(md.includes('##'), 'Markdown 含标题')
  assert(md.includes('回归测试备注'), 'Markdown 含人工备注')

  cleanupAll()
  console.log(`\n========== Bug 回归测试汇总: 通过 ${pass} / ${pass + fail} ==========`)
  if (fail > 0) process.exit(1)
}

runTests()
