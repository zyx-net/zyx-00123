const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const draft = require('../src/draft')
const operationAudit = require('../src/operationAudit')
const config = require('../src/config')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')

function cleanTestData() {
  const files = [
    'commits', 'archives', 'drafts', 'draft_logs', 'draft_undo', 'draft_undo_stack',
    'undo', 'config', 'version_registry', 'version_registry_logs', 'version_registry_undo',
    'operation_audit', 'operation_audit_logs', 'operation_audit_undo',
    'draft_vault', 'draft_vault_logs', 'draft_vault_recovery_undo'
  ]
  files.forEach(f => {
    const fp = path.join(TEST_DATA_DIR, `${f}.json`)
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
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
  if (!condition) throw new Error(message || 'Assertion failed')
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

console.log('=== 操作来源审计回归测试 ===\n')

cleanTestData()

console.log('--- 1. 匿名请求拦截测试 ---')

runTest('匿名 applyDraft 被审计拦截 (userId 为空)', () => {
  setupTestCommits()
  const createResult = draft.createDraft({ name: '拦截测试草稿', version: 'v1.0.0', userId: 'testUser', userName: '测试用户' })
  assert(createResult.success, '创建草稿应成功')

  const result = draft.applyDraft(createResult.draft.id, {
    _auditContext: { entry: 'cli', userId: null, userName: null }
  })
  assert(!result.success, '匿名请求应被拦截')
  assert(result.blocked, '应标记为 blocked')
  assert(result.reason === 'invalid_audit_context', 'reason 应为 invalid_audit_context')
})

runTest('userId 为 anonymous 被审计拦截', () => {
  const createResult = draft.createDraft({ name: '匿名拦截2', version: 'v1.0.1', userId: 'testUser', userName: '测试用户' })
  assert(createResult.success, '创建草稿应成功')

  const result = draft.applyDraft(createResult.draft.id, {
    _auditContext: { entry: 'cli', userId: 'anonymous', userName: '匿名用户' }
  })
  assert(!result.success, 'anonymous userId 应被拦截')
  assert(result.reason === 'invalid_audit_context', 'reason 应为 invalid_audit_context')
})

runTest('userId 为 cli 被审计拦截', () => {
  const createResult = draft.createDraft({ name: 'CLI拦截', version: 'v1.0.2', userId: 'testUser', userName: '测试用户' })
  assert(createResult.success, '创建草稿应成功')

  const result = draft.applyDraft(createResult.draft.id, {
    _auditContext: { entry: 'cli', userId: 'cli', userName: '系统' }
  })
  assert(!result.success, 'cli userId 应被拦截')
})

runTest('entry 为空被审计拦截', () => {
  const createResult = draft.createDraft({ name: 'Entry拦截', version: 'v1.0.3', userId: 'testUser', userName: '测试用户' })
  assert(createResult.success, '创建草稿应成功')

  const result = draft.applyDraft(createResult.draft.id, {
    _auditContext: { entry: null, userId: 'realUser', userName: '真实用户' }
  })
  assert(!result.success, 'entry 为空应被拦截')
})

console.log('\n--- 2. 正常提交测试 ---')

runTest('applyDraft 通过审计正常提交 (CLI入口)', () => {
  cleanTestData()
  setupTestCommits()
  const createResult = draft.createDraft({ name: '正常应用草稿', version: 'v2.0.0', userId: 'zhangsan', userName: '张三' })
  assert(createResult.success, '创建草稿应成功')

  const ctx = { entry: 'cli', userId: 'zhangsan', userName: '张三', sessionId: 'sess-001', requestId: 'req-001' }
  const result = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(result.success, '正常 apply 应成功')
  assert(result._auditRecordId, '应返回审计记录ID')
  assert(result._auditEntry === 'cli', '审计入口应为 cli')
  assert(result._auditUserId === 'zhangsan', '审计用户应为 zhangsan')

  const record = operationAudit.getRecord(result._auditRecordId)
  assert(record, '审计记录应存在')
  assert(record.action === 'apply', 'action 应为 apply')
  assert(record.entry === 'cli', 'entry 应为 cli')
  assert(record.userId === 'zhangsan', 'userId 应为 zhangsan')
  assert(record.userName === '张三', 'userName 应为 张三')
  assert(record.sessionId === 'sess-001', 'sessionId 应为 sess-001')
  assert(record.requestId === 'req-001', 'requestId 应为 req-001')
  assert(record.status === 'committed', '状态应为 committed')
  assert(record.beforeSnapshot, 'beforeSnapshot 应存在')
  assert(record.afterSnapshot, 'afterSnapshot 应存在')
  assert(record.triggeredAt, 'triggeredAt 应存在')
})

runTest('applyDraft 通过审计正常提交 (Web入口)', () => {
  cleanTestData()
  setupTestCommits()
  const createResult = draft.createDraft({ name: 'Web应用草稿', version: 'v2.1.0', userId: 'lisi', userName: '李四' })
  assert(createResult.success, '创建草稿应成功')

  const ctx = { entry: 'web', userId: 'lisi', userName: '李四', sessionId: 'web-sess-002', requestId: 'web-req-002' }
  const result = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(result.success, '正常 apply 应成功')
  assert(result._auditEntry === 'web', '审计入口应为 web')

  const record = operationAudit.getRecord(result._auditRecordId)
  assert(record.entry === 'web', 'entry 应为 web')
  assert(record.userId === 'lisi', 'userId 应为 lisi')
  assert(record.status === 'committed', '状态应为 committed')
})

runTest('archiveDraft 通过审计正常提交', () => {
  const ctx = { entry: 'web', userId: 'wangwu', userName: '王五', sessionId: 'web-sess-003' }
  const list = draft.listDrafts()
  const d = list.find(x => x.version === 'v2.1.0')
  assert(d, '应找到已创建的草稿')

  const result = draft.archiveDraft(d.id, { _auditContext: ctx, _vaultSource: 'web', userId: 'wangwu', userName: '王五' })
  assert(result.success, 'archive 应成功')
  assert(result._auditRecordId, '应返回审计记录ID')

  const record = operationAudit.getRecord(result._auditRecordId)
  assert(record.action === 'archive', 'action 应为 archive')
  assert(record.entry === 'web', 'entry 应为 web')
  assert(record.userId === 'wangwu', 'userId 应为 wangwu')
})

runTest('importDraftFromJson 通过审计正常提交', () => {
  cleanTestData()
  setupTestCommits()
  const ctx = { entry: 'cli', userId: 'zhaoliu', userName: '赵六', sessionId: 'cli-sess-004' }
  const importData = {
    type: 'release-notes-draft',
    draft: { name: '审计导入草稿', version: 'v3.0.0', description: '测试', commits: [] }
  }

  const result = draft.importDraftFromJson(importData, {
    _auditContext: ctx,
    userId: 'zhaoliu',
    userName: '赵六'
  })
  assert(result.success, '导入应成功')
  assert(result._auditRecordId, '应返回审计记录ID')

  const record = operationAudit.getRecord(result._auditRecordId)
  assert(record.action === 'import', 'action 应为 import')
  assert(record.entry === 'cli', 'entry 应为 cli')
  assert(record.userId === 'zhaoliu', 'userId 应为 zhaoliu')
  assert(record.status === 'committed', '状态应为 committed')
})

console.log('\n--- 3. 审计信息一致性验证 ---')

runTest('存储中的审计记录与接口返回一致', () => {
  cleanTestData()
  setupTestCommits()
  const createResult = draft.createDraft({ name: '一致性验证草稿', version: 'v4.0.0', userId: 'userA', userName: '用户A' })
  assert(createResult.success)

  const ctx = { entry: 'web', userId: 'userA', userName: '用户A', sessionId: 'sess-consistency' }
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.success)

  const recordId = applyResult._auditRecordId
  const record = operationAudit.getRecord(recordId)
  assert(record.id === recordId, '记录ID应一致')
  assert(record.entry === 'web', '入口应一致')
  assert(record.userId === 'userA', '用户ID应一致')
  assert(record.userName === '用户A', '用户名应一致')
  assert(record.sessionId === 'sess-consistency', '会话ID应一致')
  assert(record.action === 'apply', '操作应一致')
  assert(record.status === 'committed', '状态应为 committed')
  assert(record.beforeSnapshot, 'beforeSnapshot 应存在')
  assert(record.afterSnapshot, 'afterSnapshot 应存在')
  assert(record.beforeSnapshot.commits, 'beforeSnapshot.commits 应存在')
  assert(record.afterSnapshot.commits, 'afterSnapshot.commits 应存在')
  assert(record.triggeredAt, '触发时间应存在')
  assert(record.completedAt, '完成时间应存在')
})

console.log('\n--- 4. 异常中断与重启恢复测试 ---')

runTest('模拟异常中断: pending 操作可恢复', () => {
  cleanTestData()
  setupTestCommits()

  const auditData = store.loadOperationAudit()
  assert(auditData.records !== undefined, '应存在 records')
  assert(auditData.pendingOps !== undefined, '应存在 pendingOps')

  const beginResult = operationAudit.beginOperation(
    'apply',
    'draft:test-draft:apply',
    { entry: 'cli', userId: 'recoveryUser', userName: '恢复测试用户' },
    { commits: store.loadCommits(), drafts: store.loadDrafts() }
  )
  assert(beginResult.success, 'beginOperation 应成功')

  const pending = operationAudit.getPendingOperations()
  assert(pending.length > 0, '应有 pending 操作')

  const recoverResult = operationAudit.recoverPendingOperations()
  assert(recoverResult.success, '恢复应成功')
  assert(recoverResult.recovered > 0, '应至少恢复1条')
})

runTest('恢复后审计记录状态正确', () => {
  cleanTestData()
  setupTestCommits()

  const ctx = { entry: 'cli', userId: 'recoveryCheck', userName: '恢复检查用户' }
  const beginResult = operationAudit.beginOperation(
    'apply',
    'draft:recovery-check:apply',
    ctx,
    { commits: store.loadCommits(), drafts: store.loadDrafts() }
  )
  assert(beginResult.success)

  const recoverResult = operationAudit.recoverPendingOperations()
  assert(recoverResult.success)

  const record = operationAudit.getRecord(beginResult.recordId)
  assert(record.status === 'recovered', `状态应为 recovered，实际为 ${record.status}`)
})

console.log('\n--- 5. 同对象并发冲突测试 ---')

runTest('并发操作同一目标被锁拦截', () => {
  cleanTestData()
  setupTestCommits()

  const ctx1 = { entry: 'cli', userId: 'user1', userName: '用户1' }
  const begin1 = operationAudit.beginOperation(
    'apply',
    'draft:concurrent-draft:apply',
    ctx1,
    { commits: [], drafts: [] }
  )
  assert(begin1.success, '第一次操作应成功获取锁')

  const ctx2 = { entry: 'web', userId: 'user2', userName: '用户2' }
  const begin2 = operationAudit.beginOperation(
    'apply',
    'draft:concurrent-draft:apply',
    ctx2,
    { commits: [], drafts: [] }
  )
  assert(!begin2.success, '第二次操作应被锁拦截')
  assert(begin2.conflict, '应返回冲突信息')
  assert(begin2.conflict.holder === 'user1', '锁持有者应为 user1')

  operationAudit.failOperation(begin1.recordId, '测试结束')

  const ctx3 = { entry: 'web', userId: 'user2', userName: '用户2' }
  const begin3 = operationAudit.beginOperation(
    'apply',
    'draft:concurrent-draft:apply',
    ctx3,
    { commits: [], drafts: [] }
  )
  assert(begin3.success, '锁释放后应能获取')

  operationAudit.failOperation(begin3.recordId, '测试结束')
})

console.log('\n--- 6. 回滚与撤销测试 ---')

runTest('回滚已提交的操作并撤销回滚', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({ name: '回滚测试草稿', version: 'v5.0.0', userId: 'rollbackUser', userName: '回滚用户' })
  assert(createResult.success)

  const originalCommits = store.loadCommits()
  store.saveCommits([])
  assert(store.loadCommits().length === 0, '清空后应无 commits')

  const ctx = { entry: 'cli', userId: 'rollbackUser', userName: '回滚用户' }
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.success)

  const afterApplyCommits = store.loadCommits()
  assert(afterApplyCommits.length === originalCommits.length, 'apply 后 commits 应恢复为草稿中的内容')

  const rollbackResult = operationAudit.rollbackOperation(applyResult._auditRecordId, {
    entry: 'cli',
    userId: 'rollbackUser',
    userName: '回滚用户'
  })
  assert(rollbackResult.success, '回滚应成功')

  const afterRollbackCommits = store.loadCommits()
  assert(afterRollbackCommits.length === 0, '回滚后 commits 应恢复到 beforeSnapshot 状态(0)')

  const undoResult = operationAudit.undoLastRecoveryOrRollback()
  assert(undoResult.success, '撤销回滚应成功')

  const afterUndoCommits = store.loadCommits()
  assert(afterUndoCommits.length === afterApplyCommits.length, '撤销回滚后 commits 应恢复到 apply 后状态')
})

runTest('peekUndo 返回正确的撤销信息', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({ name: 'peekUndo草稿', version: 'v5.1.0', userId: 'peekUser', userName: 'Peek用户' })
  assert(createResult.success)

  store.saveCommits([])
  const ctx = { entry: 'cli', userId: 'peekUser', userName: 'Peek用户' }
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.success)

  operationAudit.rollbackOperation(applyResult._auditRecordId, {
    entry: 'cli',
    userId: 'peekUser',
    userName: 'Peek用户'
  })

  const peek = operationAudit.peekUndo()
  assert(peek, '应有可撤销的操作')
  assert(peek.action === 'rollback', 'action 应为 rollback')
})

console.log('\n--- 7. JSON 导入导出测试 ---')

runTest('导出审计数据为 JSON 并导入', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({ name: '导入导出测试', version: 'v6.0.0', userId: 'exportUser', userName: '导出用户' })
  assert(createResult.success)

  const ctx = { entry: 'web', userId: 'exportUser', userName: '导出用户' }
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.success)

  const exported = operationAudit.exportAuditToJson()
  assert(exported.type === 'operation-audit-export', '导出类型应正确')
  assert(exported.records.length > 0, '应有记录')
  assert(exported.exportedAt, '应有导出时间')

  cleanTestData()
  setupTestCommits()

  const importResult = operationAudit.importAuditFromJson(exported)
  assert(importResult.success, '导入应成功')
  assert(importResult.importedCount > 0, '应导入记录')

  const status = operationAudit.getStatus()
  assert(status.totalRecords > 0, '导入后应有记录')
})

console.log('\n--- 8. 审计日志验证 ---')

runTest('关键操作都记录了审计日志', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({ name: '日志验证', version: 'v7.0.0', userId: 'logUser', userName: '日志用户' })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'logUser', userName: '日志用户' }
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.success)

  const logs = operationAudit.listLogs(20)
  assert(logs.length > 0, '应有审计日志')

  const beginLog = logs.find(l => l.action === 'begin_operation')
  assert(beginLog, '应有 begin_operation 日志')

  const commitLog = logs.find(l => l.action === 'commit_operation')
  assert(commitLog, '应有 commit_operation 日志')
})

console.log('\n--- 9. 不带审计上下文的兼容测试 ---')

runTest('不带 _auditContext 时 applyDraft 仍可正常工作', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({ name: '无审计草稿', version: 'v8.0.0', userId: 'noAuditUser', userName: '无审计用户' })
  assert(createResult.success)

  const result = draft.applyDraft(createResult.draft.id)
  assert(result.success, '不带审计上下文应仍可工作')
  assert(!result._auditRecordId, '不应有审计记录ID')
})

console.log('\n--- 10. 审计模块状态接口 ---')

runTest('getStatus 返回正确的统计', () => {
  cleanTestData()
  setupTestCommits()

  const status1 = operationAudit.getStatus()
  assert(status1.totalRecords !== undefined, '应有 totalRecords')
  assert(status1.pendingOperations !== undefined, '应有 pendingOperations')
  assert(status1.activeLocks !== undefined, '应有 activeLocks')

  const createResult = draft.createDraft({ name: '状态测试', version: 'v9.0.0', userId: 'statusUser', userName: '状态用户' })
  const ctx = { entry: 'web', userId: 'statusUser', userName: '状态用户' }
  draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  const status2 = operationAudit.getStatus()
  assert(status2.totalRecords > status1.totalRecords, '操作后记录数应增加')
  assert(status2.byStatus.committed > 0, '应有 committed 状态的记录')
  assert(status2.byAction.apply > 0, '应有 apply 操作的记录')
})

console.log('\n=== 所有测试通过 ===')
