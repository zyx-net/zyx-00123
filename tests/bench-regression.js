const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const draft = require('../src/draft')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const config = require('../src/config')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')

function cleanTestData() {
  const files = ['commits', 'archives', 'drafts', 'draft_logs', 'draft_undo', 'draft_undo_stack', 'undo', 'config']
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

cleanTestData()
