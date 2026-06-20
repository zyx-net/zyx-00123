const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const draft = require('../src/draft')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const config = require('../src/config')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')

function cleanTestData() {
  const files = ['commits', 'archives', 'drafts', 'draft_logs', 'draft_undo', 'draft_undo_stack', 'undo', 'config',
    'version_registry', 'version_registry_logs', 'version_registry_undo']
  files.forEach(f => {
    const fp = path.join(TEST_DATA_DIR, `${f}.json`)
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp)
    }
  })
}

function runTest(name, fn) {
  try {
    fn()
    console.log(`\u2713 ${name}`)
  } catch (e) {
    console.error(`\u2717 ${name}`)
    console.error(`  Error: ${e.message}`)
    throw e
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

function setupTestCommits() {
  const commits = [
    { id: 'c1', message: 'feat: 新增用户管理模块', category: 'feature', source: 'test', author: '张三', date: '2025-01-15', reviewed: true, ticket: 'PROJ-101', issues: [], resolved: true },
    { id: 'c2', message: 'fix: 修复登录超时问题', category: 'fix', source: 'test', author: '李四', date: '2025-01-16', reviewed: true, ticket: 'PROJ-102', issues: [], resolved: true },
    { id: 'c3', message: 'breaking: 移除旧版 REST API', category: 'breaking', source: 'test', author: '王五', date: '2025-01-17', reviewed: true, ticket: 'PROJ-103', issues: [], resolved: true },
    { id: 'c4', message: 'docs: 更新 API 文档', category: 'other', source: 'test', author: '赵六', date: '2025-01-18', reviewed: true, ticket: 'PROJ-104', issues: [], resolved: true }
  ]
  store.saveCommits(commits)
  return commits
}

console.log('=== 发布草稿审校台回归测试 ===\n')

cleanTestData()

console.log('--- 审校台主流程测试 ---')

runTest('创建两个草稿用于审校对比', () => {
  setupTestCommits()
  const r1 = draft.createDraft({ name: '草稿A', version: 'v1.0.0', description: '初始版本' })
  assert(r1.success, '创建草稿A应该成功')

  const commits2 = [
    { id: 'c1', message: 'feat: 新增用户管理模块', category: 'feature', source: 'test', author: '张三', date: '2025-01-15', reviewed: true, ticket: 'PROJ-101', issues: [], resolved: true },
    { id: 'c2', message: 'fix: 修复登录超时问题', category: 'fix', source: 'test', author: '李四', date: '2025-01-16', reviewed: true, ticket: 'PROJ-102', issues: [], resolved: true },
    { id: 'c5', message: 'feat: 新增导出功能', category: 'feature', source: 'test', author: '孙七', date: '2025-01-20', reviewed: true, ticket: 'PROJ-105', issues: [], resolved: true }
  ]
  store.saveCommits(commits2)
  const r2 = draft.createDraft({ name: '草稿B', version: 'v1.1.0', description: '迭代版本' })
  assert(r2.success, '创建草稿B应该成功')
})

runTest('审校台差异比对 - 基本信息', () => {
  const list = draft.listDrafts()
  assert(list.length >= 2, '应该至少有两个草稿')
  const d1 = list.find(d => d.name === '草稿A')
  const d2 = list.find(d => d.name === '草稿B')
  assert(d1, '应该找到草稿A')
  assert(d2, '应该找到草稿B')

  const result = draft.compareDrafts(d1.id, d2.id)
  assert(result.success, '比对应该成功')
  assert(!result.diff.name.same, '名称应该不同')
  assert(!result.diff.version.same, '版本应该不同')
  assert(!result.diff.description.same, '描述应该不同')
  assert(!result.diff.commitCount.same, '提交数应该不同')
})

runTest('审校台差异比对 - 导出选项', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const d2 = list.find(d => d.name === '草稿B')

  const result = draft.compareDrafts(d1.id, d2.id)
  assert(result.success, '比对应该成功')
  assert(result.diff.exportOptions, '应该包含导出选项差异')
  assert(result.diff.exportOptions.profileId, '应该包含profileId差异')
  assert(result.diff.exportOptions.profileName, '应该包含profileName差异')
  assert(result.diff.exportOptions.outputDir, '应该包含outputDir差异')
})

runTest('审校台差异比对 - 提交差异', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const d2 = list.find(d => d.name === '草稿B')

  const result = draft.compareDrafts(d1.id, d2.id)
  const c = result.diff.commits
  assert(c.added.length > 0 || c.removed.length > 0, '应该有提交差异')
  assert(result.diff.rules, '应该包含规则差异信息')
})

console.log('\n--- 冲突分支测试 ---')

runTest('复制草稿 - 同名冲突 (cancel)', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const result = draft.duplicateDraft(d1.id, '草稿A', { resolve: 'cancel' })
  assert(!result.success, '同名复制应该失败')
  assert(result.blocked, '应该被阻塞')
  assert(result.conflictDetails, '应该包含冲突详情')
  assert(result.conflictDetails.nameConflict, '应该有名称冲突信息')
})

runTest('复制草稿 - 同版本冲突 (cancel)', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const result = draft.duplicateDraft(d1.id, '新名称草稿', { resolve: 'cancel' })
  if (!result.success && result.blocked && result.reason === 'duplicate_version') {
    assert(result.conflictDetails.versionConflict, '应该有版本冲突信息')
  }
})

runTest('复制草稿 - 自动改名 (rename)', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const result = draft.duplicateDraft(d1.id, '草稿A', { resolve: 'rename' })
  assert(result.success, '自动改名复制应该成功')
  assert(result.draft.name !== '草稿A', '新名称应该不同')
  assert(result.draft.name.startsWith('草稿A'), '新名称应该以原名开头')
})

runTest('复制草稿 - 覆盖同名 (overwrite)', () => {
  const list = draft.listDrafts()
  const d1 = list.find(d => d.name === '草稿A')
  const result = draft.duplicateDraft(d1.id, '草稿A', { resolve: 'overwrite' })
  assert(result.success, '覆盖复制应该成功')
  assert(result.overwritten, '应该标记为已覆盖')
})

runTest('复制草稿 - 无冲突时直接成功', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'nc1', message: 'feat: 无冲突测试', category: 'feature', source: 'test', author: '张三', date: '2025-01-25', reviewed: true, ticket: 'NC-1', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '无冲突源草稿', version: 'v99.0.0' })
  assert(r.success, '创建无冲突源草稿应该成功')
  const result = currentDraft.duplicateDraft(r.draft.id, '唯一新名称草稿', { resolve: 'cancel' })
  assert(result.success, '无冲突复制应该成功: ' + (result.reason || ''))
  assert(!result.overwritten, '不应该标记为覆盖')
})

console.log('\n--- 多级撤销栈测试 ---')

runTest('多级撤销 - 创建多个草稿后逐个撤销', () => {
  const initialSize = draft.undoStackSize()
  
  draft.createDraft({ name: '撤销测试1', version: 'v0.1' })
  draft.createDraft({ name: '撤销测试2', version: 'v0.2' })
  draft.createDraft({ name: '撤销测试3', version: 'v0.3' })
  
  const sizeAfterCreate = draft.undoStackSize()
  assert(sizeAfterCreate >= initialSize + 3, '撤销栈应该增加了3个')

  const undo1 = draft.undoLastChange()
  assert(undo1.success, '第一次撤销应该成功')

  const undo2 = draft.undoLastChange()
  assert(undo2.success, '第二次撤销应该成功')

  const undo3 = draft.undoLastChange()
  assert(undo3.success, '第三次撤销应该成功')
})

runTest('撤销栈深度查询', () => {
  const size = draft.undoStackSize()
  assert(typeof size === 'number', '应该返回数字')
  assert(size >= 0, '深度应该非负')
})

runTest('查看撤销栈内容', () => {
  const stack = draft.peekUndoStack()
  assert(Array.isArray(stack), '应该返回数组')
})

console.log('\n--- 重启恢复测试 ---')

runTest('草稿数据持久化 - 重启后可继续审校', () => {
  const draftsBefore = draft.listDrafts()
  assert(draftsBefore.length > 0, '应该有草稿')
  
  delete require.cache[require.resolve('../src/draft')]
  delete require.cache[require.resolve('../src/store')]
  const draft2 = require('../src/draft')
  
  const draftsAfter = draft2.listDrafts()
  assert(draftsAfter.length === draftsBefore.length, '重启后草稿数量应该一致')
})

runTest('撤销栈持久化 - 重启后可撤销', () => {
  const draft2 = require('../src/draft')
  const size = draft2.undoStackSize()
  assert(size > 0, '重启后撤销栈应该有数据')
  
  const peek = draft2.peekUndo()
  assert(peek, '重启后应该能查看撤销信息')
  assert(peek.description, '撤销信息应该有描述')
})

runTest('操作日志持久化 - 重启后可查看', () => {
  const draft2 = require('../src/draft')
  const logs = draft2.listLogs(50)
  assert(Array.isArray(logs), '应该返回日志数组')
  assert(logs.length > 0, '重启后应该有日志')
})

console.log('\n--- JSON 导入覆盖测试 ---')

runTest('导出草稿为 JSON 后重新导入', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'ie1', message: 'feat: 导入导出测试', category: 'feature', source: 'test', author: '张三', date: '2025-02-01', reviewed: true, ticket: 'IE-1', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '导入导出源', version: 'v77.0.0' })
  assert(r.success, '创建导入导出源草稿应该成功')
  
  const exportResult = currentDraft.exportDraftToJson(r.draft.id)
  assert(exportResult.success, '导出应该成功')
  
  exportResult.data.draft.version = 'v77.0.1'
  const importResult = currentDraft.importDraftFromJson(exportResult.data, { asName: '导入覆盖测试' })
  assert(importResult.success, '导入应该成功: ' + (importResult.reason || JSON.stringify(importResult.errors || [])))
  assert(importResult.draft.name === '导入覆盖测试', '导入名称应该正确')
})

runTest('导入同名草稿 - 不覆盖应失败', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'ie2', message: 'feat: 同名导入测试', category: 'feature', source: 'test', author: '张三', date: '2025-02-02', reviewed: true, ticket: 'IE-2', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '同名导入目标', version: 'v66.0.0' })
  assert(r.success, '创建同名导入目标应该成功')
  const exportResult = currentDraft.exportDraftToJson(r.draft.id)
  const importResult = currentDraft.importDraftFromJson(exportResult.data, { asName: '同名导入目标' })
  assert(!importResult.success, '同名导入不覆盖应该失败')
  assert(importResult.blocked, '应该被阻塞')
})

runTest('导入同名草稿 - 强制覆盖应成功', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'ie3', message: 'feat: 强制覆盖导入测试', category: 'feature', source: 'test', author: '张三', date: '2025-02-03', reviewed: true, ticket: 'IE-3', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '强制覆盖目标', version: 'v55.0.0' })
  assert(r.success, '创建强制覆盖目标应该成功')
  const exportResult = currentDraft.exportDraftToJson(r.draft.id)
  const importResult = currentDraft.importDraftFromJson(exportResult.data, { asName: '强制覆盖目标', force: true })
  assert(importResult.success, '强制覆盖导入应该成功')
  assert(importResult.overwritten, '应该标记为已覆盖')
})

runTest('导入草稿到文件后从文件导入', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'ie4', message: 'feat: 文件导入导出测试', category: 'feature', source: 'test', author: '张三', date: '2025-02-04', reviewed: true, ticket: 'IE-4', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '文件导入导出源', version: 'v44.0.0' })
  assert(r.success, '创建文件导入导出源应该成功')
  const tmpFile = path.join(TEST_DATA_DIR, 'bench-test-export.json')
  const exportResult = currentDraft.exportDraftToFile(r.draft.id, tmpFile)
  assert(exportResult.success, '导出到文件应该成功')
  
  const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))
  raw.draft.version = 'v44.0.1'
  fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2))
  
  const importResult = currentDraft.importDraftFromFile(tmpFile, { asName: '从文件导入的草稿' })
  assert(importResult.success, '从文件导入应该成功: ' + (importResult.reason || JSON.stringify(importResult.errors || [])))
  
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

console.log('\n--- 撤销后回归验证 ---')

runTest('撤销复制操作后草稿数量恢复', () => {
  const currentDraft = require('../src/draft')
  const draftsBefore = currentDraft.listDrafts()
  const countBefore = draftsBefore.length
  
  const d = draftsBefore[0]
  const dupResult = currentDraft.duplicateDraft(d.id, '撤销回归测试草稿')
  assert(dupResult.success, '复制应该成功')
  
  const countAfterDup = currentDraft.listDrafts().length
  assert(countAfterDup === countBefore + 1, '复制后数量应该+1')
  
  const undoResult = currentDraft.undoLastChange()
  assert(undoResult.success, '撤销应该成功')
  
  const countAfterUndo = currentDraft.listDrafts().length
  assert(countAfterUndo === countBefore, '撤销后数量应该恢复')
})

runTest('撤销删除操作后草稿恢复', () => {
  const currentDraft = require('../src/draft')
  const draftsBefore = currentDraft.listDrafts()
  if (draftsBefore.length === 0) return
  
  const toDelete = draftsBefore[draftsBefore.length - 1]
  const nameBefore = toDelete.name
  const deleteResult = currentDraft.deleteDraft(toDelete.id)
  assert(deleteResult.success, '删除应该成功')
  
  const undoResult = currentDraft.undoLastChange()
  assert(undoResult.success, '撤销删除应该成功')
  
  const restored = currentDraft.getDraftByName(nameBefore)
  assert(restored, '撤销后草稿应该恢复')
})

runTest('撤销覆盖复制后原草稿恢复', () => {
  const currentDraft = require('../src/draft')
  const list = currentDraft.listDrafts()
  const d = list.find(dd => dd.name === '草稿B')
  if (!d) return
  
  const originalDraft = currentDraft.getDraft(d.id)
  const originalVersion = originalDraft.version
  
  currentDraft.duplicateDraft(d.id, '草稿B', { resolve: 'overwrite' })
  
  const undoResult = currentDraft.undoLastChange()
  assert(undoResult.success, '撤销覆盖复制应该成功')
  
  const restored = currentDraft.getDraft(d.id)
  assert(restored, '原草稿应该恢复')
  assert(restored.version === originalVersion, '原草稿版本应该恢复')
})

console.log('\n--- 现有归档和 Markdown 导出回归测试 ---')

runTest('归档功能正常', () => {
  const currentDraft = require('../src/draft')
  const archives = archiver.listArchives()
  assert(Array.isArray(archives), '归档列表应该返回数组')
})

runTest('配置功能正常', () => {
  const cfg = config.get()
  assert(cfg.keywords, '配置应该有关键字')
  assert(Array.isArray(cfg.ignorePatterns), '配置应该有忽略模式')
})

runTest('Markdown 导出功能正常 - generateMarkdown', () => {
  const archives = archiver.listArchives()
  if (archives.length === 0) {
    store.saveCommits([
      { id: 'c1', message: 'feat: test', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
    ])
    const snap = archiver.archive('v9.9.9')
    assert(snap, '归档应该成功')
  }
  try {
    const md = exporter.generateMarkdown(archiver.listArchives()[0].version)
    assert(typeof md === 'string', 'Markdown 应该是字符串')
    assert(md.includes('#'), 'Markdown 应该包含标题')
  } catch (e) {
    assert(false, 'Markdown 导出不应该失败: ' + e.message)
  }
})

runTest('草稿归档流程正常', () => {
  const currentDraft = require('../src/draft')
  store.saveCommits([
    { id: 'reg1', message: 'feat: 回归测试功能', category: 'feature', source: 'test', author: '张三', date: '2025-01-20', reviewed: true, ticket: 'REG-1', issues: [], resolved: true }
  ])
  const r = currentDraft.createDraft({ name: '回归归档测试', version: 'v8.8.8' })
  assert(r.success, '创建归档测试草稿应该成功')
  
  const archiveResult = currentDraft.archiveDraft(r.draft.id)
  assert(archiveResult.success, '草稿归档应该成功')
  assert(archiveResult.snapshot, '应该返回归档快照')
})

console.log('\n--- 审校台比对详情字段完整性 ---')

runTest('比对结果包含所有必要字段', () => {
  const currentDraft = require('../src/draft')
  const list = currentDraft.listDrafts()
  if (list.length < 2) return
  
  const result = currentDraft.compareDrafts(list[0].id, list[1].id)
  assert(result.success, '比对应该成功')
  
  const diff = result.diff
  assert(diff.name !== undefined, '应该有name字段')
  assert(diff.version !== undefined, '应该有version字段')
  assert(diff.description !== undefined, '应该有description字段')
  assert(diff.commitCount !== undefined, '应该有commitCount字段')
  assert(diff.commits !== undefined, '应该有commits字段')
  assert(diff.exportOptions !== undefined, '应该有exportOptions字段')
  assert(diff.exportOptions.profileId !== undefined, '应该有profileId字段')
  assert(diff.exportOptions.profileName !== undefined, '应该有profileName字段')
  assert(diff.exportOptions.outputDir !== undefined, '应该有outputDir字段')
  assert(diff.rules !== undefined, '应该有rules字段')
  assert(diff.createdAt !== undefined, '应该有createdAt字段')
  assert(diff.updatedAt !== undefined, '应该有updatedAt字段')
})

console.log('\n=== 所有审校台回归测试通过! ===')

const versionRegistry = require('../src/versionRegistry')

console.log('\n=== 版本占用登记中心回归测试 ===\n')

console.log('--- 基本占用/释放测试 ---')

runTest('版本可用性检查 - 空版本', () => {
  const r = versionRegistry.checkAvailability('')
  assert(r.available, '空版本号应该标记为可用（no_version）')
  assert(r.reason === 'no_version', '应该返回 no_version')
})

runTest('预占版本 - 基础功能', () => {
  const r = versionRegistry.preoccupyVersion('v100.0.0', {
    userId: 'user1', userName: '预占用户', draftName: '预占测试草稿'
  })
  assert(r.success, '预占应该成功')
  assert(r.entry.status === versionRegistry.STATUS_PREOCCUPIED, '状态应该是预占')
  assert(r.entry.sourceAction === versionRegistry.SOURCE_MANUAL, '来源应该是 manual')
})

runTest('版本可用性检查 - 已预占', () => {
  const r = versionRegistry.checkAvailability('v100.0.0')
  assert(!r.available, '已预占的版本应该不可用')
  assert(r.occupier === '预占用户', '应该返回正确占用者')
})

runTest('普通用户占用已被他人占用的版本应失败', () => {
  const r = versionRegistry.occupyVersion('v100.0.0', {
    userId: 'user2', userName: '其他用户', isAdmin: false,
    sourceAction: versionRegistry.SOURCE_CREATE, draftName: '尝试占用草稿'
  })
  assert(!r.success, '普通用户不应该能占用他人已占版本')
  assert(r.blocked, '应该被阻塞')
  assert(r.reason === 'version_occupied', '阻塞原因应该是 version_occupied')
})

runTest('管理员带理由接管已占用版本', () => {
  const r = versionRegistry.takeoverVersion('v100.0.0', {
    userId: 'admin', userName: '系统管理员', reason: '测试接管功能',
    draftName: '管理员接管后的草稿', draftId: 'd_test_takeover'
  })
  assert(r.success, '管理员接管应该成功')
  assert(r.tookOver, '应该标记为已接管')
  assert(r.entry.userId === 'admin', '新占用者应该是管理员')
  assert(r.entry.draftId === 'd_test_takeover', '草稿ID应该更新')
  assert(r.entry.history && r.entry.history.length >= 1, '应该有历史记录')
})

runTest('释放版本占用', () => {
  const before = versionRegistry.getEntry('v100.0.0')
  assert(before, '释放前应该存在')
  const r = versionRegistry.releaseVersion('v100.0.0', {
    userId: 'admin', userName: '系统管理员', reason: '测试释放'
  })
  assert(r.success, '释放应该成功')
  const after = versionRegistry.getEntry('v100.0.0')
  assert(!after, '释放后应该不存在')
})

console.log('\n--- 草稿流程版本占用集成测试 ---')

runTest('创建草稿自动占用版本', () => {
  const r = draft.createDraft({
    name: '版本占用测试草稿1', version: 'v101.0.0',
    userId: 'userA', userName: '用户A'
  })
  assert(r.success, '创建草稿应该成功')
  const entry = versionRegistry.getEntry('v101.0.0')
  assert(entry, '版本应该被自动占用')
  assert(entry.status === versionRegistry.STATUS_OCCUPIED, '状态应该是已占用')
  assert(entry.sourceAction === versionRegistry.SOURCE_CREATE, '来源应该是 create')
  assert(entry.draftId === r.draft.id, '草稿ID应该匹配')
})

runTest('创建同版本草稿冲突 - 普通用户', () => {
  const r = draft.createDraft({
    name: '冲突草稿', version: 'v101.0.0',
    userId: 'userB', userName: '用户B'
  })
  assert(!r.success, '普通用户创建同版本草稿应该失败')
  assert(r.blocked, '应该被阻塞')
  assert(r.reason === 'version_occupied', '阻塞原因应该是 version_occupied')
})

runTest('创建同版本草稿冲突 - 管理员强制接管', () => {
  const r = draft.createDraft({
    name: '管理员接管草稿', version: 'v101.0.0',
    isAdmin: true, force: true, takeoverReason: '测试草稿创建时接管',
    userId: 'admin', userName: '管理员'
  })
  assert(r.success, '管理员强制接管应该成功')
  const entry = versionRegistry.getEntry('v101.0.0')
  assert(entry.userId === 'admin', '占用者应该更新为管理员')
})

runTest('删除草稿自动释放版本', () => {
  const before = versionRegistry.getEntry('v101.0.0')
  assert(before, '删除前版本应该被占用')
  const d = draft.getDraftByName('管理员接管草稿')
  assert(d, '应该找到草稿')
  const r = draft.deleteDraft(d.id, { userId: 'admin', userName: '管理员' })
  assert(r.success, '删除草稿应该成功')
  const after = versionRegistry.getEntry('v101.0.0')
  assert(!after, '删除草稿后版本应该自动释放')
})

runTest('归档草稿自动释放版本', () => {
  store.saveCommits([
    { id: 'vr_test_c1', message: 'feat: 归档测试', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const cr = draft.createDraft({
    name: '归档释放测试', version: 'v102.0.0',
    userId: 'user1', userName: '用户1'
  })
  assert(cr.success, '创建草稿应该成功')
  const entryBefore = versionRegistry.getEntry('v102.0.0')
  assert(entryBefore, '归档前版本应该被占用')

  const ar = draft.archiveDraft(cr.draft.id)
  assert(ar.success, '归档应该成功')
  const entryAfter = versionRegistry.getEntry('v102.0.0')
  assert(!entryAfter, '归档后版本应该自动释放')
})

runTest('草稿更新版本号同步更新登记', () => {
  const cr = draft.createDraft({
    name: '版本更新测试草稿', version: 'v103.0.0',
    userId: 'user1', userName: '用户1'
  })
  assert(cr.success, '创建应该成功')
  assert(versionRegistry.getEntry('v103.0.0'), 'v103.0.0 应该被占用')

  const ur = draft.updateDraft(cr.draft.id, { version: 'v103.1.0' }, { userId: 'user1', userName: '用户1' })
  assert(ur.success, '更新版本应该成功')
  assert(!versionRegistry.getEntry('v103.0.0'), '旧版本应该释放')
  assert(versionRegistry.getEntry('v103.1.0'), '新版本应该被占用')

  draft.deleteDraft(ur.draft.id, { userId: 'user1', userName: '用户1' })
})

console.log('\n--- 复制草稿版本占用测试 ---')

runTest('复制草稿自动占用新版本', () => {
  store.saveCommits([
    { id: 'vr_dup_c1', message: 'feat: 复制测试', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const cr = draft.createDraft({
    name: '复制源草稿', version: 'v104.0.0',
    userId: 'user1', userName: '用户1'
  })
  assert(cr.success, '创建源草稿应该成功')
  assert(versionRegistry.getEntry('v104.0.0'), '源版本被占用')

  const dr = draft.duplicateDraft(cr.draft.id, '复制的新草稿', {
    resolve: 'rename', userId: 'user2', userName: '用户2'
  })
  assert(dr.success, '使用 rename 策略复制应该成功')
  assert(versionRegistry.getEntry('v104.0.0'), '源版本仍被占用')
  assert(versionRegistry.getEntryByDraftId(dr.draft.id), '新草稿ID应该有对应登记')
  const newEntry = versionRegistry.getEntryByDraftId(dr.draft.id)
  assert(newEntry.version !== 'v104.0.0', '新草稿版本号应该与源不同')
})

runTest('复制草稿同版本冲突 - 普通用户', () => {
  const cr = draft.createDraft({
    name: '冲突目标草稿', version: 'v104.1.0',
    userId: 'userA', userName: '用户A'
  })
  assert(cr.success, '创建冲突目标草稿应该成功')

  const src = draft.createDraft({
    name: '复制源2', version: 'v104.1.0',
    userId: 'userB', userName: '用户B'
  })
  if (src.success) {
    const dr = draft.duplicateDraft(src.draft.id, '新草稿名', {
      resolve: 'cancel', userId: 'userB', userName: '用户B'
    })
    assert(!dr.success, '同版本冲突复制应该失败')
    draft.deleteDraft(src.draft.id)
  }
  draft.deleteDraft(cr.draft.id)
})

console.log('\n--- 导入草稿版本占用测试 ---')

runTest('导入草稿自动占用版本', () => {
  store.saveCommits([
    { id: 'vr_imp_c1', message: 'feat: 导入测试', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const cr = draft.createDraft({
    name: '导入源草稿', version: 'v105.0.0'
  })
  const exp = draft.exportDraftToJson(cr.draft.id)
  draft.deleteDraft(cr.draft.id)

  const imp = draft.importDraftFromJson(exp.data, {
    asName: '导入的草稿', userId: 'userImp', userName: '导入用户'
  })
  assert(imp.success, '导入应该成功')
  const entry = versionRegistry.getEntry('v105.0.0')
  assert(entry, '导入后版本应该被占用')
  assert(entry.sourceAction === versionRegistry.SOURCE_IMPORT, '来源应该是 import')
})

runTest('导入同版本冲突 - 普通用户', () => {
  store.saveCommits([
    { id: 'vr_imp_c2', message: 'feat: 导入冲突测试', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const existing = draft.createDraft({
    name: '已有草稿占用版本', version: 'v105.1.0'
  })
  const imp = draft.importDraftFromJson(draft.exportDraftToJson(existing.draft.id).data, {
    asName: '新导入草稿', userId: 'otherUser', userName: '其他用户'
  })
  assert(!imp.success, '导入同版本冲突应该失败')
  draft.deleteDraft(existing.draft.id)
})

runTest('导入同版本冲突 - 管理员接管', () => {
  store.saveCommits([
    { id: 'vr_imp_c3', message: 'feat: 导入管理员接管', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const existing = draft.createDraft({
    name: '已有草稿', version: 'v105.2.0',
    userId: 'oldUser', userName: '旧用户'
  })
  const exp = draft.exportDraftToJson(existing.draft.id)
  const imp = draft.importDraftFromJson(exp.data, {
    asName: '管理员接管导入', isAdmin: true, force: true,
    takeoverReason: '导入需要接管此版本',
    userId: 'admin', userName: '管理员'
  })
  assert(imp.success, '管理员接管导入应该成功')
  const entry = versionRegistry.getEntry('v105.2.0')
  assert(entry.userId === 'admin', '占用者应该更新为管理员')
  draft.deleteDraft(existing.draft.id)
  draft.deleteDraft(imp.draft.id)
})

console.log('\n--- 冲突分支和撤销测试 ---')

runTest('日志记录完整性', () => {
  const logs = versionRegistry.listLogs(50)
  assert(Array.isArray(logs), '应该返回日志数组')
  assert(logs.length > 0, '应该有操作日志')
  const hasOccupy = logs.some(l => l.action === 'occupy')
  const hasRelease = logs.some(l => l.action === 'release')
  assert(hasOccupy, '应该有占用日志')
  assert(hasRelease, '应该有释放日志')
})

runTest('最近一次操作可撤销 - 释放后撤销', () => {
  const cr = draft.createDraft({
    name: '撤销测试草稿', version: 'v106.0.0',
    userId: 'userX', userName: '用户X'
  })
  assert(cr.success, '创建应该成功')
  const beforeEntry = versionRegistry.getEntry('v106.0.0')

  draft.deleteDraft(cr.draft.id)
  const afterDelete = versionRegistry.getEntry('v106.0.0')
  assert(!afterDelete, '删除后版本应该释放')

  const peek = versionRegistry.peekUndo()
  assert(peek, '应该有可撤销操作')
  assert(peek.action === 'release', '可撤销动作应该是 release')

  const undo = versionRegistry.undoLastChange({ userId: 'userX', userName: '用户X' })
  assert(undo.success, '撤销应该成功')
  const restored = versionRegistry.getEntry('v106.0.0')
  assert(restored, '撤销后版本占用应该恢复')
  assert(restored.userId === beforeEntry.userId, '占用者应该恢复')

  draft.deleteDraft(cr.draft.id)
  versionRegistry.releaseVersion('v106.0.0', { isAdmin: true, reason: '清理测试' })
})

runTest('最近一次操作可撤销 - 接管后撤销', () => {
  versionRegistry.occupyVersion('v106.1.0', {
    userId: 'user1', userName: '用户1', sourceAction: versionRegistry.SOURCE_CREATE,
    draftName: '草稿1', draftId: 'd_vr7_1'
  })
  const takeover = versionRegistry.takeoverVersion('v106.1.0', {
    userId: 'admin', userName: '管理员', reason: '测试撤销接管'
  })
  assert(takeover.success, '接管应该成功')

  const undo = versionRegistry.undoLastChange()
  assert(undo.success, '撤销接管应该成功')
  const restored = versionRegistry.getEntry('v106.1.0')
  assert(restored.userId === 'user1', '占用者应该恢复到接管前')

  versionRegistry.releaseVersion('v106.1.0', { isAdmin: true, reason: '清理测试' })
})

console.log('\n--- JSON 导入导出测试 ---')

runTest('导出版本登记数据', () => {
  versionRegistry.occupyVersion('v107.0.0', {
    userId: 'userA', userName: '用户A', sourceAction: versionRegistry.SOURCE_MANUAL,
    draftName: '导出测试草稿', draftId: 'd_vr8_0'
  })
  const exp = versionRegistry.exportRegistryToJson()
  assert(exp.schemaVersion, '应该有 schemaVersion')
  assert(Array.isArray(exp.entries), 'entries 应该是数组')
  assert(exp.entries.some(e => e.version === 'v107.0.0'), '应该包含 v107.0.0')
  versionRegistry.releaseVersion('v107.0.0', { isAdmin: true, reason: '清理' })
})

runTest('导入版本登记数据 - 无冲突', () => {
  const data = {
    schemaVersion: 1,
    entries: [
      {
        version: 'v108.0.0', status: 'occupied', userId: 'importUser',
        userName: '导入用户', sourceAction: 'manual', draftName: '导入测试',
        draftId: 'd_import_1', createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), history: []
      }
    ]
  }
  const imp = versionRegistry.importRegistryFromJson(data, {
    userId: 'admin', userName: '管理员'
  })
  assert(imp.success, '导入应该成功')
  assert(imp.importedCount === 1, '应该导入1条')
  const entry = versionRegistry.getEntry('v108.0.0')
  assert(entry, '导入后应该可以查到')
  versionRegistry.releaseVersion('v108.0.0', { isAdmin: true, reason: '清理' })
})

runTest('导入版本登记数据 - 冲突不覆盖', () => {
  versionRegistry.occupyVersion('v108.1.0', {
    userId: 'existUser', userName: '已有用户', sourceAction: versionRegistry.SOURCE_CREATE
  })
  const data = {
    schemaVersion: 1,
    entries: [{
      version: 'v108.1.0', status: 'occupied', userId: 'newUser',
      userName: '新用户', sourceAction: 'manual', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), history: []
    }]
  }
  const imp = versionRegistry.importRegistryFromJson(data, { force: false })
  assert(imp.success, '导入过程应该成功')
  assert(imp.conflictCount === 1, '应该有1个冲突')
  assert(imp.skipped === 1, '应该跳过1条')
  const entry = versionRegistry.getEntry('v108.1.0')
  assert(entry.userId === 'existUser', '冲突未覆盖，占用者应该保持不变')
  versionRegistry.releaseVersion('v108.1.0', { isAdmin: true, reason: '清理' })
})

runTest('导入版本登记数据 - 冲突强制覆盖', () => {
  versionRegistry.occupyVersion('v108.2.0', {
    userId: 'existUser', userName: '已有用户', sourceAction: versionRegistry.SOURCE_CREATE
  })
  const data = {
    schemaVersion: 1,
    entries: [{
      version: 'v108.2.0', status: 'occupied', userId: 'newUser',
      userName: '新用户', sourceAction: 'manual', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), history: []
    }]
  }
  const imp = versionRegistry.importRegistryFromJson(data, { force: true, isAdmin: true })
  assert(imp.success, '强制覆盖导入应该成功')
  const entry = versionRegistry.getEntry('v108.2.0')
  assert(entry.userId === 'newUser', '强制覆盖后占用者应该更新')
  versionRegistry.releaseVersion('v108.2.0', { isAdmin: true, reason: '清理' })
})

console.log('\n--- 跨重启一致性恢复测试 ---')

runTest('reconcile 清理无效登记（草稿不存在）', () => {
  versionRegistry.occupyVersion('v109.0.0', {
    userId: 'user', userName: '用户', sourceAction: versionRegistry.SOURCE_CREATE,
    draftName: '不存在的草稿', draftId: 'd_nonexistent_vr10'
  })
  assert(versionRegistry.getEntry('v109.0.0'), '清理前登记存在')

  const drafts = draft.listDrafts()
  const result = versionRegistry.reconcileWithDrafts(drafts)
  assert(result.staleRemoved >= 1, '应该清理至少1条无效登记')
  assert(!versionRegistry.getEntry('v109.0.0'), '清理后无效登记应该被移除')
})

runTest('reconcile 恢复缺失登记（草稿存在但无登记）', () => {
  const cr = draft.createDraft({
    name: '缺失登记测试草稿', version: 'v109.1.0',
    userId: 'user1', userName: '用户1'
  })
  versionRegistry.releaseVersion('v109.1.0', { isAdmin: true, reason: '模拟丢失登记' })
  assert(!versionRegistry.getEntry('v109.1.0'), '模拟丢失登记后应该不存在')

  const drafts = draft.listDrafts()
  const result = versionRegistry.reconcileWithDrafts(drafts)
  assert(result.missingRestored >= 1, '应该恢复至少1条缺失登记')
  const restored = versionRegistry.getEntry('v109.1.0')
  assert(restored, '恢复后登记应该存在')
  assert(restored.draftId === cr.draft.id, '草稿ID应该匹配')

  draft.deleteDraft(cr.draft.id)
})

runTest('draft.reconcileRegistry 便捷接口可用', () => {
  const cr = draft.createDraft({
    name: '便捷接口测试', version: 'v109.2.0'
  })
  versionRegistry.releaseVersion('v109.2.0', { isAdmin: true, reason: '测试便捷接口' })
  draft.reconcileRegistry()
  assert(versionRegistry.getEntry('v109.2.0'), '便捷接口应该恢复登记')
  draft.deleteDraft(cr.draft.id)
})

runTest('持久化后重启一致性', () => {
  versionRegistry.occupyVersion('v110.0.0', {
    userId: 'persistUser', userName: '持久化用户',
    sourceAction: versionRegistry.SOURCE_MANUAL, draftName: '持久化测试草稿'
  })

  delete require.cache[require.resolve('../src/versionRegistry')]
  delete require.cache[require.resolve('../src/store')]
  const vr2 = require('../src/versionRegistry')

  const entry = vr2.getEntry('v110.0.0')
  assert(entry, '重启后应该能读取到登记')
  assert(entry.userId === 'persistUser', '占用者信息应该一致')

  const logs = vr2.listLogs(10)
  assert(logs.length > 0, '重启后日志应该存在')

  vr2.releaseVersion('v110.0.0', { isAdmin: true, reason: '清理' })
})

console.log('\n--- 撤销后回归验证 ---')

runTest('撤销释放后再创建草稿版本冲突', () => {
  const cr = draft.createDraft({
    name: '撤销回归测试草稿', version: 'v111.0.0',
    userId: 'userA', userName: '用户A'
  })
  draft.deleteDraft(cr.draft.id)
  versionRegistry.undoLastChange()

  const attempt = draft.createDraft({
    name: '新草稿尝试占用', version: 'v111.0.0',
    userId: 'userB', userName: '用户B'
  })
  assert(!attempt.success, '撤销释放后同版本创建应该冲突')

  versionRegistry.releaseVersion('v111.0.0', { isAdmin: true, reason: '清理' })
  const success = draft.createDraft({
    name: '最终成功的草稿', version: 'v111.0.0'
  })
  assert(success.success, '清理后应该能创建成功')
  draft.deleteDraft(success.draft.id)
})

runTest('撤销接管后原占用者恢复', () => {
  versionRegistry.occupyVersion('v111.1.0', {
    userId: 'owner', userName: '原占用者', sourceAction: versionRegistry.SOURCE_CREATE,
    draftName: '原草稿', draftId: 'd_owner'
  })
  versionRegistry.takeoverVersion('v111.1.0', {
    userId: 'admin', userName: '管理员', reason: '测试撤销接管回归'
  })
  assert(versionRegistry.getEntry('v111.1.0').userId === 'admin', '接管后占用者是admin')

  versionRegistry.undoLastChange()
  assert(versionRegistry.getEntry('v111.1.0').userId === 'owner', '撤销后原占用者恢复')

  versionRegistry.releaseVersion('v111.1.0', { isAdmin: true, reason: '清理' })
})

console.log('\n--- 现有功能回归验证（归档/导出/审校）---')

runTest('归档功能不受版本登记影响', () => {
  store.saveCommits([
    { id: 'vr_reg_arc', message: 'feat: 回归归档', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const cr = draft.createDraft({ name: '归档回归草稿', version: 'v112.0.0' })
  assert(cr.success, '创建归档草稿应该成功')
  const ar = draft.archiveDraft(cr.draft.id)
  assert(ar.success, '归档应该成功')
  assert(ar.snapshot, '应该返回快照')
  const archives = archiver.listArchives()
  assert(archives.some(a => a.version === 'v112.0.0'), '归档列表应该包含 v112.0.0')
})

runTest('Markdown 导出功能正常', () => {
  const archives = archiver.listArchives()
  assert(archives.length > 0, '应该至少有一个归档')
  const md = exporter.generateMarkdown(archives[0].version)
  assert(typeof md === 'string', 'Markdown 导出应该返回字符串')
  assert(md.includes('#'), 'Markdown 应该包含标题')
})

runTest('草稿审校对比功能正常', () => {
  store.saveCommits([
    { id: 'vr_reg_rev1', message: 'feat: 审校测试1', category: 'feature', source: 'test', author: 'a', date: '2025-01-01', reviewed: true, ticket: 'T-1', issues: [], resolved: true }
  ])
  const d1 = draft.createDraft({ name: '审校对比A', version: 'v113.0.0' })
  store.saveCommits([
    { id: 'vr_reg_rev2', message: 'fix: 审校测试2', category: 'fix', source: 'test', author: 'b', date: '2025-01-02', reviewed: true, ticket: 'T-2', issues: [], resolved: true }
  ])
  const d2 = draft.createDraft({ name: '审校对比B', version: 'v113.1.0' })
  const cmp = draft.compareDrafts(d1.draft.id, d2.draft.id)
  assert(cmp.success, '对比应该成功')
  assert(cmp.diff, '应该返回差异数据')
  draft.deleteDraft(d1.draft.id)
  draft.deleteDraft(d2.draft.id)
})

console.log('\n=== 版本占用登记中心所有回归测试通过! ===')

cleanTestData()
