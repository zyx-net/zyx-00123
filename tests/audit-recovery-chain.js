const fs = require('fs')
const path = require('path')
const http = require('http')

const store = require('../src/store')
const draft = require('../src/draft')
const operationAudit = require('../src/operationAudit')

const TEST_DATA_DIR = path.join(__dirname, '..', 'data')
const TEST_PORT = 13900

function cleanTestData() {
  const files = [
    'commits', 'archives', 'drafts', 'draft_logs', 'draft_undo', 'draft_undo_stack',
    'undo', 'config', 'version_registry', 'version_registry_logs', 'version_registry_undo',
    'operation_audit', 'operation_audit_logs', 'operation_audit_undo',
    'operation_audit_conflicts', 'operation_audit_interruptions',
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

async function runTestAsync(name, fn) {
  try {
    await fn()
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
    { id: 'rc1', message: 'feat: 恢复链路测试', category: 'feature', source: 'recovery-test', author: '测试员', date: '2025-02-20', reviewed: true, ticket: 'REC-101', issues: [], resolved: true }
  ]
  store.saveCommits(commits)
  return commits
}

function httpRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: pathname,
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' }
    }
    const req = http.request(opts, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = data }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

let serverInstance = null

function checkPortInUse(port) {
  return new Promise(resolve => {
    const tester = http.createServer()
    tester.once('error', err => {
      if (err.code === 'EADDRINUSE') resolve(true)
      else resolve(false)
    })
    tester.once('listening', () => {
      tester.close(() => resolve(false))
    })
    tester.listen(port)
  })
}

async function waitForPortFree(port, timeout = 5000, interval = 100) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const inUse = await checkPortInUse(port)
    if (!inUse) return true
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}

function startTestServer(retries = 5, retryDelay = 200) {
  return new Promise(async (resolve, reject) => {
    let attempt = 0
    while (attempt < retries) {
      try {
        await waitForPortFree(TEST_PORT, 2000, 100)
        const { handleApi } = require('../web/server')
        serverInstance = http.createServer(async (req, res) => {
          try {
            await handleApi(req, res, req.url)
          } catch (e) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: e.message }))
          }
        })
        await new Promise((res, rej) => {
          serverInstance.once('error', rej)
          serverInstance.listen(TEST_PORT, () => res())
        })
        return resolve()
      } catch (e) {
        attempt++
        if (attempt >= retries) return reject(e)
        if (serverInstance) {
          try { serverInstance.close() } catch {}
          serverInstance = null
        }
        await new Promise(r => setTimeout(r, retryDelay * attempt))
      }
    }
  })
}

function stopTestServer() {
  return new Promise(async resolve => {
    if (serverInstance) {
      serverInstance.close(async () => {
        serverInstance = null
        await waitForPortFree(TEST_PORT, 3000, 100)
        resolve()
      })
    } else {
      resolve()
    }
  })
}

console.log('=== 审计恢复链路高级验证测试 ===\n')

console.log('--- A. 未恢复项可见性：interrupted 状态在各查询入口均可见 ---\n')

runTest('A1. listRecords(status=interrupted) 返回中断记录', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: '可见性测试草稿',
    version: 'vis-1.0.0',
    userId: 'visUser',
    userName: '可见性用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'visUser', userName: '可见性用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})

  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.interrupted, '操作应被中断')

  const interruptedRecords = operationAudit.listRecords({ status: operationAudit.OP_STATUS_INTERRUPTED })
  assert(interruptedRecords.length >= 1, `应至少有 1 条 interrupted 记录，实际: ${interruptedRecords.length}`)

  const match = interruptedRecords.find(r => r.id === applyResult._auditRecordId)
  assert(match, '中断记录应能通过 status=interrupted 过滤到')
  assert(match.status === operationAudit.OP_STATUS_INTERRUPTED, `状态应为 interrupted，实际: ${match.status}`)
  assert(match.interruptStage === 'before_apply_fn', 'interruptStage 应正确')

  operationAudit.clearInterruptHooks()
})

runTest('A2. getPendingOperations 返回 interrupted 记录', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: 'pending可见性草稿',
    version: 'vis-1.1.0',
    userId: 'visUser2',
    userName: '可见性用户2'
  })
  assert(createResult.success)

  const ctx = { entry: 'web', userId: 'visUser2', userName: '可见性用户2' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_archive_fn', () => {})

  draft.archiveDraft(createResult.draft.id, { _auditContext: ctx, userId: 'visUser2', userName: '可见性用户2', _vaultSource: 'test' })

  const pending = operationAudit.getPendingOperations()
  assert(pending.length >= 1, `getPendingOperations 应至少返回 1 条，实际: ${pending.length}`)

  const hasInterrupted = pending.some(p => p.status === operationAudit.OP_STATUS_INTERRUPTED)
  assert(hasInterrupted, 'pending 列表中应包含 interrupted 状态的记录')

  operationAudit.clearInterruptHooks()
})

runTest('A3. getStatus 正确统计 interrupted 数量', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: 'getStatus统计草稿',
    version: 'vis-1.2.0',
    userId: 'statusUser',
    userName: '状态统计用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'statusUser', userName: '状态统计用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  const status = operationAudit.getStatus()
  assert(status.byStatus[operationAudit.OP_STATUS_INTERRUPTED] >= 1,
    `byStatus.interrupted 应 >= 1，实际: ${status.byStatus[operationAudit.OP_STATUS_INTERRUPTED]}`)
  assert(status.pendingOperations >= 1,
    `pendingOperations 应 >= 1，实际: ${status.pendingOperations}`)

  operationAudit.clearInterruptHooks()
})

runTest('A4. 中断记录与待恢复记录可区分：records.status 不同状态值', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: '状态区分草稿',
    version: 'vis-1.3.0',
    userId: 'diffUser',
    userName: '状态区分用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'diffUser', userName: '状态区分用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  const interruptedRecord = operationAudit.getRecord(applyResult._auditRecordId)
  assert(interruptedRecord.status === operationAudit.OP_STATUS_INTERRUPTED,
    `恢复前应为 interrupted，实际: ${interruptedRecord.status}`)

  const recoverResult = operationAudit.recoverPendingOperations()
  assert(recoverResult.success)

  const recoveredRecord = operationAudit.getRecord(applyResult._auditRecordId)
  assert(recoveredRecord.status === operationAudit.OP_STATUS_RECOVERED,
    `恢复后应为 recovered，实际: ${recoveredRecord.status}`)
  assert(recoveredRecord.status !== interruptedRecord.status,
    '恢复前后 status 应不同')
  assert(recoveredRecord.recoveredFrom === 'interrupted_apply', 'recoveredFrom 应正确')
  assert(recoveredRecord.recoveryType === 'restored_before_snapshot', 'recoveryType 应正确')

  operationAudit.clearInterruptHooks()
})

console.log('\n--- B. scanInterruptedOperations：服务重启时 pending→interrupted 规范化 ---\n')

runTest('B1. 崩溃前 pending 记录被自动规范化为 interrupted', () => {
  cleanTestData()
  setupTestCommits()

  const ctx = { entry: 'cli', userId: 'crashUser', userName: '崩溃用户' }
  const beginResult = operationAudit.beginOperation(
    operationAudit.ACTION_APPLY,
    'draft:crash-test:apply',
    ctx,
    { commits: JSON.parse(JSON.stringify(store.loadCommits())), drafts: JSON.parse(JSON.stringify(store.loadDrafts())) }
  )
  assert(beginResult.success)

  const rawAuditBefore = store.loadOperationAudit()
  const beforeRecord = rawAuditBefore.records.find(r => r.id === beginResult.recordId)
  assert(beforeRecord.status === operationAudit.OP_STATUS_PENDING,
    `规范化前 status 应为 pending，实际: ${beforeRecord.status}`)
  assert(!beforeRecord.completedAt, '规范化前 completedAt 应为空')

  const scanResult = operationAudit.scanInterruptedOperations()
  assert(scanResult.normalized >= 1, `应至少规范化 1 条，实际: ${scanResult.normalized}`)
  assert(scanResult.total >= 1, `待恢复总数应 >= 1，实际: ${scanResult.total}`)

  const afterRecord = operationAudit.getRecord(beginResult.recordId)
  assert(afterRecord.status === operationAudit.OP_STATUS_INTERRUPTED,
    `规范化后 status 应为 interrupted，实际: ${afterRecord.status}`)
  assert(afterRecord.interruptStage === 'between_begin_and_commit',
    `interruptStage 应为 between_begin_and_commit，实际: ${afterRecord.interruptStage}`)

  const rawAuditAfter = store.loadOperationAudit()
  const pendingOp = rawAuditAfter.pendingOps.find(p => p.recordId === beginResult.recordId)
  assert(pendingOp && pendingOp.status === operationAudit.OP_STATUS_INTERRUPTED,
    `pendingOps 中的状态也应为 interrupted，实际: ${pendingOp ? pendingOp.status : 'N/A'}`)
})

runTest('B2. 已 completed 的 pending 记录不会被误标为 interrupted', () => {
  cleanTestData()
  setupTestCommits()

  const ctx = { entry: 'web', userId: 'safeUser', userName: '安全用户' }
  const beginResult = operationAudit.beginOperation(
    operationAudit.ACTION_APPLY,
    'draft:safe-test:apply',
    ctx,
    { commits: store.loadCommits(), drafts: store.loadDrafts() }
  )
  operationAudit.commitOperation(beginResult.recordId, {
    commits: store.loadCommits(),
    drafts: store.loadDrafts()
  })

  const beforeRecord = operationAudit.getRecord(beginResult.recordId)
  assert(beforeRecord.status === operationAudit.OP_STATUS_COMMITTED,
    `已提交的记录状态应为 committed，实际: ${beforeRecord.status}`)

  const scanResult = operationAudit.scanInterruptedOperations()
  assert(scanResult.normalized === 0, `不应规范化任何记录，实际: ${scanResult.normalized}`)

  const afterRecord = operationAudit.getRecord(beginResult.recordId)
  assert(afterRecord.status === operationAudit.OP_STATUS_COMMITTED,
    `扫描后状态仍应为 committed，实际: ${afterRecord.status}`)
})

runTest('B3. scan 对已 interrupted 的记录是幂等的', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: '幂等扫描草稿',
    version: 'b3-1.0.0',
    userId: 'idempotentUser',
    userName: '幂等用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'idempotentUser', userName: '幂等用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  const scan1 = operationAudit.scanInterruptedOperations()
  const scan2 = operationAudit.scanInterruptedOperations()

  assert(scan2.normalized === 0, `第二次 scan 的 normalized 应为 0，实际: ${scan2.normalized}`)
  assert(scan1.total === scan2.total, '两次 scan 的 total 应相同')

  operationAudit.clearInterruptHooks()
})

console.log('\n--- C. CLI / Web 入口一致性 ---\n')

runTestAsync('C1. Web scan-interrupted API 与 CLI scanInterruptedOperations 结果一致', async () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()
  await startTestServer()

  const ctx = { entry: 'web', userId: 'consistencyUser', userName: '一致性用户' }
  operationAudit.beginOperation(
    operationAudit.ACTION_ARCHIVE,
    'draft:consistency-web:archive',
    ctx,
    { commits: store.loadCommits(), drafts: store.loadDrafts() }
  )

  const cliResult = operationAudit.scanInterruptedOperations()

  const webRes = await httpRequest('POST', '/api/audit/scan-interrupted')
  assert(webRes.status === 200, `Web API 应返回 200，实际: ${webRes.status}`)
  assert(webRes.body.success, 'Web API 返回 success 应为 true')

  assert(webRes.body.total === cliResult.total,
    `Web API total(${webRes.body.total}) 应与 CLI total(${cliResult.total}) 一致`)

  await stopTestServer()
  operationAudit.clearInterruptHooks()
})

runTestAsync('C2. Web recover-pending 与 CLI recoverPendingOperations 产生相同的状态流转', async () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()
  await startTestServer()

  const createResult = draft.createDraft({
    name: 'WebCLI一致性草稿',
    version: 'c2-1.0.0',
    userId: 'consistencyUser2',
    userName: '一致性用户2'
  })
  assert(createResult.success)

  const ctx = { entry: 'web', userId: 'consistencyUser2', userName: '一致性用户2' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  const applyRes = await httpRequest('POST', `/api/drafts/${createResult.draft.id}/apply`, {
    userId: 'consistencyUser2',
    userName: '一致性用户2',
    sessionId: 'web-sess-c2'
  })
  assert(applyRes.status === 500 || applyRes.body.interrupted, 'Web apply 应被中断')

  const recordId = applyRes.body._auditRecordId
  assert(recordId, '应返回 _auditRecordId')

  const beforeRecoverRecord = operationAudit.getRecord(recordId)
  assert(beforeRecoverRecord.status === operationAudit.OP_STATUS_INTERRUPTED,
    `恢复前 status 应为 interrupted，实际: ${beforeRecoverRecord.status}`)

  const webRecoverRes = await httpRequest('POST', '/api/audit/recover-pending')
  assert(webRecoverRes.status === 200, 'Web recover-pending 应返回 200')
  assert(webRecoverRes.body.success, 'Web recover-pending 应成功')
  assert(webRecoverRes.body.total >= 1, 'Web recover-pending 至少处理 1 条')
  assert(webRecoverRes.body.recovered >= 1, 'Web recover-pending 至少恢复 1 条')
  assert('normalized' in webRecoverRes.body, 'Web recover-pending 应返回 normalized 字段')

  const results = webRecoverRes.body.results
  assert(Array.isArray(results) && results.length >= 1, 'results 应是数组且非空')
  const myResult = results.find(r => r.recordId === recordId)
  assert(myResult, 'results 中应包含当前 recordId')
  assert(myResult.beforeStatus === operationAudit.OP_STATUS_INTERRUPTED,
    `beforeStatus 应为 interrupted，实际: ${myResult.beforeStatus}`)
  assert(myResult.afterStatus === operationAudit.OP_STATUS_RECOVERED,
    `afterStatus 应为 recovered，实际: ${myResult.afterStatus}`)
  assert(myResult.success === true, 'success 应为 true')

  const afterRecoverRecord = operationAudit.getRecord(recordId)
  assert(afterRecoverRecord.status === operationAudit.OP_STATUS_RECOVERED,
    `Web 恢复后 status 应为 recovered，实际: ${afterRecoverRecord.status}`)
  assert(afterRecoverRecord.recoveryType === 'restored_before_snapshot',
    `recoveryType 应为 restored_before_snapshot，实际: ${afterRecoverRecord.recoveryType}`)

  await stopTestServer()
  operationAudit.clearInterruptHooks()
})

runTestAsync('C3. CLI 创建的 interrupted 记录，Web 侧 pending API 可见', async () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()
  await startTestServer()

  const createResult = draft.createDraft({
    name: 'CLI创建Web查看草稿',
    version: 'c3-1.0.0',
    userId: 'cliToWebUser',
    userName: 'CLI转Web用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'cli', userId: 'cliToWebUser', userName: 'CLI转Web用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })
  assert(applyResult.interrupted, 'CLI apply 应被中断')

  const webPendingRes = await httpRequest('GET', '/api/audit/pending')
  assert(webPendingRes.status === 200, 'Web /api/audit/pending 应返回 200')
  assert(Array.isArray(webPendingRes.body.pending), 'pending 应是数组')

  const found = webPendingRes.body.pending.find(p => p.recordId === applyResult._auditRecordId)
  assert(found, 'Web pending API 应能看到 CLI 创建的中断记录')
  assert(found.status === operationAudit.OP_STATUS_INTERRUPTED,
    `Web 侧看到的 status 应为 interrupted，实际: ${found.status}`)
  assert(found.entry === 'cli', `Web 侧看到的 entry 应为 cli，实际: ${found.entry}`)
  assert(found.userId === 'cliToWebUser', `Web 侧看到的 userId 应为 cliToWebUser，实际: ${found.userId}`)

  await stopTestServer()
  operationAudit.clearInterruptHooks()
})

console.log('\n--- D. 服务重启前后恢复一致性 ---\n')

runTest('D1. 模拟服务重启：pending→scan→recover 完整链路', () => {
  cleanTestData()
  setupTestCommits()

  const ctx = { entry: 'cli', userId: 'restartUser', userName: '重启用户' }
  const beginResult = operationAudit.beginOperation(
    operationAudit.ACTION_APPLY,
    'draft:restart-test:apply',
    ctx,
    { commits: JSON.parse(JSON.stringify(store.loadCommits())), drafts: JSON.parse(JSON.stringify(store.loadDrafts())) }
  )
  assert(beginResult.success)

  const draftsBefore = store.loadDrafts()
  const commitsBefore = store.loadCommits()

  const scanResult = operationAudit.scanInterruptedOperations()
  assert(scanResult.normalized >= 1, `重启 scan 应至少规范化 1 条，实际: ${scanResult.normalized}`)
  assert(scanResult.total >= 1, `重启 scan 后待恢复总数应 >= 1，实际: ${scanResult.total}`)

  const recoverResult = operationAudit.recoverPendingOperations()
  assert(recoverResult.success, '重启恢复应成功')
  assert(recoverResult.recovered >= 1, `重启恢复应至少恢复 1 条，实际: ${recoverResult.recovered}`)

  const draftsAfter = store.loadDrafts()
  const commitsAfter = store.loadCommits()
  assert(JSON.stringify(draftsBefore) === JSON.stringify(draftsAfter), '重启恢复后 drafts 应一致')
  assert(JSON.stringify(commitsBefore) === JSON.stringify(commitsAfter), '重启恢复后 commits 应一致')

  const finalRecord = operationAudit.getRecord(beginResult.recordId)
  assert(finalRecord.status === operationAudit.OP_STATUS_RECOVERED,
    `最终状态应为 recovered，实际: ${finalRecord.status}`)
  assert(finalRecord.completedAt, '最终 completedAt 应存在')
  assert(finalRecord.recoveredFrom === 'interrupted_apply',
    `recoveredFrom 应为 interrupted_apply，实际: ${finalRecord.recoveredFrom}`)

  const finalPending = operationAudit.getPendingOperations()
  assert(finalPending.length === 0, `恢复后 pendingOps 应为空，实际: ${finalPending.length}`)

  const finalLocks = operationAudit.getLockTable()
  assert(Object.keys(finalLocks).length === 0, `恢复后锁表应为空，实际锁: ${Object.keys(finalLocks)}`)
})

runTest('D2. 重启恢复后 undoLastRecoveryOrRollback 能还原', () => {
  cleanTestData()
  setupTestCommits()

  const createResult = draft.createDraft({
    name: '重启撤销草稿',
    version: 'd2-1.0.0',
    userId: 'restartUndoUser',
    userName: '重启撤销用户'
  })
  assert(createResult.success)

  const draftsBeforeApply = JSON.parse(JSON.stringify(store.loadDrafts()))

  operationAudit.clearInterruptHooks()
  const ctx = { entry: 'cli', userId: 'restartUndoUser', userName: '重启撤销用户' }
  operationAudit.setInterruptHook('AUTO_MAP', 'after_apply_fn_before_commit', () => {})

  draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  operationAudit.scanInterruptedOperations()
  operationAudit.recoverPendingOperations()

  const draftsAfterRecover = store.loadDrafts()
  assert(JSON.stringify(draftsAfterRecover) === JSON.stringify(draftsBeforeApply),
    '恢复后 drafts 应回到 apply 前状态')

  const undoResult = operationAudit.undoLastRecoveryOrRollback()
  assert(undoResult.success, '撤销恢复应成功')
  assert(undoResult.action === 'recover', `action 应为 recover，实际: ${undoResult.action}`)
  assert(undoResult.undone >= 1, `应撤销至少 1 条，实际: ${undoResult.undone}`)

  operationAudit.clearInterruptHooks()
})

console.log('\n--- E. 状态与日志一致性三角验证 ---\n')

runTest('E1. 恢复后 records / pendingOps / logs / interruptions 四方一致', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const createResult = draft.createDraft({
    name: '一致性验证草稿',
    version: 'e1-1.0.0',
    userId: 'consistUser',
    userName: '一致性用户'
  })
  assert(createResult.success)

  const ctx = { entry: 'web', userId: 'consistUser', userName: '一致性用户', sessionId: 'sess-e1' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_apply_fn', () => {})
  const applyResult = draft.applyDraft(createResult.draft.id, { _auditContext: ctx })

  const recordId = applyResult._auditRecordId

  operationAudit.recoverPendingOperations()

  const record = operationAudit.getRecord(recordId)
  assert(record.status === operationAudit.OP_STATUS_RECOVERED,
    `record.status 应为 recovered，实际: ${record.status}`)
  assert(record.recoveryType === 'restored_before_snapshot',
    `record.recoveryType 应为 restored_before_snapshot，实际: ${record.recoveryType}`)
  assert(record.recoveredFrom === 'interrupted_apply',
    `record.recoveredFrom 应为 interrupted_apply，实际: ${record.recoveredFrom}`)

  const rawAudit = store.loadOperationAudit()
  const inPendingOps = rawAudit.pendingOps.find(p => p.recordId === recordId)
  assert(!inPendingOps, '恢复后 pendingOps 中不应再有该记录')

  const inLocks = rawAudit.lockTable[record.targetKey]
  assert(!inLocks, '恢复后锁表中不应再有该 targetKey')

  const interruptions = operationAudit.listInterruptions(100)
  const intRecovered = interruptions.find(i => i.recordId === recordId && i.type === 'recovered')
  assert(intRecovered, 'interruptions 表中应存在 type=recovered 条目')
  assert(intRecovered.recovered === true, 'interruptions.recovered 应为 true')
  assert(intRecovered.recoveryType === 'restored_before_snapshot',
    `interruptions.recoveryType 应匹配，实际: ${intRecovered.recoveryType}`)
  assert(intRecovered.stage === 'before_apply_fn',
    `interruptions.stage 应为 before_apply_fn，实际: ${intRecovered.stage}`)

  const logs = operationAudit.listLogs(100)
  const logRecover = logs.find(l => l.action === 'recover')
  assert(logRecover, 'logs 中应存在 action=recover 条目')
  assert(logRecover.recoveredCount >= 1,
    `logRecover.recoveredCount 应 >= 1，实际: ${logRecover.recoveredCount}`)
  assert(logRecover.pendingCount >= 1,
    `logRecover.pendingCount 应 >= 1，实际: ${logRecover.pendingCount}`)
  assert('normalizedCount' in logRecover, 'logs.recover 中应存在 normalizedCount 字段')

  const logBegin = logs.find(l => l.action === 'begin_operation' && l.recordId === recordId)
  assert(logBegin, 'logs 中应存在 begin_operation 条目')
  assert(logBegin.entry === 'web', `logBegin.entry 应为 web，实际: ${logBegin.entry}`)
  assert(logBegin.userId === 'consistUser', `logBegin.userId 应为 consistUser，实际: ${logBegin.userId}`)

  operationAudit.clearInterruptHooks()
})

runTest('E2. recover 结果中每条记录的 beforeStatus/afterStatus 与存储一致', () => {
  cleanTestData()
  setupTestCommits()
  operationAudit.clearInterruptHooks()

  const ctx1 = { entry: 'cli', userId: 'userA', userName: '用户A' }
  const beginA = operationAudit.beginOperation(
    operationAudit.ACTION_APPLY,
    'draft:multi-a:apply',
    ctx1,
    { commits: store.loadCommits(), drafts: store.loadDrafts() }
  )

  const createB = draft.createDraft({
    name: '多记录恢复B',
    version: 'e2-1.0.0',
    userId: 'userB',
    userName: '用户B'
  })
  assert(createB.success)
  const ctx2 = { entry: 'web', userId: 'userB', userName: '用户B' }
  operationAudit.setInterruptHook('AUTO_MAP', 'before_archive_fn', () => {})
  draft.archiveDraft(createB.draft.id, { _auditContext: ctx2, userId: 'userB', userName: '用户B', _vaultSource: 'test' })

  const result = operationAudit.recoverPendingOperations()
  assert(result.results.length === 2, `results 应有 2 条，实际: ${result.results.length}`)

  result.results.forEach(r => {
    assert(r.beforeStatus === operationAudit.OP_STATUS_INTERRUPTED,
      `record ${r.recordId} beforeStatus 应为 interrupted，实际: ${r.beforeStatus}`)
    if (r.success) {
      assert(r.afterStatus === operationAudit.OP_STATUS_RECOVERED,
        `成功记录 ${r.recordId} afterStatus 应为 recovered，实际: ${r.afterStatus}`)
      const stored = operationAudit.getRecord(r.recordId)
      assert(stored.status === r.afterStatus,
        `record ${r.recordId} 存储状态与 afterStatus 应一致`)
      assert(stored.recoveredFrom === `interrupted_${r.action}`,
        `record ${r.recordId} recoveredFrom 应匹配`)
    }
  })

  operationAudit.clearInterruptHooks()
})

console.log('\n=== 所有高级验证测试通过 ===')
