const http = require('http')
const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const draft = require('../src/draft')
const operationAudit = require('../src/operationAudit')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')
const TEST_PORT = 13891

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

function setupTestCommits() {
  const commits = [
    { id: 'wc1', message: 'feat: Web审计功能', category: 'feature', source: 'web-test', author: 'Web用户A', date: '2025-01-15', reviewed: true, ticket: 'WEB-101', issues: [], resolved: true },
    { id: 'wc2', message: 'fix: Web审计修复', category: 'fix', source: 'web-test', author: 'Web用户B', date: '2025-01-16', reviewed: true, ticket: 'WEB-102', issues: [], resolved: true },
    { id: 'wc3', message: 'breaking: Web审计变更', category: 'breaking', source: 'web-test', author: 'Web用户C', date: '2025-01-17', reviewed: true, ticket: 'WEB-103', issues: [], resolved: true }
  ]
  store.saveCommits(commits)
  return commits
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

function httpRequest(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: pathname,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {})
      }
    }
    const req = http.request(opts, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = data }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function httpRequestAsync(method, pathname, body, headers) {
  return httpRequest(method, pathname, body, headers)
}

let serverInstance = null

function startTestServer() {
  return new Promise((resolve, reject) => {
    const { handleApi } = require('../web/server')
    serverInstance = http.createServer(async (req, res) => {
      try {
        await handleApi(req, res, req.url)
      } catch (e) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    serverInstance.listen(TEST_PORT, () => resolve())
  })
}

function stopTestServer() {
  return new Promise(resolve => {
    if (serverInstance) {
      serverInstance.close(() => resolve())
    } else {
      resolve()
    }
  })
}

async function runWebTests() {
  console.log('=== 操作来源审计 Web API 回归测试 ===\n')

  cleanTestData()
  setupTestCommits()

  try {
    await startTestServer()
  } catch (e) {
    console.error('启动测试服务器失败:', e.message)
    process.exit(1)
  }

  console.log('--- 1. Web 匿名请求拦截测试 ---')

  await runTest('Web apply 缺少 userId 返回 403', async () => {
    const createResult = draft.createDraft({ name: 'Web拦截草稿1', version: 'vw1.0.0', userId: 'webTestUser', userName: 'Web测试用户' })
    assert(createResult.success, '创建草稿应成功')

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {})
    assert(res.status === 403, `应返回403，实际: ${res.status}`)
  })

  await runTest('Web apply userId 为 anonymous 被审计拦截', async () => {
    const createResult = draft.createDraft({ name: 'Web拦截草稿2', version: 'vw1.0.1', userId: 'webTestUser', userName: 'Web测试用户' })
    assert(createResult.success)

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'anonymous',
      userName: '匿名用户'
    })
    assert(res.status === 409 || res.body.blocked || (res.body.error && res.body.error.includes('审计')), 'anonymous userId 应被拦截')
  })

  await runTest('Web archive 缺少 userId 返回 403', async () => {
    const list = draft.listDrafts()
    const d = list.find(x => x.version === 'vw1.0.1')
    assert(d, '应找到草稿')

    const res = await httpRequestAsync('POST', `/api/drafts/${d.id}/archive`, {})
    assert(res.status === 403, `应返回403，实际: ${res.status}`)
  })

  await runTest('Web import 缺少 userId 返回 403', async () => {
    const importData = {
      type: 'release-notes-draft',
      draft: { name: 'Web拦截导入', version: 'vw1.0.2', description: '测试', commits: [] }
    }
    const res = await httpRequestAsync('POST', '/api/drafts/import', { draftData: importData })
    assert(res.status === 403, `应返回403，实际: ${res.status}`)
  })

  console.log('\n--- 2. Web 正常提交测试 ---')

  await runTest('Web apply 正常提交并包含审计信息', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web正常草稿', version: 'vw2.0.0', userId: 'webZhangsan', userName: 'Web张三' })
    assert(createResult.success)

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webZhangsan',
      userName: 'Web张三',
      sessionId: 'web-sess-100',
      requestId: 'web-req-100'
    })
    assert(res.status === 200, `应返回200，实际: ${res.status}`)
    assert(res.body.success, 'apply 应成功')
    assert(res.body._auditRecordId, '应返回审计记录ID')
    assert(res.body._auditEntry === 'web', '审计入口应为 web')
    assert(res.body._auditUserId === 'webZhangsan', '审计用户应为 webZhangsan')

    const record = operationAudit.getRecord(res.body._auditRecordId)
    assert(record, '审计记录应存在')
    assert(record.action === 'apply', 'action 应为 apply')
    assert(record.entry === 'web', 'entry 应为 web')
    assert(record.userId === 'webZhangsan', 'userId 应为 webZhangsan')
    assert(record.userName === 'Web张三', 'userName 应为 Web张三')
    assert(record.sessionId === 'web-sess-100', 'sessionId 应为 web-sess-100')
    assert(record.requestId === 'web-req-100', 'requestId 应为 web-req-100')
    assert(record.status === 'committed', '状态应为 committed')
    assert(record.beforeSnapshot, 'beforeSnapshot 应存在')
    assert(record.afterSnapshot, 'afterSnapshot 应存在')
    assert(record.triggeredAt, 'triggeredAt 应存在')
  })

  await runTest('Web archive 正常提交并包含审计信息', async () => {
    const list = draft.listDrafts()
    const d = list.find(x => x.version === 'vw2.0.0')
    assert(d, '应找到已创建的草稿')

    const res = await httpRequestAsync('POST', `/api/drafts/${d.id}/archive`, {
      userId: 'webLisi',
      userName: 'Web李四',
      sessionId: 'web-sess-101'
    })
    assert(res.status === 200, `应返回200，实际: ${res.status}`)
    assert(res.body.success, 'archive 应成功')
    assert(res.body._auditRecordId, '应返回审计记录ID')

    const record = operationAudit.getRecord(res.body._auditRecordId)
    assert(record.action === 'archive', 'action 应为 archive')
    assert(record.entry === 'web', 'entry 应为 web')
    assert(record.userId === 'webLisi', 'userId 应为 webLisi')
  })

  await runTest('Web import 正常提交并包含审计信息', async () => {
    cleanTestData()
    setupTestCommits()

    const importData = {
      type: 'release-notes-draft',
      draft: { name: 'Web审计导入草稿', version: 'vw3.0.0', description: '测试', commits: [] }
    }
    const res = await httpRequestAsync('POST', '/api/drafts/import', {
      draftData: importData,
      userId: 'webWangwu',
      userName: 'Web王五',
      sessionId: 'web-sess-102'
    })
    assert(res.status === 200, `应返回200，实际: ${res.status}`)
    assert(res.body.success, 'import 应成功')
    assert(res.body._auditRecordId, '应返回审计记录ID')

    const record = operationAudit.getRecord(res.body._auditRecordId)
    assert(record.action === 'import', 'action 应为 import')
    assert(record.entry === 'web', 'entry 应为 web')
    assert(record.userId === 'webWangwu', 'userId 应为 webWangwu')
  })

  console.log('\n--- 3. Web 审计信息一致性验证 ---')

  await runTest('API 返回的审计记录与存储一致', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web一致性草稿', version: 'vw4.0.0', userId: 'consistencyUser', userName: '一致性用户' })
    assert(createResult.success)

    const applyRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'consistencyUser',
      userName: '一致性用户',
      sessionId: 'sess-web-consistency'
    })
    assert(applyRes.body.success)

    const recordId = applyRes.body._auditRecordId

    const apiRes = await httpRequestAsync('GET', `/api/audit/records/${recordId}`)
    assert(apiRes.status === 200)
    assert(apiRes.body.record.id === recordId, 'API返回的记录ID应一致')
    assert(apiRes.body.record.entry === 'web', '入口应一致')
    assert(apiRes.body.record.userId === 'consistencyUser', '用户ID应一致')
    assert(apiRes.body.record.sessionId === 'sess-web-consistency', '会话ID应一致')

    const storedRecord = operationAudit.getRecord(recordId)
    assert(storedRecord.entry === apiRes.body.record.entry, '存储与API的 entry 应一致')
    assert(storedRecord.userId === apiRes.body.record.userId, '存储与API的 userId 应一致')
    assert(storedRecord.userName === apiRes.body.record.userName, '存储与API的 userName 应一致')
    assert(storedRecord.sessionId === apiRes.body.record.sessionId, '存储与API的 sessionId 应一致')
    assert(storedRecord.action === apiRes.body.record.action, '存储与API的 action 应一致')
    assert(storedRecord.status === apiRes.body.record.status, '存储与API的 status 应一致')
  })

  console.log('\n--- 4. Web 异常中断与重启恢复测试 ---')

  await runTest('Web 查询 pending 操作', async () => {
    cleanTestData()
    setupTestCommits()

    const ctx = { entry: 'web', userId: 'webPendingUser', userName: 'Web待处理用户' }
    const beginResult = operationAudit.beginOperation(
      'apply',
      'draft:web-pending:apply',
      ctx,
      { commits: store.loadCommits(), drafts: store.loadDrafts() }
    )
    assert(beginResult.success)

    const res = await httpRequestAsync('GET', '/api/audit/pending')
    assert(res.status === 200)
    assert(res.body.pending.length > 0, '应有 pending 操作')
    assert(res.body.pending.some(p => p.recordId === beginResult.recordId), '应包含刚创建的 pending 操作')

    operationAudit.failOperation(beginResult.recordId, '清理测试')
  })

  await runTest('Web 触发恢复 pending 操作', async () => {
    cleanTestData()
    setupTestCommits()

    const ctx = { entry: 'web', userId: 'webRecoverUser', userName: 'Web恢复用户' }
    const beginResult = operationAudit.beginOperation(
      'apply',
      'draft:web-recover:apply',
      ctx,
      { commits: store.loadCommits(), drafts: store.loadDrafts() }
    )
    assert(beginResult.success)

    const res = await httpRequestAsync('POST', '/api/audit/recover-pending')
    assert(res.status === 200)
    assert(res.body.success, '恢复应成功')
    assert(res.body.recovered > 0, '应至少恢复1条')

    const record = operationAudit.getRecord(beginResult.recordId)
    assert(record.status === 'recovered', `状态应为 recovered，实际: ${record.status}`)
  })

  console.log('\n--- 5. Web 并发冲突测试 ---')

  await runTest('Web 查询锁信息', async () => {
    cleanTestData()
    setupTestCommits()

    const ctx1 = { entry: 'web', userId: 'lockerUser', userName: '加锁用户' }
    const beginResult = operationAudit.beginOperation(
      'apply',
      'draft:web-lock-test:apply',
      ctx1,
      { commits: [], drafts: [] }
    )
    assert(beginResult.success)

    const res = await httpRequestAsync('GET', '/api/audit/locks')
    assert(res.status === 200)
    assert(res.body.locks['draft:web-lock-test:apply'], '应有锁信息')
    assert(res.body.locks['draft:web-lock-test:apply'].operator === 'lockerUser', '锁持有者应为 lockerUser')

    operationAudit.failOperation(beginResult.recordId, '清理测试')
  })

  console.log('\n--- 6. Web 回滚与撤销测试 ---')

  await runTest('Web 回滚已提交操作', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web回滚草稿', version: 'vw5.0.0', userId: 'webRollbackUser', userName: 'Web回滚用户' })
    assert(createResult.success)

    const originalCommits = store.loadCommits()

    const applyRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webRollbackUser',
      userName: 'Web回滚用户',
      sessionId: 'sess-web-rollback'
    })
    assert(applyRes.body.success)
    const recordId = applyRes.body._auditRecordId

    const rollbackRes = await httpRequestAsync('POST', `/api/audit/records/${recordId}/rollback`, {
      userId: 'webRollbackUser',
      userName: 'Web回滚用户'
    })
    assert(rollbackRes.status === 200)
    assert(rollbackRes.body.success, '回滚应成功')

    const afterRollbackCommits = store.loadCommits()
    assert(afterRollbackCommits.length === originalCommits.length, '回滚后 commits 应恢复')
  })

  await runTest('Web 撤销回滚', async () => {
    const undoRes = await httpRequestAsync('POST', '/api/audit/undo')
    assert(undoRes.status === 200)
    assert(undoRes.body.success, '撤销应成功')
  })

  await runTest('Web peekUndo', async () => {
    const res = await httpRequestAsync('GET', '/api/audit/undo/peek')
    assert(res.status === 200)
  })

  console.log('\n--- 7. Web JSON 导入导出测试 ---')

  await runTest('Web 导出审计数据', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web导出草稿', version: 'vw6.0.0', userId: 'webExportUser', userName: 'Web导出用户' })
    assert(createResult.success)

    await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webExportUser',
      userName: 'Web导出用户'
    })

    const res = await httpRequestAsync('POST', '/api/audit/export', {})
    assert(res.status === 200)
    assert(res.body.type === 'operation-audit-export', '导出类型应正确')
    assert(res.body.records.length > 0, '应有记录')
    assert(res.body.exportedAt, '应有导出时间')
  })

  await runTest('Web 导入审计数据', async () => {
    const exportRes = await httpRequestAsync('POST', '/api/audit/export', {})

    cleanTestData()
    setupTestCommits()

    const importRes = await httpRequestAsync('POST', '/api/audit/import', {
      auditData: exportRes.body
    })
    assert(importRes.status === 200)
    assert(importRes.body.success, '导入应成功')
    assert(importRes.body.importedCount > 0, '应导入记录')
  })

  console.log('\n--- 8. Web 审计日志测试 ---')

  await runTest('Web 查询审计日志', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web日志草稿', version: 'vw7.0.0', userId: 'webLogUser', userName: 'Web日志用户' })
    assert(createResult.success)

    await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webLogUser',
      userName: 'Web日志用户'
    })

    const res = await httpRequestAsync('GET', '/api/audit/logs')
    assert(res.status === 200)
    assert(res.body.logs.length > 0, '应有审计日志')
  })

  console.log('\n--- 9. Web 状态接口测试 ---')

  await runTest('Web 审计状态接口', async () => {
    const res = await httpRequestAsync('GET', '/api/audit/status')
    assert(res.status === 200)
    assert(res.body.totalRecords !== undefined, '应有 totalRecords')
    assert(res.body.pendingOperations !== undefined, '应有 pendingOperations')
    assert(res.body.activeLocks !== undefined, '应有 activeLocks')
    assert(res.body.byStatus !== undefined, '应有 byStatus')
    assert(res.body.byAction !== undefined, '应有 byAction')
  })

  await runTest('Web 审计记录列表过滤', async () => {
    const res = await httpRequestAsync('GET', '/api/audit/records?action=apply&entry=web')
    assert(res.status === 200)
    assert(Array.isArray(res.body.records), '应返回 records 数组')
    if (res.body.records.length > 0) {
      res.body.records.forEach(r => {
        assert(r.action === 'apply', '过滤后 action 应为 apply')
        assert(r.entry === 'web', '过滤后 entry 应为 web')
      })
    }
  })

  console.log('\n--- 10. Web Header 传递审计上下文测试 ---')

  await runTest('Web 通过 X-User-Id 头传递用户信息', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web头部草稿', version: 'vw8.0.0', userId: 'headerUser', userName: '头部用户' })
    assert(createResult.success)

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {}, {
      'X-User-Id': 'headerUser',
      'X-User-Name': encodeURIComponent('头部用户'),
      'X-Session-Id': 'header-sess-001'
    })
    assert(res.status === 200, `应返回200，实际: ${res.status}`)
    assert(res.body.success, 'apply 应成功')
    assert(res.body._auditRecordId, '应返回审计记录ID')

    const record = operationAudit.getRecord(res.body._auditRecordId)
    assert(record.userId === 'headerUser', 'userId 应来自 X-User-Id 头')
    assert(record.userName === '头部用户', 'userName 应来自 X-User-Name 头(已解码)')
    assert(record.sessionId === 'header-sess-001', 'sessionId 应来自 X-Session-Id 头')
  })

  await runTest('Web body 优先级高于 header', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({ name: 'Web优先级草稿', version: 'vw9.0.0', userId: 'bodyUser', userName: 'Body用户' })
    assert(createResult.success)

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'bodyUser',
      userName: 'Body用户',
      sessionId: 'body-sess-002'
    }, {
      'X-User-Id': 'headerUser',
      'X-User-Name': encodeURIComponent('Header用户')
    })
    assert(res.status === 200)
    assert(res.body.success)

    const record = operationAudit.getRecord(res.body._auditRecordId)
    assert(record.userId === 'bodyUser', 'body 的 userId 应优先于 header')
    assert(record.userName === 'Body用户', 'body 的 userName 应优先于 header')
    assert(record.sessionId === 'body-sess-002', 'sessionId 应来自 body')
  })

  console.log('\n--- 11. Web 中断点与恢复测试 ---')

  await runTest('Web apply 中断 before_apply_fn 后通过 recover-pending 恢复', async () => {
    cleanTestData()
    setupTestCommits()
    operationAudit.clearInterruptHooks()

    const createResult = draft.createDraft({
      name: 'Web中断恢复草稿1',
      version: 'vw11.0.0',
      userId: 'webInterruptUser',
      userName: 'Web中断用户'
    })
    assert(createResult.success)

    const draftsBefore = store.loadDrafts()
    const commitsBefore = store.loadCommits()

    operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})

    const res = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webInterruptUser',
      userName: 'Web中断用户',
      sessionId: 'web-sess-int-01',
      requestId: 'web-req-int-01'
    })

    assert(res.status === 500 || res.body.interrupted, `应返回中断状态，实际status: ${res.status}`)
    assert(res.body.interrupted || res.body._auditRecordId, '应标记为中断或包含记录ID')

    const recoverRes = await httpRequestAsync('POST', '/api/audit/recover-pending', {})
    assert(recoverRes.status === 200, '恢复接口应返回200')
    assert(recoverRes.body.success, '恢复应成功')
    assert(recoverRes.body.recovered >= 0, '恢复结果应有计数')

    const recordId = res.body._auditRecordId
    if (recordId) {
      const recoveredRecord = operationAudit.getRecord(recordId)
      assert(recoveredRecord.status === operationAudit.OP_STATUS_RECOVERED, `状态应为 recovered，实际为 ${recoveredRecord.status}`)
    }

    const draftsAfter = store.loadDrafts()
    const commitsAfter = store.loadCommits()
    assert(JSON.stringify(draftsAfter) === JSON.stringify(draftsBefore), '恢复后 drafts 应一致')
    assert(JSON.stringify(commitsAfter) === JSON.stringify(commitsBefore), '恢复后 commits 应一致')

    operationAudit.clearInterruptHooks()
  })

  await runTest('Web archive 中断后可恢复，并可通过 audit/undo 撤销恢复', async () => {
    cleanTestData()
    setupTestCommits()
    operationAudit.clearInterruptHooks()

    const createResult = draft.createDraft({
      name: 'Web中断归档草稿',
      version: 'vw11.1.0',
      userId: 'webArcIntUser',
      userName: '归档中断用户'
    })
    assert(createResult.success)
    const draftsBefore = store.loadDrafts()

    operationAudit.setInterruptHook('AUTO_MAP', 'before_archive_fn', () => {})

    const archiveRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/archive`, {
      userId: 'webArcIntUser',
      userName: '归档中断用户',
      sessionId: 'web-sess-arc-int'
    })
    assert(archiveRes.status === 500 || archiveRes.body.interrupted)

    const recoverRes = await httpRequestAsync('POST', '/api/audit/recover-pending', {})
    assert(recoverRes.body.success)

    const undoRes = await httpRequestAsync('POST', '/api/audit/undo', {})
    assert(undoRes.status === 200)
    assert(undoRes.body.success, '撤销应成功')
    assert(undoRes.body.undone > 0, '应撤销至少1条')

    operationAudit.clearInterruptHooks()
  })

  console.log('\n--- 12. Web 模拟进程重启恢复测试 ---')

  await runTest('Web 通过 recover-pending 模拟重启并补齐 interrupted 状态', async () => {
    cleanTestData()
    setupTestCommits()
    operationAudit.clearInterruptHooks()

    const createResult = draft.createDraft({
      name: 'Web重启恢复草稿',
      version: 'vw12.0.0',
      userId: 'webRestartUser',
      userName: 'Web重启用户'
    })
    assert(createResult.success)

    operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})

    const applyRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webRestartUser',
      userName: 'Web重启用户',
      sessionId: 'web-sess-restart-01'
    })
    assert(applyRes.status === 500 || applyRes.body.interrupted)
    operationAudit.clearInterruptHooks()

    const recordId = applyRes.body._auditRecordId
    assert(recordId, '应有 _auditRecordId')

    const rawAudit = store.loadOperationAudit()
    const pendingOps = rawAudit.pendingOps.filter(p => p.recordId === recordId)
    assert(pendingOps.length > 0, 'pendingOps 中应有该记录')

    const recoverRes = await httpRequestAsync('POST', '/api/audit/recover-pending', {})
    assert(recoverRes.status === 200)
    assert(recoverRes.body.success)
    assert(recoverRes.body.recovered >= 1, '至少恢复1条')

    const finalRecord = operationAudit.getRecord(recordId)
    assert(finalRecord.status === operationAudit.OP_STATUS_RECOVERED, '最终状态应为 recovered')
    assert(finalRecord.recoveredFrom.startsWith('interrupted_'), 'recoveredFrom 应为 interrupted_*')
    assert(finalRecord.recoveryType === 'restored_before_snapshot', 'recoveryType 应为 restored_before_snapshot')

    const records = operationAudit.listRecords()
    const noPending = records.filter(r => r.status === operationAudit.OP_STATUS_PENDING)
    assert(noPending.length === 0, `不应有 pending 状态，实际有 ${noPending.length} 条`)

    const interruptions = operationAudit.listInterruptions(50)
    const matchRecovered = interruptions.find(i => i.recordId === recordId && i.type === 'recovered')
    assert(matchRecovered, '中断记录表中应存在 recovered 类型条目')
  })

  console.log('\n--- 13. Web 并发冲突与分支记录测试 ---')

  await runTest('Web 并发 apply 生成冲突分支记录', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({
      name: 'Web并发冲突草稿',
      version: 'vw13.0.0',
      userId: 'webHolder',
      userName: 'Web持有者'
    })
    assert(createResult.success)

    const ctxHolder = { entry: 'web', userId: 'webHolder', userName: 'Web持有者', sessionId: 'web-sess-holder', requestId: 'web-req-holder' }
    const beginHolder = operationAudit.beginOperation(
      operationAudit.ACTION_APPLY,
      `draft:${createResult.draft.id}:apply`,
      ctxHolder,
      { commits: [], drafts: [] },
      { action: operationAudit.ACTION_APPLY }
    )
    assert(beginHolder.success, '持有者 begin 应成功')

    const challengerRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webChallenger',
      userName: 'Web挑战者',
      sessionId: 'web-sess-challenger',
      requestId: 'web-req-challenger'
    })

    assert(challengerRes.status === 409 || challengerRes.body.conflictBranchId, `应返回冲突状态，实际status: ${challengerRes.status}`)
    assert(challengerRes.body.conflictBranchId, '应有 conflictBranchId')
    assert(challengerRes.body.conflict, '应有 conflict 信息')
    assert(challengerRes.body.conflict.holder === 'webHolder', '持有者应为 webHolder')
    assert(challengerRes.body.conflict.holderEntry === 'web', '持有者来源应为 web')

    const branchList = operationAudit.listConflictBranches()
    assert(branchList.length > 0, '应有冲突分支记录')
    const matchBranch = branchList.find(b => b.branchId === challengerRes.body.conflictBranchId)
    assert(matchBranch, '应能查到对应分支')
    assert(matchBranch.holder.userId === 'webHolder', '分支里 holder 正确')
    assert(matchBranch.challenger.userId === 'webChallenger', '分支里 challenger 正确')
    assert(matchBranch.status === 'open', '初始状态应为 open')

    const logs = operationAudit.listLogs(50)
    const conflictLog = logs.find(l => l.action === 'lock_conflict' && l.branchId === challengerRes.body.conflictBranchId)
    assert(conflictLog, 'operation_audit_logs 应有 lock_conflict')

    operationAudit.failOperation(beginHolder.recordId, '测试完成释放锁')
  })

  await runTest('Web 管理员解决冲突分支并记录', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({
      name: 'Web冲突解决草稿',
      version: 'vw13.1.0',
      userId: 'webResHolder',
      userName: 'Web解决持有者'
    })
    assert(createResult.success)

    const ctxHolder = { entry: 'web', userId: 'webResHolder', userName: 'Web解决持有者' }
    const beginHolder = operationAudit.beginOperation(
      operationAudit.ACTION_APPLY,
      `draft:${createResult.draft.id}:apply`,
      ctxHolder,
      { commits: [], drafts: [] },
      { action: operationAudit.ACTION_APPLY }
    )

    const challengerRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webResChallenger',
      userName: 'Web解决挑战者'
    })
    assert(challengerRes.body.conflictBranchId, '应生成冲突分支')

    const resolveRes = await httpRequestAsync('POST', `/api/audit/conflicts/${challengerRes.body.conflictBranchId}/resolve`, {
      resolution: 'retry_allowed',
      userId: 'webAdmin',
      userName: 'Web管理员',
      entry: 'web'
    })
    assert(resolveRes.status === 200, `应返回200，实际: ${resolveRes.status}`)
    assert(resolveRes.body.success, '解决冲突应成功')

    const afterBranch = operationAudit.getConflictBranch(challengerRes.body.conflictBranchId)
    assert(afterBranch.status === 'resolved', '冲突状态应为 resolved')
    assert(afterBranch.resolution === 'retry_allowed', '解决方案应记录')
    assert(afterBranch.resolver.userId === 'webAdmin', '解决者信息正确')

    operationAudit.failOperation(beginHolder.recordId, '释放锁')
  })

  console.log('\n--- 14. Web 审计一致性三角验证（存储/返回/日志） ---')

  await runTest('Web apply：存储记录、HTTP返回、日志三方一致', async () => {
    cleanTestData()
    setupTestCommits()

    const createResult = draft.createDraft({
      name: 'Web三角验证草稿',
      version: 'vw14.0.0',
      userId: 'webTriUser',
      userName: 'Web三角用户'
    })
    assert(createResult.success)

    const applyRes = await httpRequestAsync('POST', `/api/drafts/${createResult.draft.id}/apply`, {
      userId: 'webTriUser',
      userName: 'Web三角用户',
      sessionId: 'web-sess-tri-01',
      requestId: 'web-req-tri-01'
    })
    assert(applyRes.status === 200 && applyRes.body.success, 'apply 应成功')

    const rid = applyRes.body._auditRecordId
    assert(rid, '返回应含 _auditRecordId')
    assert(applyRes.body._auditEntry === 'web', '返回 _auditEntry 正确')
    assert(applyRes.body._auditUserId === 'webTriUser', '返回 _auditUserId 正确')
    assert(applyRes.body._auditTriggeredAt, '返回触发时间')

    const record = operationAudit.getRecord(rid)
    assert(record.id === rid, '存储记录ID一致')
    assert(record.entry === 'web', '存储 entry 一致')
    assert(record.userId === 'webTriUser', '存储 userId 一致')
    assert(record.userName === 'Web三角用户', '存储 userName 一致')
    assert(record.sessionId === 'web-sess-tri-01', '存储 sessionId 一致')
    assert(record.requestId === 'web-req-tri-01', '存储 requestId 一致')
    assert(record.triggeredAt === applyRes.body._auditTriggeredAt, '存储 triggeredAt 与返回一致')
    assert(record.action === operationAudit.ACTION_APPLY, '存储 action 正确')
    assert(record.status === operationAudit.OP_STATUS_COMMITTED, '存储 status 正确')
    assert(record.beforeSnapshot && record.afterSnapshot, '存储前后快照存在')

    const logs = operationAudit.listLogs(100)
    const beginLog = logs.find(l => l.action === 'begin_operation' && l.recordId === rid)
    assert(beginLog, '日志里应有 begin_operation')
    assert(beginLog.entry === 'web', 'beginLog entry 一致')
    assert(beginLog.userId === 'webTriUser', 'beginLog userId 一致')
    assert(beginLog.targetKey === `draft:${createResult.draft.id}:apply`, 'beginLog targetKey 一致')

    const commitLog = logs.find(l => l.action === 'commit_operation' && l.recordId === rid)
    assert(commitLog, '日志里应有 commit_operation')
    assert(commitLog.status === operationAudit.OP_STATUS_COMMITTED, 'commitLog status 正确')
  })

  await runTest('Web import：三方一致性验证', async () => {
    cleanTestData()
    setupTestCommits()

    const importData = {
      type: 'release-notes-draft',
      draft: {
        name: 'Web导入三角验证',
        version: 'vw14.2.0',
        description: 'Web导入测试',
        commits: [{ id: 'web-imp-c1', message: 'feat: Web导入提交', category: 'feature' }]
      }
    }

    const importRes = await httpRequestAsync('POST', '/api/drafts/import', {
      draftData: importData,
      userId: 'webImpTri',
      userName: 'Web导入三角用户',
      sessionId: 'web-sess-imp-tri-01',
      requestId: 'web-req-imp-tri-01'
    })
    assert(importRes.status === 200 && importRes.body.success, 'import 应成功')

    const rid = importRes.body._auditRecordId
    assert(rid, '返回应含 _auditRecordId')
    assert(importRes.body._auditEntry === 'web', '_auditEntry 正确')
    assert(importRes.body._auditUserId === 'webImpTri', '_auditUserId 正确')

    const record = operationAudit.getRecord(rid)
    assert(record.action === operationAudit.ACTION_IMPORT, '存储 action 正确')
    assert(record.entry === 'web', '存储 entry 一致')
    assert(record.userId === 'webImpTri', '存储 userId 一致')
    assert(record.sessionId === 'web-sess-imp-tri-01', '存储 sessionId 一致')
    assert(record.status === operationAudit.OP_STATUS_COMMITTED, '存储 status 正确')
    assert(record.beforeSnapshot && record.afterSnapshot, '前后快照存在')

    const logs = operationAudit.listLogs(100)
    const beginLog = logs.find(l => l.action === 'begin_operation' && l.recordId === rid)
    assert(beginLog && beginLog.actionType === operationAudit.ACTION_IMPORT, 'import beginLog 正确')
    const commitLog = logs.find(l => l.action === 'commit_operation' && l.recordId === rid)
    assert(commitLog, 'import commitLog 存在')
  })

  await stopTestServer()

  console.log('\n=== Web API 回归测试全部通过 ===')
  process.exit(0)
}

runWebTests().catch(e => {
  console.error('\n测试失败:', e.message)
  stopTestServer().then(() => process.exit(1))
})
