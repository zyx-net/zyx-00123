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

  // ===================== 新功能测试开始 =====================
  const { diffArrays, getFieldValue, setFieldValue, buildRestoredConfig } = configBackup._testExports
  const computeDetailedDiff = configBackup.computeDetailedDiff

  console.log('\n====== 新功能 回归验证 ======\n')

  console.log('【新功能 1】computeDetailedDiff 逐项差异对比')
  console.log('  场景: 构造两份差异配置 → 逐字段对比 → 校验每个字段的差异标记、数组增减项、changed 字段')
  cleanupAll()
  config.reset()
  const cfgBackup = {
    ticketPattern: 'TICKET-[0-9]+',
    versionPattern: '^v[0-9]+',
    versionPrefix: 'V',
    keywords: { feature: ['feat', 'add'], fix: ['bugfix'], breaking: ['break', 'remove'] },
    ignorePatterns: ['^Merge', '^Revert']
  }
  const cfgCurrent = {
    ticketPattern: 'TICKET-[0-9]+',
    versionPattern: '^v[0-9]+\\.[0-9]+',
    versionPrefix: 'v',
    keywords: { feature: ['feat', 'feature', '新增'], fix: ['bugfix'], breaking: ['break'] },
    ignorePatterns: ['^Merge']
  }
  const diff1 = computeDetailedDiff(cfgBackup, cfgCurrent)
  assert(Array.isArray(diff1.fields), 'diff1 返回 fields 数组')
  assert(diff1.fields.length === 7, '覆盖全部 7 个可选字段')
  assert(diff1.hasChanges === true, '检测到存在差异')
  const f_ticket = diff1.fields.find(f => f.field === 'ticketPattern')
  assert(f_ticket.changed === false, 'ticketPattern 一致')
  const f_version = diff1.fields.find(f => f.field === 'versionPattern')
  assert(f_version.changed === true, 'versionPattern 检测到差异')
  assert(f_version.isArray === false, 'versionPattern 不是数组')
  const f_feature = diff1.fields.find(f => f.field === 'keywords.feature')
  assert(f_feature.changed === true, 'keywords.feature 检测到差异')
  assert(f_feature.isArray === true, 'keywords.feature 是数组')
  assert(f_feature.removed.includes('add'), 'feature 差异中 add 将被恢复（备份中有 add，当前中没有）')
  assert(f_feature.added.includes('feature'), 'feature 差异中 feature 是当前新增（将被移除）')
  assert(f_feature.added.includes('新增'), 'feature 差异中 新增 是当前新增（将被移除）')
  const f_ignore = diff1.fields.find(f => f.field === 'ignorePatterns')
  assert(f_ignore.removed.includes('^Revert'), 'ignorePatterns 差异中 ^Revert 将被恢复')
  assert(diff1.changedFields.includes('versionPattern'), 'changedFields 包含 versionPattern')
  assert(diff1.changedFields.includes('keywords.feature'), 'changedFields 包含 keywords.feature')
  assert(!diff1.changedFields.includes('ticketPattern'), 'changedFields 不包含 ticketPattern')

  console.log('\n【新功能 2】diffBackupFromFile 差异对比 API')
  console.log('  场景: 导出备份 → 修改配置 → diffBackupFromFile → 校验返回 success、差异和冲突信息')
  cleanupAll()
  config.reset()
  const expA = configBackup.exportBackup('差异测试备份')
  const cfgM = config.get()
  cfgM.ticketPattern = 'DIFF-TEST'
  cfgM.keywords.feature.push('测试关键字')
  cfgM.ignorePatterns.push('^DIFF-ONLY')
  config.update({ ticketPattern: cfgM.ticketPattern, keywords: cfgM.keywords, ignorePatterns: cfgM.ignorePatterns })
  const diffR = configBackup.diffBackupFromFile(expA.path)
  assert(diffR.success === true, 'diffBackupFromFile 返回 success')
  assert(diffR.valid === true, '备份结构合法')
  assert(diffR.detailedDiff.hasChanges === true, '检测到差异')
  assert(diffR.conflict.hasConflict === true, '检测到冲突')
  assert(Array.isArray(diffR.selectableFields), '返回 selectableFields 列表')
  assert(diffR.selectableFields.length === 7, 'selectableFields 共 7 个')

  console.log('\n【新功能 3】按项恢复 — 仅恢复选中的字段')
  console.log('  场景: 导出备份 → 修改多字段 → 仅恢复 keywords.feature 和 ignorePatterns → 校验仅这两字段回到备份值，其他字段保留修改值')
  cleanupAll()
  config.reset()
  const expP = configBackup.exportBackup('按项恢复备份')
  const backupOnDiskP = JSON.parse(fs.readFileSync(expP.path, 'utf-8'))
  const origCfg = backupOnDiskP.config
  const cfg3 = config.get()
  cfg3.ticketPattern = 'CHANGED-PATTERN'
  cfg3.versionPrefix = 'CHANGED-PREFIX'
  cfg3.keywords.feature = ['改后', 'modified-feat']
  cfg3.ignorePatterns = ['^MODIFIED']
  config.update({ ticketPattern: cfg3.ticketPattern, versionPrefix: cfg3.versionPrefix, keywords: cfg3.keywords, ignorePatterns: cfg3.ignorePatterns })
  const partialR = configBackup.importBackupFromFile(expP.path, { fields: ['keywords.feature', 'ignorePatterns'] })
  assert(partialR.success === true, '按项恢复 success')
  assert(partialR.isPartial === true, '标记为按项恢复')
  assert(partialR.selectedFields.includes('keywords.feature'), '选中 keywords.feature')
  assert(partialR.selectedFields.includes('ignorePatterns'), '选中 ignorePatterns')
  const cfgAfterPartial = config.get()
  assert(cfgAfterPartial.ticketPattern === 'CHANGED-PATTERN', 'ticketPattern 保留修改值（未选中未恢复）')
  assert(cfgAfterPartial.versionPrefix === 'CHANGED-PREFIX', 'versionPrefix 保留修改值（未选中未恢复）')
  assertEq(cfgAfterPartial.keywords.feature, origCfg.keywords.feature, 'keywords.feature 已恢复为备份值')
  assertEq(cfgAfterPartial.ignorePatterns, origCfg.ignorePatterns, 'ignorePatterns 已恢复为备份值')

  console.log('\n【新功能 4】按项恢复 — 撤销')
  console.log('  场景: 按项恢复后 → 撤销 → 校验所有字段回到按项恢复前的完整状态')
  const peek4 = configBackup.peekRestoreUndo()
  assert(peek4 !== null, '按项恢复后撤销快照存在')
  assert(peek4.isPartial === true, '撤销快照标记为按项恢复')
  assert(peek4.selectedFields.includes('keywords.feature'), '快照记录了选中字段')
  const undo4 = configBackup.undoLastRestore()
  assert(undo4.success === true, '按项恢复撤销 success')
  assert(undo4.isPartial === true, '撤销结果中 isPartial 标记')
  const cfgAfterUndo4 = config.get()
  assert(cfgAfterUndo4.ticketPattern === 'CHANGED-PATTERN', '撤销后 ticketPattern 回到修改值')
  assert(cfgAfterUndo4.versionPrefix === 'CHANGED-PREFIX', '撤销后 versionPrefix 回到修改值')
  assertEq(cfgAfterUndo4.keywords.feature, ['改后', 'modified-feat'], '撤销后 keywords.feature 回到修改值')
  assertEq(cfgAfterUndo4.ignorePatterns, ['^MODIFIED'], '撤销后 ignorePatterns 回到修改值')

  console.log('\n【新功能 5】按项恢复 — 冲突提示')
  console.log('  场景: 导出备份 → 修改字段 → 按项恢复含冲突字段 → 校验 warnings 含冲突字段提示')
  cleanupAll()
  config.reset()
  const exp5 = configBackup.exportBackup('冲突提示测试')
  const cfg5 = config.get()
  cfg5.ticketPattern = 'CONFLICT-TEST'
  cfg5.keywords.feature = ['冲突后 feat 改']
  cfg5.ignorePatterns = ['^CONFLICT']
  config.update({ ticketPattern: cfg5.ticketPattern, keywords: cfg5.keywords, ignorePatterns: cfg5.ignorePatterns })
  const partialR5 = configBackup.importBackupFromFile(exp5.path, { fields: ['ticketPattern', 'keywords.feature'] })
  assert(partialR5.warnings.some(w => w.includes('冲突') || w.includes('已被修改')), 'warnings 中包含冲突提示')
  assert(partialR5.warnings.some(w => w.includes('ticketPattern')), 'warnings 中列出具体冲突字段 ticketPattern')
  assert(partialR5.warnings.some(w => w.includes('keywords.feature')), 'warnings 中列出具体冲突字段 keywords.feature')

  console.log('\n【新功能 6】恢复日志持久化（跨重启保留）')
  console.log('  场景: 整包恢复、按项恢复、撤销 → 读取日志 → 跨 require 缓存清除重新读取仍存在')
  cleanupAll()
  config.reset()
  store.clearRestoreLogs()
  const exp6 = configBackup.exportBackup('日志测试')
  config.update({ ticketPattern: 'LOG-TEST' })
  configBackup.importBackupFromFile(exp6.path)
  config.update({ ticketPattern: 'LOG-TEST2', ignorePatterns: ['^LOG'] })
  configBackup.importBackupFromFile(exp6.path, { fields: ['ignorePatterns'] })
  configBackup.undoLastRestore()
  const logs6a = configBackup.listRestoreLogs(20)
  assert(logs6a.length >= 3, '至少有 3 条日志（整包+按项+撤销）')
  assert(logs6a[0].action === 'undo_restore', '最新一条是撤销操作')
  assert(logs6a[1].action === 'partial_restore', '第二条是按项恢复')
  assert(logs6a[2].action === 'full_restore', '第三条是整包恢复')
  assert(typeof logs6a[2].backupId === 'string', '日志中包含 backupId')
  delete require.cache[require.resolve('../src/store')]
  delete require.cache[require.resolve('../src/configBackup')]
  const storeReboot6 = require('../src/store')
  const configBackupReboot6 = require('../src/configBackup')
  const logs6b = configBackupReboot6.listRestoreLogs(20)
  assert(logs6b.length >= 3, '模拟重启后日志数量不变（跨重启保留）')
  assertEq(logs6b.map(l => l.action), logs6a.map(l => l.action), '模拟重启后日志内容一致')

  console.log('\n【新功能 7】部分恢复撤销后重启重读磁盘与内存一致')
  console.log('  场景: 按项恢复 → 撤销 → 模拟重启 → 校验内存与磁盘一致')
  cleanupAll()
  config.reset()
  const exp7 = configBackup.exportBackup('重启一致测试')
  const cfg7b = config.get()
  cfg7b.ticketPattern = 'REBOOT-TEST'
  cfg7b.keywords.feature = ['重启后 feat']
  cfg7b.ignorePatterns = ['^REBOOT']
  config.update({ ticketPattern: cfg7b.ticketPattern, keywords: cfg7b.keywords, ignorePatterns: cfg7b.ignorePatterns })
  configBackup.importBackupFromFile(exp7.path, { fields: ['keywords.feature'] })
  configBackup.undoLastRestore()
  delete require.cache[require.resolve('../src/config')]
  delete require.cache[require.resolve('../src/store')]
  const configR7 = require('../src/config')
  const storeR7 = require('../src/store')
  const rebootCfg7 = configR7.get()
  assert(rebootCfg7.ticketPattern === 'REBOOT-TEST', '重启后 ticketPattern 是撤销后的值')
  assertEq(rebootCfg7.keywords.feature, ['重启后 feat'], '重启后 keywords.feature 是撤销后的值')
  assertEq(rebootCfg7.ignorePatterns, ['^REBOOT'], '重启后 ignorePatterns 是撤销后的值')
  const raw7 = storeR7.loadConfig()
  assert(raw7.ticketPattern === 'REBOOT-TEST', '磁盘 ticketPattern 与内存一致')
  assertEq(raw7.keywords.feature, ['重启后 feat'], '磁盘 keywords.feature 与内存一致')
  assertEq(raw7.ignorePatterns, ['^REBOOT'], '磁盘 ignorePatterns 与内存一致')

  console.log('\n【新功能 8】diffBackup 直接从备份数据（不从文件）')
  console.log('  场景: 构造备份对象 → diffBackup → 返回差异信息')
  cleanupAll()
  config.reset()
  const bd = configBackup.exportBackup('diffBackup 对象')
  const bkData = JSON.parse(fs.readFileSync(bd.path, 'utf-8'))
  config.update({ ticketPattern: 'OBJ-DIFF', versionPrefix: 'OD' })
  const d8 = configBackup.diffBackup(bkData)
  assert(d8.valid === true, 'diffBackup valid 合法')
  assert(d8.detailedDiff.hasChanges === true, '检测到差异')
  assert(d8.conflict.hasConflict === true, '检测到冲突')

  console.log('\n【新功能 9】buildRestoredConfig 只合并选中字段')
  console.log('  场景: 备份与当前不同 → buildRestoredConfig 选 2 个字段 → 其他字段保留当前值')
  cleanupAll()
  config.reset()
  const bCfg = JSON.parse(JSON.stringify(config.get()))
  bCfg.ticketPattern = 'BUILD-TEST'
  bCfg.versionPrefix = 'BT'
  bCfg.keywords.feature = ['build-feat']
  bCfg.ignorePatterns = ['^BUILD']
  const curCfg = JSON.parse(JSON.stringify(config.get()))
  curCfg.ticketPattern = 'CURRENT-PATTERN'
  curCfg.versionPrefix = 'CURRENT-PREFIX'
  curCfg.keywords.fix = ['current-fix']
  const merged = buildRestoredConfig(bCfg, ['ticketPattern', 'keywords.feature'], curCfg)
  assert(merged.ticketPattern === 'BUILD-TEST', '合并后 ticketPattern 为备份值')
  assert(merged.versionPrefix === 'CURRENT-PREFIX', '合并后 versionPrefix 为当前值（未选）')
  assertEq(merged.keywords.feature, ['build-feat'], '合并后 keywords.feature 为备份值')
  assertEq(merged.keywords.fix, ['current-fix'], '合并后 keywords.fix 为当前值（未选）')
  assertEq(merged.ignorePatterns, curCfg.ignorePatterns, '合并后 ignorePatterns 为当前值（未选）')

  console.log('\n【新功能 10】按项恢复 — 选中无差异字段时自动跳过')
  console.log('  场景: 仅选中与当前配置无差异字段 → 返回 skipped 且无实际写入')
  cleanupAll()
  config.reset()
  const exp10 = configBackup.exportBackup('无差异测试')
  config.update({ ticketPattern: 'ONLY-CHANGED' })
  const r10 = configBackup.importBackupFromFile(exp10.path, { fields: ['versionPrefix'] })
  assert(r10.success === true, 'success 成功返回')
  assert(r10.skipped === true, 'skipped 跳过')
  assert(r10.reason === 'no_changes_in_selected_fields', 'reason 为无差异')
  const cfg10after = config.get()
  assert(cfg10after.ticketPattern === 'ONLY-CHANGED', '配置未变（ticketPattern 保持修改值）')

  console.log('\n【新功能 11】SELECTABLE_FIELDS 包含 7 个标准字段')
  assert(Array.isArray(configBackup.SELECTABLE_FIELDS), 'SELECTABLE_FIELDS 是数组')
  assert(configBackup.SELECTABLE_FIELDS.includes('ticketPattern'), '包含 ticketPattern')
  assert(configBackup.SELECTABLE_FIELDS.includes('keywords.feature'), '包含 keywords.feature')
  assert(configBackup.SELECTABLE_FIELDS.includes('ignorePatterns'), '包含 ignorePatterns')
  assert(configBackup.SELECTABLE_FIELDS.length === 7, '共 7 个字段')

  console.log('\n【新功能 12】CLI 帮助信息包含新命令')
  const { spawnSync } = require('child_process')
  const helpOut = spawnSync(process.execPath, ['bin/cli.js', 'help'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(helpOut.stdout.includes('config diff'), '帮助包含 config diff')
  assert(helpOut.stdout.includes('--fields'), '帮助包含 --fields')
  assert(helpOut.stdout.includes('restore-logs'), '帮助包含 restore-logs')

  console.log('\n【新功能 13】CLI config diff 命令输出')
  cleanupAll()
  config.reset()
  const exp13 = configBackup.exportBackup('CLI diff 测试')
  config.update({ ticketPattern: 'CLI-DIFF' })
  const diffOut = spawnSync(process.execPath, ['bin/cli.js', 'config', 'diff', exp13.filename], { encoding: 'utf-8', cwd: process.cwd() })
  assert(diffOut.status === 0, 'CLI diff 退出码 0')
  assert(diffOut.stdout.includes('差异'), 'CLI diff 输出包含 差异')
  assert(diffOut.stdout.includes('ticketPattern'), 'CLI diff 输出包含字段名')

  console.log('\n【新功能 14】CLI config restore --fields 按项恢复')
  cleanupAll()
  config.reset()
  const exp14 = configBackup.exportBackup('CLI 按项恢复')
  const cfg14orig = JSON.parse(JSON.stringify(config.get()))
  config.update({ ticketPattern: 'CLI-FIELDS', versionPrefix: 'CF' })
  const restoreOut = spawnSync(process.execPath, ['bin/cli.js', 'config', 'restore', exp14.filename, '--fields', 'ticketPattern'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(restoreOut.status === 0, 'CLI restore --fields 退出码 0')
  assert(restoreOut.stdout.includes('按项恢复成功'), 'CLI 输出按项恢复成功')
  const cfg14after = config.get()
  assert(cfg14after.ticketPattern === cfg14orig.ticketPattern, 'CLI 按项恢复 ticketPattern 已恢复')
  assert(cfg14after.versionPrefix === 'CF', 'CLI 按项恢复 versionPrefix 保留修改值')

  console.log('\n【新功能 15】CLI config restore-logs 命令')
  const logsOut = spawnSync(process.execPath, ['bin/cli.js', 'config', 'restore-logs'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(logsOut.status === 0, 'CLI restore-logs 退出码 0')
  assert(logsOut.stdout.includes('整包恢复') || logsOut.stdout.includes('按项恢复') || logsOut.stdout.includes('撤销恢复'), 'CLI restore-logs 输出日志操作类型')

  console.log('\n【新功能 16】备份导出校验和链路未被带坏')
  cleanupAll()
  config.reset()
  const exp16 = configBackup.exportBackup('校验和测试')
  const raw16 = JSON.parse(fs.readFileSync(exp16.path, 'utf-8'))
  const val16 = configBackup.validateBackupStructure(raw16)
  assert(val16.valid === true, '校验通过')
  assert(val16.info.some(i => i.includes('校验和验证通过')), '包含校验和验证通过')
  raw16.config.ticketPattern = 'TAMPERED'
  const val16b = configBackup.validateBackupStructure(raw16)
  assert(val16b.warnings.some(w => w.includes('校验和不匹配')), '篡改后校验和不匹配')

  console.log('\n【新功能 17】dry-run + fields 组合使用')
  cleanupAll()
  config.reset()
  const exp17 = configBackup.exportBackup('dryrun fields')
  config.update({ ticketPattern: 'DRY-FIELDS', ignorePatterns: ['^DRY'] })
  const r17 = configBackup.importBackupFromFile(exp17.path, { fields: ['ticketPattern'], dryRun: true })
  assert(r17.dryRun === true, 'dryRun 标记')
  assert(r17.isPartial === true, 'isPartial 标记')
  assert(r17.selectedFields.includes('ticketPattern'), 'selectedFields 正确')
  const cfg17after = config.get()
  assert(cfg17after.ticketPattern === 'DRY-FIELDS', 'dry-run 不修改实际配置')

  console.log('\n【新功能 18】按项恢复 — 未知字段自动忽略并产生警告')
  cleanupAll()
  config.reset()
  const exp18 = configBackup.exportBackup('未知字段测试')
  config.update({ ticketPattern: 'UNKNOWN-FIELD' })
  const r18 = configBackup.importBackupFromFile(exp18.path, { fields: ['ticketPattern', 'nonexistent.field', 'badField'] })
  assert(r18.success === true, '未知字段不导致失败')
  assert(r18.warnings.some(w => w.includes('未知字段') || w.includes('忽略未知')), 'warnings 中提到忽略未知字段')
  assert(!r18.selectedFields.includes('nonexistent.field'), 'selectedFields 过滤掉未知字段')

  console.log('\n【新功能 19】listRestoreLogs 限制条数')
  cleanupAll()
  config.reset()
  store.clearRestoreLogs()
  for (let i = 0; i < 5; i++) {
    const expT = configBackup.exportBackup('日志条数测试' + i)
    config.update({ ticketPattern: 'LOG-CNT-' + i })
    configBackup.importBackupFromFile(expT.path)
  }
  const allLogs = configBackup.listRestoreLogs(100)
  assert(allLogs.length >= 5, '至少 5 条日志')
  const twoLogs = configBackup.listRestoreLogs(2)
  assert(twoLogs.length === 2, '限制返回 2 条')
  const noLimit = configBackup.listRestoreLogs()
  assert(noLimit.length >= 5, '不传 limit 返回全部')

  console.log('\n【新功能 20】整包恢复 + 撤销 完整链路（含日志、重启）')
  cleanupAll()
  config.reset()
  store.clearRestoreLogs()
  const exp20 = configBackup.exportBackup('完整链路测试')
  const origCfg20 = JSON.parse(JSON.stringify(config.get()))
  const cfg20m = config.get()
  cfg20m.ticketPattern = 'FULL-TEST'
  cfg20m.versionPrefix = 'FT'
  cfg20m.keywords.feature = ['full', '完整功能']
  cfg20m.ignorePatterns = ['^FULL']
  config.update({ ticketPattern: cfg20m.ticketPattern, versionPrefix: cfg20m.versionPrefix, keywords: cfg20m.keywords, ignorePatterns: cfg20m.ignorePatterns })
  const fullR = configBackup.importBackupFromFile(exp20.path)
  assert(fullR.success === true, '整包恢复 success')
  assert(fullR.isPartial === false, 'isPartial=false')
  const cfg20r = config.get()
  assertEq(cfg20r.ticketPattern, origCfg20.ticketPattern, '整包恢复后 ticketPattern 一致')
  assertEq(cfg20r.versionPrefix, origCfg20.versionPrefix, '整包恢复后 versionPrefix 一致')
  assertEq(cfg20r.keywords.feature, origCfg20.keywords.feature, '整包恢复后 keywords.feature 一致')
  assertEq(cfg20r.ignorePatterns, origCfg20.ignorePatterns, '整包恢复后 ignorePatterns 一致')
  const fullUndo = configBackup.undoLastRestore()
  assert(fullUndo.success === true, '整包恢复撤销 success')
  const cfg20u = config.get()
  assert(cfg20u.ticketPattern === 'FULL-TEST', '整包撤销后 ticketPattern 回到修改值')
  const fullLogs = configBackup.listRestoreLogs(10)
  assert(fullLogs.some(l => l.action === 'full_restore'), '日志存在整包恢复记录')
  assert(fullLogs.some(l => l.action === 'undo_restore'), '日志存在撤销记录')
  delete require.cache[require.resolve('../src/config')]
  delete require.cache[require.resolve('../src/store')]
  const cfg20Reboot = require('../src/config')
  const cfg20RebootCfg = cfg20Reboot.get()
  assert(cfg20RebootCfg.ticketPattern === 'FULL-TEST', '重启后整包撤销结果保留')

  cleanupAll()
  console.log(`\n========== Bug + 新功能 回归测试汇总: 通过 ${pass} / ${pass + fail} ==========`)
  if (fail > 0) process.exit(1)
}

runTests()
