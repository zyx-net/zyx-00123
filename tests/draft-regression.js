const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const draft = require('../src/draft')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const config = require('../src/config')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')

function cleanTestData() {
  const files = ['commits', 'archives', 'drafts', 'draft_logs', 'draft_undo', 'undo', 'config']
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
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
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

console.log('=== 草稿箱回归测试 ===\n')

cleanTestData()

console.log('--- 基础功能测试 ---')

runTest('创建草稿', () => {
  setupTestCommits()
  const result = draft.createDraft({ name: '测试草稿1', version: 'v1.0.0', description: '这是一个测试草稿' })
  assert(result.success, '创建应该成功')
  assert(result.draft, '应该返回草稿对象')
  assert(result.draft.name === '测试草稿1', '草稿名称应该正确')
  assert(result.draft.version === 'v1.0.0', '版本号应该正确')
  assert(result.draft.commits.length === 4, '应该包含所有非忽略的提交')
})

runTest('列出草稿', () => {
  const list = draft.listDrafts()
  assert(Array.isArray(list), '应该返回数组')
  assert(list.length >= 1, '至少应该有1个草稿')
})

runTest('获取草稿详情', () => {
  const list = draft.listDrafts()
  const d = draft.getDraft(list[0].id)
  assert(d, '应该能获取到草稿')
  assert(d.commits, '应该包含提交数据')
  assert(d.rules, '应该包含规则快照')
})

runTest('按名称查找草稿', () => {
  const d = draft.getDraftByName('测试草稿1')
  assert(d, '应该能按名称找到草稿')
  assert(d.name === '测试草稿1', '名称应该匹配')
})

runTest('更新草稿', () => {
  const list = draft.listDrafts()
  const result = draft.updateDraft(list[0].id, { description: '更新后的描述' })
  assert(result.success, '更新应该成功')
  assert(result.draft.description === '更新后的描述', '描述应该已更新')
})

runTest('复制草稿', () => {
  const list = draft.listDrafts()
  const result = draft.duplicateDraft(list[0].id, '测试草稿1 副本')
  assert(result.success, '复制应该成功')
  assert(result.draft.name === '测试草稿1 副本', '副本名称应该正确')
  assert(result.draft.id !== list[0].id, '副本ID应该不同')
})

console.log('\n--- 冲突处理测试 ---')

runTest('同名草稿冲突检测', () => {
  const result = draft.createDraft({ name: '测试草稿1' })
  assert(!result.success, '同名草稿创建应该失败')
  assert(result.blocked, '应该被阻塞')
  assert(result.reason === 'duplicate_name', '原因应该是重复名称')
})

runTest('同名草稿强制覆盖', () => {
  const result = draft.createDraft({ name: '测试草稿1', version: 'v1.0.1', force: true })
  assert(result.success, '强制覆盖应该成功')
  assert(result.overwritten, '应该标记为已覆盖')
  assert(result.draft.version === 'v1.0.1', '版本应该已更新')
})

runTest('同版本草稿冲突检测', () => {
  const result = draft.createDraft({ name: '新版本草稿', version: 'v1.0.1' })
  assert(!result.success, '同版本草稿创建应该失败')
  assert(result.blocked, '应该被阻塞')
  assert(result.reason === 'duplicate_version', '原因应该是重复版本')
})

console.log('\n--- 应用与归档测试 ---')

runTest('应用草稿', () => {
  store.saveCommits([])
  const list = draft.listDrafts()
  const result = draft.applyDraft(list[0].id)
  assert(result.success, '应用应该成功')
  const commits = store.loadCommits()
  assert(commits.length > 0, '工作区应该有提交了')
})

runTest('从草稿归档', () => {
  const list = draft.listDrafts()
  const hasVersion = list.find(d => d.version)
  if (hasVersion) {
    const beforeLen = archiver.listArchives().length
    const result = draft.archiveDraft(hasVersion.id)
    if (!result.success) {
      console.log('   归档失败详情:', result.errors)
    }
    assert(result.success, '归档应该成功')
    assert(result.snapshot, '应该返回归档快照')
    const afterLen = archiver.listArchives().length
    assert(afterLen === beforeLen + 1, '归档数量应该增加')
    
    const draftsAfter = draft.listDrafts()
    const stillExists = draftsAfter.some(d => d.id === hasVersion.id)
    assert(!stillExists, '归档后草稿应该被删除')
  }
})

console.log('\n--- JSON 导入导出测试 ---')

runTest('导出草稿为 JSON', () => {
  const drafts = draft.listDrafts()
  assert(drafts.length > 0, '应该有草稿可供导出')
  const result = draft.exportDraftToJson(drafts[0].id)
  assert(result.success, '导出应该成功')
  assert(result.data.schemaVersion === 1, '应该有 schemaVersion')
  assert(result.data.type === 'release-notes-draft', '类型应该正确')
  assert(result.data.draft, '应该包含草稿数据')
})

runTest('从 JSON 导入草稿', () => {
  const drafts = draft.listDrafts()
  assert(drafts.length > 0, '应该有草稿可供导出')
  const exportResult = draft.exportDraftToJson(drafts[0].id)
  const importData = JSON.parse(JSON.stringify(exportResult.data))
  importData.draft.version = 'v2.0.0'
  const result = draft.importDraftFromJson(importData, { asName: '导入的草稿' })
  assert(result.success, '导入应该成功')
  assert(result.draft.name === '导入的草稿', '名称应该正确')
})

runTest('导入草稿冲突检测', () => {
  const drafts = draft.listDrafts()
  const exportResult = draft.exportDraftToJson(drafts[0].id)
  const result = draft.importDraftFromJson(exportResult.data, { asName: drafts[0].name })
  assert(!result.success, '同名导入应该失败')
  assert(result.reason === 'duplicate_name', '应该是名称冲突')
})

runTest('导入草稿强制覆盖', () => {
  const drafts = draft.listDrafts()
  const firstDraft = drafts[0]
  const exportResult = draft.exportDraftToJson(firstDraft.id)
  const result = draft.importDraftFromJson(exportResult.data, { asName: firstDraft.name, force: true })
  assert(result.success, '强制覆盖导入应该成功')
  assert(result.overwritten, '应该标记为已覆盖')
})

console.log('\n--- 操作日志测试 ---')

runTest('查询操作日志', () => {
  const logs = draft.listLogs(20)
  assert(Array.isArray(logs), '应该返回数组')
  assert(logs.length > 0, '应该有操作日志')
  const hasCreate = logs.some(l => l.action === 'create')
  assert(hasCreate, '应该包含创建操作日志')
})

console.log('\n--- 撤销回滚测试 ---')

runTest('查看可撤销操作', () => {
  const peek = draft.peekUndo()
  assert(peek, '应该有可撤销的操作')
  assert(peek.description, '应该有描述')
})

runTest('撤销删除操作', () => {
  const draftsBefore = draft.listDrafts()
  if (draftsBefore.length > 0) {
    const toDelete = draftsBefore[0]
    draft.deleteDraft(toDelete.id)
    const draftsAfterDelete = draft.listDrafts()
    assert(draftsAfterDelete.length === draftsBefore.length - 1, '删除后数量应该减少')
    
    const undoResult = draft.undoLastChange()
    assert(undoResult.success, '撤销应该成功')
    
    const draftsAfterUndo = draft.listDrafts()
    assert(draftsAfterUndo.length === draftsBefore.length, '撤销后数量应该恢复')
  }
})

console.log('\n--- 错误处理测试 ---')

runTest('获取不存在的草稿', () => {
  const d = draft.getDraft('nonexistent-id')
  assert(d === null, '应该返回 null')
})

runTest('更新不存在的草稿', () => {
  const result = draft.updateDraft('nonexistent-id', { name: '测试' })
  assert(!result.success, '更新不存在的草稿应该失败')
})

runTest('删除不存在的草稿', () => {
  const result = draft.deleteDraft('nonexistent-id')
  assert(!result.success, '删除不存在的草稿应该失败')
})

runTest('导入损坏的 JSON 文件', () => {
  const tmpFile = path.join(__dirname, '..', 'data', 'bad-draft.json')
  fs.writeFileSync(tmpFile, 'this is not valid json {{{', 'utf-8')
  const result = draft.importDraftFromFile(tmpFile)
  assert(!result.success, '导入损坏文件应该失败')
  fs.unlinkSync(tmpFile)
})

runTest('导出到不存在的目录', () => {
  const drafts = draft.listDrafts()
  if (drafts.length > 0) {
    const result = draft.exportDraftToFile(drafts[0].id, '/nonexistent/dir/output.json')
    assert(!result.success, '导出到不存在的目录应该失败')
  }
})

console.log('\n--- 跨重启持久化测试 ---')

runTest('草稿数据持久化', () => {
  const draftsBefore = draft.listDrafts()
  assert(draftsBefore.length > 0, '应该有草稿')
  
  // 模拟重启：重新 require 模块
  delete require.cache[require.resolve('../src/draft')]
  delete require.cache[require.resolve('../src/store')]
  const draft2 = require('../src/draft')
  
  const draftsAfter = draft2.listDrafts()
  assert(draftsAfter.length === draftsBefore.length, '重启后草稿数量应该一致')
})

console.log('\n--- 现有功能回归测试 ---')

runTest('配置功能正常', () => {
  const cfg = config.get()
  assert(cfg.keywords, '配置应该有关键字')
  assert(Array.isArray(cfg.ignorePatterns), '配置应该有忽略模式')
})

runTest('归档列表功能正常', () => {
  const archives = archiver.listArchives()
  assert(Array.isArray(archives), '应该返回数组')
})

console.log('\n=== 所有测试通过! ===')

cleanTestData()
