const fs = require('fs')
const path = require('path')
const os = require('os')

const store = require('../src/store')
const config = require('../src/config')
const configBackup = require('../src/configBackup')

function cleanupData() {
  const dataDir = store.DATA_DIR
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir)
    files.forEach(f => {
      const fp = path.join(dataDir, f)
      const stat = fs.statSync(fp)
      if (stat.isFile()) {
        fs.unlinkSync(fp)
      }
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
    else { fail++; console.error(`  ✗ ${msg}\n    期望: ${JSON.stringify(b)}\n    实际: ${JSON.stringify(a)}`) }
  }

  console.log('\n====== 配置备份/恢复 全链路验证 ======\n')

  cleanupData()

  console.log('1. 初始状态 - 配置是默认值')
  const initialCfg = config.get()
  assert(initialCfg.ticketPattern === '(\\w+-\\d+)', '默认 ticketPattern 正确')
  assert(Array.isArray(initialCfg.ignorePatterns), '默认 ignorePatterns 是数组')
  assert(initialCfg.keywords.feature.includes('feat'), '默认 feature 关键字包含 feat')

  console.log('\n2. 导出配置备份')
  const exportResult = configBackup.exportBackup('测试备份1')
  assert(exportResult.success === true, 'exportBackup 返回 success')
  assert(exportResult.filename.endsWith('.json'), '备份文件名以 .json 结尾')
  assert(typeof exportResult.checksum === 'string' && exportResult.checksum.length > 0, '返回了非空 checksum')
  assert(fs.existsSync(exportResult.path), '备份文件实际存在于磁盘')
  const backupFileContent = JSON.parse(fs.readFileSync(exportResult.path, 'utf-8'))
  assert(backupFileContent.schemaVersion === 1, '备份 schemaVersion 为 1')
  assert(typeof backupFileContent.backupId === 'string', '备份有 backupId')
  assert(backupFileContent.name === '测试备份1', '备份名称正确')
  assert(typeof backupFileContent.config === 'object', '备份包含 config 对象')
  assert(typeof backupFileContent.checksum === 'string', '备份包含 checksum')

  console.log('\n3. 修改当前配置，制造差异')
  config.update({
    ticketPattern: 'TICKET-[0-9]+',
    versionPrefix: 'VER-',
    ignorePatterns: ['^CUSTOM', '^TESTONLY']
  })
  const kw = config.get().keywords
  kw.feature = ['custom-feat']
  config.update({ keywords: kw })
  const modifiedCfg = config.get()
  assert(modifiedCfg.ticketPattern === 'TICKET-[0-9]+', 'ticketPattern 已修改')
  assert(modifiedCfg.versionPrefix === 'VER-', 'versionPrefix 已修改')
  assertEq(modifiedCfg.keywords.feature, ['custom-feat'], 'feature 关键字已修改')

  console.log('\n4. 列出备份文件')
  const backupList = configBackup.listBackups()
  assert(Array.isArray(backupList), 'listBackups 返回数组')
  assert(backupList.length >= 1, '至少有一个备份')
  assert(backupList[0].filename.includes(exportResult.backupId), '列表包含刚才导出的备份')

  console.log('\n5. dry-run 导入备份，不应实际修改')
  const dryRunResult = configBackup.importBackupFromFile(exportResult.path, { dryRun: true })
  assert(dryRunResult.success === true, 'dry-run 导入 success')
  assert(dryRunResult.dryRun === true, '返回 dryRun 标记')
  assert(Array.isArray(dryRunResult.wouldApply), '返回 wouldApply 差异列表')
  assert(dryRunResult.wouldApply.length > 0, '检测到至少一处差异')
  const cfgAfterDry = config.get()
  assertEq(cfgAfterDry.ticketPattern, 'TICKET-[0-9]+', 'dry-run 后实际 ticketPattern 未变')
  assertEq(cfgAfterDry.keywords.feature, ['custom-feat'], 'dry-run 后实际关键字未变')

  console.log('\n6. 实际导入备份恢复配置')
  const restoreResult = configBackup.importBackupFromFile(exportResult.path, { force: true })
  assert(restoreResult.success === true, '导入 success')
  assert(restoreResult.skipped !== true, '不是跳过状态')
  assert(Array.isArray(restoreResult.changes), '返回 changes 列表')
  assert(restoreResult.changes.length > 0, '至少报告一处变更')
  const restoredCfg = config.get()
  assertEq(restoredCfg.ticketPattern, '(\\w+-\\d+)', '恢复后 ticketPattern 与备份一致')
  assertEq(restoredCfg.versionPrefix, 'v', '恢复后 versionPrefix 与备份一致')
  assert(restoredCfg.keywords.feature.includes('feat'), '恢复后 feature 关键字与备份一致')
  assertEq(restoredCfg.ignorePatterns, ['^Merge', '^Revert', '^WIP', '^chore:', '^ci:'], '恢复后 ignorePatterns 与备份一致')

  console.log('\n7. 检查恢复撤销快照是否存在')
  const undoSnap = configBackup.peekRestoreUndo()
  assert(undoSnap !== null, 'peekRestoreUndo 返回非空')
  assert(typeof undoSnap.previousConfig === 'object', 'undo 快照包含 previousConfig')
  assert(undoSnap.previousConfig.ticketPattern === 'TICKET-[0-9]+', 'undo 快照保留了恢复前的配置')
  assert(typeof undoSnap.restoredConfig === 'object', 'undo 快照包含 restoredConfig')

  console.log('\n8. 撤销最近一次恢复')
  const undoResult = configBackup.undoLastRestore()
  assert(undoResult.success === true, 'undo success')
  const undoneCfg = config.get()
  assertEq(undoneCfg.ticketPattern, 'TICKET-[0-9]+', '撤销后 ticketPattern 回到修改后的值')
  assertEq(undoneCfg.versionPrefix, 'VER-', '撤销后 versionPrefix 回到修改后的值')
  assertEq(undoneCfg.keywords.feature, ['custom-feat'], '撤销后关键字回到修改后的值')
  const undoSnapAfter = configBackup.peekRestoreUndo()
  assert(undoSnapAfter === null, '撤销后 peek 为空')

  console.log('\n9. 重复导入同一份备份 - 先恢复到一致状态，再重复导入应跳过')
  const restoreResult9a = configBackup.importBackupFromFile(exportResult.path, { force: true })
  assert(restoreResult9a.success === true, '第1次导入 success')
  const restoreResult9b = configBackup.importBackupFromFile(exportResult.path)
  assert(restoreResult9b.success === true, '第2次重复导入 success')
  assert(restoreResult9b.skipped === true, '重复导入返回 skipped=true')
  assert(restoreResult9b.reason === 'duplicate_no_change', '重复导入 reason 正确')

  console.log('\n10. force=true 可强制重复导入')
  const restoreResult3 = configBackup.importBackupFromFile(exportResult.path, { force: true })
  assert(restoreResult3.success === true, 'force 导入 success')
  assert(restoreResult3.skipped !== true, 'force 导入不会被跳过')
  const forceCfg = config.get()
  assertEq(forceCfg.ticketPattern, '(\\w+-\\d+)', 'force 导入后配置已恢复')

  console.log('\n11. 测试坏格式 - 非 JSON 文件')
  const tmpBadJson = path.join(os.tmpdir(), `bad-backup-${Date.now()}.json`)
  fs.writeFileSync(tmpBadJson, '{ this is not json [[', 'utf-8')
  const badJsonResult = configBackup.importBackupFromFile(tmpBadJson)
  assert(badJsonResult.success === false, '坏 JSON 导入失败')
  assert(badJsonResult.errors.some(e => e.includes('JSON')), '错误信息提到 JSON')
  fs.unlinkSync(tmpBadJson)

  console.log('\n12. 测试缺字段')
  const missingFields = {
    schemaVersion: 1,
    backupId: 'test-missing',
    config: {
      ticketPattern: 'a'
    }
  }
  const tmpMissing = path.join(os.tmpdir(), `missing-backup-${Date.now()}.json`)
  fs.writeFileSync(tmpMissing, JSON.stringify(missingFields), 'utf-8')
  const missingResult = configBackup.importBackupFromFile(tmpMissing)
  assert(missingResult.success === false, '缺字段导入失败')
  assert(missingResult.errors.length > 0, '至少返回一个错误')
  assert(missingResult.errors.some(e => e.includes('缺少必要字段')), '错误提到缺少字段')
  fs.unlinkSync(tmpMissing)

  console.log('\n13. 测试未知键 - 应警告但允许导入')
  const backupWithUnknown = JSON.parse(JSON.stringify(backupFileContent))
  backupWithUnknown.config.extraField = 'should-be-ignored'
  backupWithUnknown.config.keywords.extraCategory = ['xxx']
  const tmpUnknown = path.join(os.tmpdir(), `unknown-backup-${Date.now()}.json`)
  fs.writeFileSync(tmpUnknown, JSON.stringify(backupWithUnknown), 'utf-8')
  const unknownResult = configBackup.importBackupFromFile(tmpUnknown)
  assert(unknownResult.success === true, '含未知键的备份导入成功')
  assert(unknownResult.warnings.some(w => w.includes('未知键')), '有未知键警告')
  assert(unknownResult.warnings.some(w => w.includes('未知分类')), '有未知分类警告')
  fs.unlinkSync(tmpUnknown)

  console.log('\n14. 导入失败时不应破坏原配置')
  const cfgBeforeBad = JSON.parse(JSON.stringify(config.get()))
  const tmpInvalidRegex = path.join(os.tmpdir(), `bad-regex-${Date.now()}.json`)
  const badRegexBackup = JSON.parse(JSON.stringify(backupFileContent))
  badRegexBackup.config.ticketPattern = '[invalid-regex('
  fs.writeFileSync(tmpInvalidRegex, JSON.stringify(badRegexBackup), 'utf-8')
  const badRegexResult = configBackup.importBackupFromFile(tmpInvalidRegex)
  assert(badRegexResult.success === false, '非法正则导入失败')
  const cfgAfterBad = config.get()
  assertEq(cfgAfterBad, cfgBeforeBad, '导入失败后原配置保持不变')
  fs.unlinkSync(tmpInvalidRegex)

  console.log('\n15. 校验和不匹配应警告')
  const tampered = JSON.parse(JSON.stringify(backupFileContent))
  tampered.config.ticketPattern = 'TAMPERED'
  const tmpTampered = path.join(os.tmpdir(), `tampered-${Date.now()}.json`)
  fs.writeFileSync(tmpTampered, JSON.stringify(tampered), 'utf-8')
  const tamperedResult = configBackup.importBackupFromFile(tmpTampered, { force: true })
  assert(tamperedResult.success === true, '篡改内容的备份仍可导入')
  assert(tamperedResult.warnings.some(w => w.includes('校验和不匹配')), '有校验和不匹配警告')
  fs.unlinkSync(tmpTampered)

  console.log('\n16. 导出到自定义路径')
  const customPath = path.join(os.tmpdir(), `custom-backup-${Date.now()}.json`)
  const customExport = configBackup.exportBackupToCustomPath(customPath, '自定义导出')
  assert(customExport.success === true, '自定义路径导出 success')
  assert(customExport.path === customPath, '导出到了指定路径')
  assert(fs.existsSync(customPath), '文件确实存在')
  const parsedCustom = JSON.parse(fs.readFileSync(customPath, 'utf-8'))
  assert(parsedCustom.name === '自定义导出', '自定义名称保存正确')
  fs.unlinkSync(customPath)

  console.log('\n17. 删除备份')
  const toDelete = configBackup.exportBackup('待删除')
  assert(fs.existsSync(toDelete.path), '删除前文件存在')
  const delResult = configBackup.deleteBackup(toDelete.filename)
  assert(delResult.success === true, 'deleteBackup 返回 success')
  assert(!fs.existsSync(toDelete.path), '删除后文件不存在')

  console.log('\n18. CLI 和 Web 共享同一份配置 - 直接读写 store')
  config.reset()
  const cfgFromStore = store.loadConfig()
  const cfgFromModule = config.get()
  assertEq(cfgFromStore, cfgFromModule, 'store 读取与 config.get() 结果一致')
  config.update({ ticketPattern: 'SHARED-TEST' })
  const cfgFromStore2 = store.loadConfig()
  assert(cfgFromStore2.ticketPattern === 'SHARED-TEST', 'config.update 后 store 读取到最新值')
  config.reset()

  console.log('\n19. validateBackupStructure 函数')
  const v1 = configBackup.validateBackupStructure(null)
  assert(v1.valid === false, 'null 输入验证失败')
  const v2 = configBackup.validateBackupStructure(backupFileContent)
  assert(v2.valid === true, '合法备份验证通过')
  assert(v2.info.some(i => i.includes('校验和验证通过')), 'info 包含校验和通过')

  console.log('\n20. 不破坏已有导入、归档和 Markdown 导出 - 集成验证')
  config.reset()
  const importer = require('../src/importer')
  const classifier = require('../src/classifier')
  const validator = require('../src/validator')
  const reviewer = require('../src/reviewer')
  const archiver = require('../src/archiver')
  const exporter = require('../src/exporter')
  store.saveCommits([])
  store.saveArchives([])
  const impRes = importer.importFromCsv('sample.csv')
  assert(impRes.added === 5, 'CSV 导入新增 5 条')
  const classRes = classifier.classify()
  assert(classRes.feature >= 1, '分类得到 feature')
  assert(classRes.fix >= 1, '分类得到 fix')
  assert(classRes.breaking >= 1, '分类得到 breaking')
  const commits = store.loadCommits()
  for (const c of commits) {
    if (c.category === 'ignored') continue
    if (c.message.includes('更新 API 文档')) {
      reviewer.setTicket(c.id, 'PROJ-104')
    }
    reviewer.review(c.id, '集成测试备注')
  }
  const valRes = validator.validate()
  assert(valRes.errors.length === 0, '复核后无校验错误')
  try {
    const archiveRes = archiver.archive('v9.9.9')
    assert(archiveRes.commitCount >= 3, '归档至少 3 条')
    const md = exporter.generateMarkdown('v9.9.9')
    assert(typeof md === 'string' && md.length > 0, 'Markdown 导出生成了内容')
    assert(md.includes('##'), 'Markdown 含标题')
    assert(md.includes('集成测试备注'), 'Markdown 含人工备注')
  } catch (e) {
    assert(false, `归档/导出异常: ${e.message}`)
  }

  cleanupData()

  console.log(`\n========== 配置备份/恢复 测试汇总: 通过 ${pass} / ${pass + fail} ==========`)
  if (fail > 0) {
    process.exit(1)
  }
}

runTests()
