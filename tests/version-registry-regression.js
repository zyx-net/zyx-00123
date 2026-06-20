const fs = require('fs')
const path = require('path')

process.env.SKIP_RECONCILE = '1'

const store = require('../src/store')
const config = require('../src/config')
const draft = require('../src/draft')
const versionRegistry = require('../src/versionRegistry')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const reviewer = require('../src/reviewer')

const testDataDir = store.DATA_DIR

function cleanTestData() {
  const files = [
    path.join(testDataDir, 'drafts.json'),
    path.join(testDataDir, 'commits.json'),
    path.join(testDataDir, 'config.json'),
    path.join(testDataDir, 'draft_logs.json'),
    path.join(testDataDir, 'draft_undo.json'),
    path.join(testDataDir, 'version_registry.json'),
    path.join(testDataDir, 'version_registry_logs.json'),
    path.join(testDataDir, 'version_registry_undo.json'),
    path.join(testDataDir, 'archives.json')
  ]
  files.forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  })
}

let testCount = 0
let passCount = 0
let failCount = 0
const failures = []

function runTest(name, fn) {
  testCount++
  console.log(`\n=== 测试 ${testCount}: ${name} ===`)
  try {
    fn()
    passCount++
    console.log(`✓ 通过: ${name}`)
  } catch (e) {
    failCount++
    failures.push({ name, error: e.message })
    console.log(`✗ 失败: ${name}`)
    console.log(`  错误: ${e.message}`)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || '断言失败')
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '断言失败'}: 期望 "${expected}", 实际 "${actual}"`)
  }
}

function assertContains(arr, item, message) {
  if (!arr.includes(item)) {
    throw new Error(`${message || '断言失败'}: 数组不包含 "${item}"`)
  }
}

function setupTestCommits() {
  store.saveCommits([
    {
      id: 'commit1',
      message: 'feat: 添加用户登录功能',
      category: '新功能',
      author: 'alice',
      date: '2024-01-15',
      source: 'git',
      reviewed: false,
      resolved: false,
      issues: []
    },
    {
      id: 'commit2',
      message: 'fix: 修复登录页面样式问题',
      category: 'Bug修复',
      author: 'bob',
      date: '2024-01-16',
      source: 'git',
      reviewed: false,
      resolved: false,
      issues: []
    },
    {
      id: 'commit3',
      message: 'docs: 更新API文档',
      category: '文档',
      author: 'carol',
      date: '2024-01-17',
      source: 'git',
      reviewed: false,
      resolved: false,
      issues: []
    }
  ])
}

console.log('========================================')
console.log('版本注册表回归测试')
console.log('========================================')

runTest('创建草稿 - 先占用版本再创建草稿', () => {
  cleanTestData()
  setupTestCommits()

  const result = draft.createDraft({
    name: '测试草稿1',
    version: '1.0.0',
    description: '测试版本占用',
    userId: 'user1',
    userName: '用户A'
  })

  assert(result.success, '创建草稿应该成功')
  assert(result.draft, '应该返回草稿对象')
  assert(result.versionRegistryEntry, '应该返回版本登记条目')
  assertEqual(result.draft.version, '1.0.0', '版本号应该正确')

  const entry = versionRegistry.getEntry('1.0.0')
  assert(entry, '版本 1.0.0 应该被占用')
  assertEqual(entry.version, '1.0.0', '版本号应该一致')
  assertEqual(entry.draftId, result.draft.id, '登记的草稿ID应该一致')
  assertEqual(entry.draftName, '测试草稿1', '登记的草稿名称应该一致')
  assertEqual(entry.userId, 'user1', '登记的用户ID应该一致')
  assertEqual(entry.sourceAction, 'create', '来源动作应该是 create')

  const drafts = store.loadDrafts()
  assertEqual(drafts.length, 1, '应该只有一个草稿')
})

runTest('创建草稿 - 版本冲突时普通用户被阻止', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '草稿A',
    version: '1.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '第一次创建应该成功')

  const result2 = draft.createDraft({
    name: '草稿B',
    version: '1.0.0',
    userId: 'user2',
    userName: '用户B'
  })

  assert(!result2.success, '第二次创建应该失败')
  assert(result2.blocked, '应该被阻止')
  assertEqual(result2.reason, 'version_occupied', '失败原因应该是版本被占用')
  assert(result2.versionConflict, '应该返回冲突信息')
  assert(result2.versionConflict.occupier, '应该显示占用人信息')
  assertContains(result2.errors.join(), '已被', '错误信息应该包含"已被"')

  const drafts = store.loadDrafts()
  assertEqual(drafts.length, 1, '应该只有一个草稿（第一次创建的）')

  const entry = versionRegistry.getEntry('1.0.0')
  assertEqual(entry.userId, 'user1', '占用人应该还是用户A')
})

runTest('管理员接管 - 必须提供接管理由', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '草稿A',
    version: '2.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '第一次创建应该成功')

  const result2 = draft.createDraft({
    name: '草稿B',
    version: '2.0.0',
    userId: 'admin1',
    userName: '管理员',
    force: true,
    isAdmin: true
  })

  assert(!result2.success, '没有接管理由应该失败')
  assertEqual(result2.reason, 'no_takeover_reason', '失败原因应该是没有接管理由')

  const result3 = draft.createDraft({
    name: '草稿B',
    version: '2.0.0',
    userId: 'admin1',
    userName: '管理员',
    force: true,
    isAdmin: true,
    takeoverReason: '旧草稿已废弃，需要重新创建'
  })

  assert(result3.success, '有接管理由应该成功')
  assert(result3.tookOver, '应该标记为已接管')

  const entry = versionRegistry.getEntry('2.0.0')
  assertEqual(entry.userId, 'admin1', '占用人应该变为管理员')
  assertEqual(entry.draftId, result3.draft.id, '登记的草稿ID应该是新草稿的')

  const drafts = store.loadDrafts()
  assertEqual(drafts.length, 2, '应该有两个草稿')
})

runTest('复制草稿 - 先占用版本再创建', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '源草稿',
    version: '3.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建源草稿应该成功')

  const result2 = draft.duplicateDraft(result1.draft.id, '复制的草稿', {
    resolve: 'rename',
    userId: 'user2',
    userName: '用户B'
  })

  assert(result2.success, '复制草稿应该成功')
  assert(result2.draft.version !== '3.0.0', '复制的草稿版本应该自动变化')

  const entry = versionRegistry.getEntry('3.0.0')
  assertEqual(entry.userId, 'user1', '源版本占用人应该不变')

  const entry2 = versionRegistry.getEntry(result2.draft.version)
  assert(entry2, '新版本应该被占用')
  assertEqual(entry2.userId, 'user2', '新版本占用人应该是用户B')
  assertEqual(entry2.sourceAction, 'duplicate', '来源动作应该是 duplicate')
})

runTest('复制草稿 - 管理员强制接管', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '源草稿',
    version: '4.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建源草稿应该成功')

  const result2 = draft.duplicateDraft(result1.draft.id, '复制的草稿', {
    resolve: 'force',
    isAdmin: true,
    userId: 'admin1',
    userName: '管理员',
    takeoverReason: '测试复制接管'
  })

  assert(result2.success, '管理员强制复制应该成功')
  assertEqual(result2.draft.version, '4.0.0', '版本应该保持为 4.0.0')

  const entry = versionRegistry.getEntry('4.0.0')
  assertEqual(entry.userId, 'admin1', '占用人应该变为管理员')
  assertEqual(entry.sourceAction, 'duplicate', '来源动作应该是 duplicate')
})

runTest('JSON导入草稿 - 先占用版本再导入', () => {
  cleanTestData()
  setupTestCommits()

  const importData = {
    type: 'release-notes-draft',
    draft: {
      name: '导入的草稿',
      version: '5.0.0',
      description: '从JSON导入',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null }
    }
  }

  const result = draft.importDraftFromJson(importData, {
    userId: 'user1',
    userName: '用户A'
  })

  assert(result.success, '导入应该成功')
  assert(result.versionRegistryEntry, '应该返回版本登记条目')
  assertEqual(result.draft.version, '5.0.0', '版本号应该正确')

  const entry = versionRegistry.getEntry('5.0.0')
  assert(entry, '版本 5.0.0 应该被占用')
  assertEqual(entry.sourceAction, 'import', '来源动作应该是 import')
  assertEqual(entry.userId, 'user1', '占用人应该正确')
})

runTest('版本冲突 - 导入时检测到冲突', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '现有草稿',
    version: '6.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建草稿应该成功')

  const importData = {
    type: 'release-notes-draft',
    draft: {
      name: '导入的草稿',
      version: '6.0.0',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null }
    }
  }

  const result2 = draft.importDraftFromJson(importData, {
    userId: 'user2',
    userName: '用户B'
  })

  assert(!result2.success, '导入应该失败')
  assertEqual(result2.reason, 'version_occupied', '失败原因应该是版本被占用')

  const drafts = store.loadDrafts()
  assertEqual(drafts.length, 1, '应该只有一个草稿')
})

runTest('预占用版本 - 然后创建草稿', () => {
  cleanTestData()

  const preoccupyResult = versionRegistry.preoccupyVersion('7.0.0', {
    userId: 'user1',
    userName: '用户A',
    sourceAction: 'manual'
  })

  assert(preoccupyResult.success, '预占用应该成功')
  assertEqual(preoccupyResult.entry.status, 'preoccupied', '状态应该是 preoccupied')

  const entry1 = versionRegistry.getEntry('7.0.0')
  assert(entry1, '版本应该被预占用')
  assertEqual(entry1.status, 'preoccupied', '状态应该是 preoccupied')
  assert(!entry1.draftId, '预占用时不应该有关联草稿')

  const checkResult = versionRegistry.checkAvailability('7.0.0', { userId: 'user2' })
  assert(!checkResult.available, '其他用户应该看到版本已被占用')

  const createResult = draft.createDraft({
    name: '预占用测试草稿',
    version: '7.0.0',
    userId: 'user1',
    userName: '用户A'
  })

  assert(createResult.success, '创建草稿应该成功')
  const entry2 = versionRegistry.getEntry('7.0.0')
  assertEqual(entry2.status, 'occupied', '状态应该变为 occupied')
  assertEqual(entry2.draftId, createResult.draft.id, '应该关联草稿ID')
})

runTest('释放版本占用', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '测试草稿',
    version: '8.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建草稿应该成功')

  const entry1 = versionRegistry.getEntry('8.0.0')
  assert(entry1, '版本应该被占用')

  const releaseResult = versionRegistry.releaseVersion('8.0.0', {
    userId: 'user1',
    userName: '用户A',
    reason: '测试释放'
  })

  assert(releaseResult.success, '释放应该成功')

  const entry2 = versionRegistry.getEntry('8.0.0')
  assert(!entry2, '版本应该不再被占用')

  const checkResult = versionRegistry.checkAvailability('8.0.0')
  assert(checkResult.available, '版本应该可用')
})

runTest('释放版本占用 - 非所有者无法释放', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '测试草稿',
    version: '8.1.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建草稿应该成功')

  const releaseResult = versionRegistry.releaseVersion('8.1.0', {
    userId: 'user2',
    userName: '用户B'
  })

  assert(!releaseResult.success, '非所有者释放应该失败')
  assertEqual(releaseResult.reason, 'not_owner', '失败原因应该是不是所有者')

  const entry = versionRegistry.getEntry('8.1.0')
  assert(entry, '版本仍然应该被占用')
})

runTest('撤销 - 撤销最近一次释放', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '测试草稿',
    version: '9.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '创建草稿应该成功')

  const entry1 = versionRegistry.getEntry('9.0.0')
  assert(entry1, '版本应该被占用')

  const releaseResult = versionRegistry.releaseVersion('9.0.0', {
    userId: 'user1',
    userName: '用户A',
    reason: '测试释放后撤销'
  })
  assert(releaseResult.success, '释放应该成功')

  const entry2 = versionRegistry.getEntry('9.0.0')
  assert(!entry2, '版本应该已被释放')

  const undoResult = versionRegistry.undoLastChange({
    userId: 'user1',
    userName: '用户A'
  })

  assert(undoResult.success, '撤销应该成功')
  assertEqual(undoResult.action, 'release', '撤销的动作应该是 release')

  const entry3 = versionRegistry.getEntry('9.0.0')
  assert(entry3, '版本占用应该被恢复')
  assertEqual(entry3.userId, 'user1', '占用人应该恢复')
  assertEqual(entry3.draftId, result1.draft.id, '关联草稿应该恢复')
})

runTest('撤销 - 撤销最近一次接管', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '草稿A',
    version: '10.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '用户A创建草稿应该成功')

  const entry1 = versionRegistry.getEntry('10.0.0')
  assertEqual(entry1.userId, 'user1', '初始占用人应该是用户A')

  const result2 = draft.createDraft({
    name: '草稿B',
    version: '10.0.0',
    userId: 'admin1',
    userName: '管理员',
    force: true,
    isAdmin: true,
    takeoverReason: '测试接管后撤销'
  })
  assert(result2.success, '管理员接管应该成功')

  const entry2 = versionRegistry.getEntry('10.0.0')
  assertEqual(entry2.userId, 'admin1', '占用人应该变为管理员')

  const undoResult = versionRegistry.undoLastChange({
    userId: 'admin1',
    userName: '管理员'
  })

  assert(undoResult.success, '撤销应该成功')
  assertEqual(undoResult.action, 'takeover', '撤销的动作应该是 takeover')

  const entry3 = versionRegistry.getEntry('10.0.0')
  assert(entry3, '版本占用应该被恢复')
  assertEqual(entry3.userId, 'user1', '占用人应该恢复为用户A')
})

runTest('一致性恢复 - 修复缺失的版本登记', () => {
  cleanTestData()

  const drafts = [
    {
      id: 'draft1',
      name: '孤立项草稿',
      version: '11.0.0',
      description: '没有登记的草稿',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ]
  store.saveDrafts(drafts)

  const entry = versionRegistry.getEntry('11.0.0')
  assert(!entry, '初始状态下版本不应该被登记')

  const reconcileResult = versionRegistry.reconcileWithDrafts()

  assert(!reconcileResult.ok, '应该检测到问题')
  assertEqual(reconcileResult.missingRestored, 1, '应该恢复1条缺失的登记')
  assertEqual(reconcileResult.fixes.length, 1, '应该有1个修复')
  assertEqual(reconcileResult.fixes[0].type, 'restore_missing', '修复类型应该是 restore_missing')

  const entryAfter = versionRegistry.getEntry('11.0.0')
  assert(entryAfter, '版本应该已被恢复登记')
  assertEqual(entryAfter.draftId, 'draft1', '应该关联正确的草稿ID')
  assertEqual(entryAfter.userId, 'system', '应该标记为系统恢复')
})

runTest('一致性恢复 - 清理孤立的版本登记', () => {
  cleanTestData()

  store.saveDrafts([])

  versionRegistry.occupyVersion('12.0.0', {
    userId: 'user1',
    userName: '用户A',
    draftId: 'nonexistent',
    draftName: '不存在的草稿',
    sourceAction: 'create'
  })

  const entry = versionRegistry.getEntry('12.0.0')
  assert(entry, '初始状态下版本应该被登记')

  const reconcileResult = versionRegistry.reconcileWithDrafts()

  assert(!reconcileResult.ok, '应该检测到问题')
  assertEqual(reconcileResult.staleRemoved, 1, '应该清理1条孤立的登记')
  assertEqual(reconcileResult.fixes.length, 1, '应该有1个修复')
  assertEqual(reconcileResult.fixes[0].type, 'remove_stale', '修复类型应该是 remove_stale')

  const entryAfter = versionRegistry.getEntry('12.0.0')
  assert(!entryAfter, '孤立登记应该已被清理')
})

runTest('一致性恢复 - 修复重复版本草稿', () => {
  cleanTestData()

  const now = new Date().toISOString()
  const earlier = new Date(Date.now() - 3600000).toISOString()
  
  const drafts = [
    {
      id: 'draft_old',
      name: '旧草稿',
      version: '13.0.0',
      description: '较早的草稿',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null },
      createdAt: earlier,
      updatedAt: earlier
    },
    {
      id: 'draft_new',
      name: '新草稿',
      version: '13.0.0',
      description: '较新的草稿',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null },
      createdAt: now,
      updatedAt: now
    }
  ]
  store.saveDrafts(drafts)

  const reconcileResult = versionRegistry.reconcileWithDrafts()

  assert(!reconcileResult.ok, '应该检测到问题')
  assert(reconcileResult.fixes.some(f => f.type === 'duplicate_version'), '应该有重复版本修复')

  const draftsAfter = store.loadDrafts()
  const oldDraft = draftsAfter.find(d => d.id === 'draft_old')
  const newDraft = draftsAfter.find(d => d.id === 'draft_new')
  
  assertEqual(oldDraft.version, '', '旧草稿的版本应该被清除')
  assertEqual(newDraft.version, '13.0.0', '新草稿的版本应该保留')

  const entry = versionRegistry.getEntry('13.0.0')
  assert(entry, '版本应该被登记')
  assertEqual(entry.draftId, 'draft_new', '应该关联新草稿')
})

runTest('无法创建同版本双草稿 - 从不同入口', () => {
  cleanTestData()
  setupTestCommits()

  const result1 = draft.createDraft({
    name: '草稿1',
    version: '14.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result1.success, '第一次创建应该成功')

  const result2 = draft.createDraft({
    name: '草稿2',
    version: '14.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(!result2.success, '同一用户也不能创建同版本双草稿')

  const drafts = store.loadDrafts()
  assertEqual(drafts.length, 1, '应该只有一个草稿')

  const result3 = draft.duplicateDraft(result1.draft.id, '草稿副本', {
    resolve: 'cancel',
    userId: 'user1',
    userName: '用户A'
  })
  
  const importData = {
    type: 'release-notes-draft',
    draft: {
      name: '导入草稿',
      version: '14.0.0',
      commits: [],
      rules: config.get(),
      exportOptions: { profileId: null, profileName: null, outputDir: null }
    }
  }
  const result4 = draft.importDraftFromJson(importData, {
    userId: 'user1',
    userName: '用户A'
  })
  assert(!result4.success, '导入也不能创建同版本双草稿')

  const draftsFinal = store.loadDrafts()
  assertEqual(draftsFinal.length, 1, '最终应该只有一个草稿')
})

runTest('版本占用列表查询', () => {
  cleanTestData()
  setupTestCommits()

  draft.createDraft({ name: '草稿A', version: '15.0.0', userId: 'user1', userName: '用户A' })
  draft.createDraft({ name: '草稿B', version: '15.1.0', userId: 'user2', userName: '用户B' })
  draft.createDraft({ name: '草稿C', version: '15.2.0', userId: 'user1', userName: '用户A' })

  const allEntries = versionRegistry.listEntries()
  assertEqual(allEntries.length, 3, '应该有3条登记记录')

  const user1Entries = versionRegistry.listEntries({ userId: 'user1' })
  assertEqual(user1Entries.length, 2, '用户A应该有2条登记记录')

  const specificEntry = versionRegistry.listEntries({ version: '15.1.0' })
  assertEqual(specificEntry.length, 1, '查询特定版本应该返回1条')
  assertEqual(specificEntry[0].userName, '用户B', '应该返回正确的用户')
})

runTest('版本占用日志记录', () => {
  cleanTestData()
  setupTestCommits()

  draft.createDraft({ name: '测试草稿', version: '16.0.0', userId: 'user1', userName: '用户A' })
  
  versionRegistry.releaseVersion('16.0.0', {
    userId: 'user1',
    userName: '用户A',
    reason: '测试日志'
  })

  const logs = versionRegistry.listLogs(10)
  assert(logs.length >= 2, '应该至少有2条日志')
  
  const occupyLog = logs.find(l => l.action === 'occupy')
  assert(occupyLog, '应该有占用日志')
  assertEqual(occupyLog.version, '16.0.0', '日志版本应该正确')
  assertEqual(occupyLog.userId, 'user1', '操作用户应该正确')

  const releaseLog = logs.find(l => l.action === 'release')
  assert(releaseLog, '应该有释放日志')
  assertEqual(releaseLog.reason, '测试日志', '日志原因应该正确')
})

runTest('版本注册表JSON导入导出', () => {
  cleanTestData()
  setupTestCommits()

  draft.createDraft({ name: '草稿A', version: '17.0.0', userId: 'user1', userName: '用户A' })
  draft.createDraft({ name: '草稿B', version: '17.1.0', userId: 'user2', userName: '用户B' })

  const exportData = versionRegistry.exportRegistryToJson()
  assert(exportData, '应该有导出数据')
  assertEqual(exportData.type, 'version-registry-export', '类型应该正确')
  assert(Array.isArray(exportData.entries), '应该有entries数组')
  assertEqual(exportData.entries.length, 2, '应该有2条导出记录')

  cleanTestData()
  const importResult = versionRegistry.importRegistryFromJson(exportData, {
    userId: 'admin',
    userName: '管理员'
  })

  assert(importResult.success, '导入应该成功')
  assertEqual(importResult.importedCount, 2, '应该导入2条记录')

  const entryA = versionRegistry.getEntry('17.0.0')
  const entryB = versionRegistry.getEntry('17.1.0')
  assert(entryA, '版本17.0.0应该被恢复')
  assert(entryB, '版本17.1.0应该被恢复')
  assertEqual(entryA.draftName, '草稿A', '草稿A名称应该正确')
  assertEqual(entryB.draftName, '草稿B', '草稿B名称应该正确')
})

runTest('归档功能 - 归档时释放版本占用', () => {
  cleanTestData()
  setupTestCommits()

  const result = draft.createDraft({
    name: '归档测试草稿',
    version: '18.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result.success, '创建草稿应该成功')

  const entryBefore = versionRegistry.getEntry('18.0.0')
  assert(entryBefore, '归档前版本应该被占用')

  const draftToArchive = draft.getDraft(result.draft.id)
  draftToArchive.commits.forEach(c => {
    c.reviewed = true
    c.resolved = true
  })
  draft.updateDraft(draftToArchive.id, { commits: draftToArchive.commits }, {})

  const archiveResult = draft.archiveDraft(result.draft.id, {
    userId: 'user1',
    userName: '用户A'
  })
  assert(archiveResult.success, `归档应该成功: ${archiveResult.errors ? archiveResult.errors.join(', ') : ''}`)

  const entryAfter = versionRegistry.getEntry('18.0.0')
  assert(!entryAfter, '归档后版本应该被释放')

  const checkResult = versionRegistry.checkAvailability('18.0.0')
  assert(checkResult.available, '版本应该可用')

  const drafts = store.loadDrafts()
  const archivedDraft = drafts.find(d => d.id === result.draft.id)
  assert(!archivedDraft, '草稿应该已被移至归档')
})

runTest('Markdown导出 - 不受版本注册表影响', () => {
  cleanTestData()
  setupTestCommits()

  const result = draft.createDraft({
    name: '导出测试草稿',
    version: '19.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result.success, '创建草稿应该成功')

  const draftToArchive = draft.getDraft(result.draft.id)
  draftToArchive.commits.forEach(c => {
    c.reviewed = true
    c.resolved = true
  })
  draft.updateDraft(draftToArchive.id, { commits: draftToArchive.commits }, {})

  const archiveResult = draft.archiveDraft(result.draft.id, {
    userId: 'user1',
    userName: '用户A'
  })
  assert(archiveResult.success, `先归档才能导出Markdown: ${archiveResult.errors ? archiveResult.errors.join(', ') : ''}`)

  const exportResult = exporter.exportToFile('19.0.0', testDataDir, {})
  assert(exportResult, 'Markdown导出应该成功')
  assert(fs.existsSync(exportResult.path || exportResult.filePath), '导出文件应该存在')

  const filePath = exportResult.path || exportResult.filePath
  const content = fs.readFileSync(filePath, 'utf-8')
  assert(content.includes('19.0.0'), '导出内容应该包含版本号')
  assert(content.includes('添加用户登录功能'), '导出内容应该包含提交信息')

  fs.unlinkSync(filePath)
})

runTest('草稿审核 - 不受版本注册表影响', () => {
  cleanTestData()
  setupTestCommits()

  const commitsBefore = store.loadCommits()
  const unreviewedBefore = commitsBefore.filter(c => !c.reviewed)
  assert(unreviewedBefore.length > 0, '应该有未审核的提交')

  const result = draft.createDraft({
    name: '审核测试草稿',
    version: '20.0.0',
    userId: 'user1',
    userName: '用户A'
  })
  assert(result.success, '创建草稿应该成功')

  const entry = versionRegistry.getEntry('20.0.0')
  assert(entry, '版本占用应该存在')

  const commitsForReview = store.loadCommits()
  const commitToReview = commitsForReview.find(c => !c.reviewed)
  assert(commitToReview, '应该有未审核的提交')

  const reviewedCommit = reviewer.review(commitToReview.id, '审核通过')
  assert(reviewedCommit, '审核应该成功')
  assert(reviewedCommit.reviewed, '提交应该被标记为已审核')

  const entry2 = versionRegistry.getEntry('20.0.0')
  assert(entry2, '版本占用应该仍然保持')

  const commitsAfter = store.loadCommits()
  const reviewedAfter = commitsAfter.filter(c => c.reviewed)
  assert(reviewedAfter.length > 0, '应该有已审核的提交')
})

runTest('两步式占用 - 草稿保存失败时回滚版本占用', () => {
  cleanTestData()
  setupTestCommits()

  const originalSaveDrafts = store.saveDrafts
  let callCount = 0
  
  store.saveDrafts = function(data) {
    callCount++
    if (callCount === 1) {
      throw new Error('模拟保存失败')
    }
    return originalSaveDrafts.call(store, data)
  }

  try {
    const result = draft.createDraft({
      name: '回滚测试草稿',
      version: '21.0.0',
      userId: 'user1',
      userName: '用户A'
    })

    assert(!result.success, '创建应该失败')
    assert(result.errors.join().includes('保存草稿失败'), '错误信息应该包含保存失败')

    const entry = versionRegistry.getEntry('21.0.0')
    assert(!entry, '版本占用应该已经回滚')

    const drafts = store.loadDrafts()
    assertEqual(drafts.length, 0, '不应该有草稿被保存')
  } finally {
    store.saveDrafts = originalSaveDrafts
  }
})

runTest('普通用户冲突时的可用操作提示', () => {
  cleanTestData()
  setupTestCommits()

  draft.createDraft({
    name: '草稿A',
    version: '22.0.0',
    userId: 'user1',
    userName: '用户A'
  })

  const result = draft.duplicateDraft('nonexistent', '测试', {
    resolve: 'cancel',
    userId: 'user2',
    userName: '用户B'
  })

  const result2 = draft.createDraft({
    name: '草稿B',
    version: '22.0.0',
    userId: 'user2',
    userName: '用户B'
  })

  assert(!result2.success, '创建应该失败')
  assert(result2.blocked, '应该被阻止')
  assert(result2.versionConflict, '应该有冲突信息')
})

console.log('\n========================================')
console.log('测试结果汇总')
console.log('========================================')
console.log(`总测试数: ${testCount}`)
console.log(`通过: ${passCount}`)
console.log(`失败: ${failCount}`)
console.log('========================================')

if (failures.length > 0) {
  console.log('\n失败详情:')
  failures.forEach((f, i) => {
    console.log(`${i + 1}. ${f.name}`)
    console.log(`   错误: ${f.error}`)
  })
  process.exit(1)
} else {
  console.log('\n✓ 所有测试通过!')
  process.exit(0)
}
