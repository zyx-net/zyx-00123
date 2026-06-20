const store = require('./store')

const ENTRY_WEB = 'web'
const ENTRY_CLI = 'cli'

const ACTION_APPLY = 'apply'
const ACTION_ARCHIVE = 'archive'
const ACTION_IMPORT = 'import'

const OP_STATUS_PENDING = 'pending'
const OP_STATUS_COMMITTED = 'committed'
const OP_STATUS_FAILED = 'failed'
const OP_STATUS_RECOVERED = 'recovered'
const OP_STATUS_ROLLED_BACK = 'rolled_back'

function _now() {
  return new Date().toISOString()
}

function _genAuditId() {
  return 'aud_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

function _loadAudit() {
  return store.loadOperationAudit()
}

function _saveAudit(data) {
  store.saveOperationAudit(data)
}

function _appendLog(entry) {
  store.appendOperationAuditLog({
    ...entry,
    timestamp: entry.timestamp || _now()
  })
}

function _loadUndo() {
  return store.loadOperationAuditUndo()
}

function _saveUndo(snapshot) {
  store.saveOperationAuditUndo(snapshot)
}

function _clearUndo() {
  store.clearOperationAuditUndo()
}

function _validateContext(context) {
  const errors = []
  if (!context) {
    errors.push('审计上下文不能为空')
    return errors
  }
  if (!context.entry || (context.entry !== ENTRY_WEB && context.entry !== ENTRY_CLI)) {
    errors.push('入口(entry)必须为 web 或 cli，不能为空或使用默认值')
  }
  if (!context.userId) {
    errors.push('请求用户(userId)不能为空，不能回退为 cli 或 anonymous')
  }
  if (context.userId === 'anonymous' || context.userId === 'cli') {
    errors.push('请求用户(userId)不能回退为 anonymous 或 cli')
  }
  return errors
}

function _acquireLock(targetKey, context) {
  const audit = _loadAudit()
  const existing = audit.lockTable[targetKey]
  if (existing) {
    const elapsed = Date.now() - new Date(existing.acquiredAt).getTime()
    if (elapsed < 30 * 60 * 1000) {
      return {
        success: false,
        errors: [`对象 ${targetKey} 正在被 ${existing.operator} (${existing.operatorName}) 操作，来源 ${existing.entry}，无法并发执行`],
        conflict: {
          targetKey,
          holder: existing.operator,
          holderName: existing.operatorName,
          holderEntry: existing.entry,
          holderSessionId: existing.sessionId,
          acquiredAt: existing.acquiredAt
        }
      }
    }
  }
  audit.lockTable[targetKey] = {
    operator: context.userId,
    operatorName: context.userName || context.userId,
    entry: context.entry,
    sessionId: context.sessionId || null,
    requestId: context.requestId || null,
    acquiredAt: _now()
  }
  _saveAudit(audit)
  return { success: true }
}

function _releaseLock(targetKey) {
  const audit = _loadAudit()
  if (audit.lockTable[targetKey]) {
    delete audit.lockTable[targetKey]
    _saveAudit(audit)
  }
}

function beginOperation(action, targetKey, context, beforeSnapshot) {
  const validationErrors = _validateContext(context)
  if (validationErrors.length > 0) {
    return {
      success: false,
      errors: validationErrors,
      blocked: true,
      reason: 'invalid_audit_context'
    }
  }

  const lockResult = _acquireLock(targetKey, context)
  if (!lockResult.success) {
    return lockResult
  }

  const audit = _loadAudit()
  const recordId = _genAuditId()

  const record = {
    id: recordId,
    action,
    targetKey,
    entry: context.entry,
    userId: context.userId,
    userName: context.userName || context.userId,
    sessionId: context.sessionId || null,
    requestId: context.requestId || null,
    status: OP_STATUS_PENDING,
    beforeSnapshot: beforeSnapshot ? JSON.parse(JSON.stringify(beforeSnapshot)) : null,
    afterSnapshot: null,
    triggeredAt: _now(),
    completedAt: null,
    error: null
  }

  audit.records.push(record)
  if (audit.records.length > 200) {
    audit.records.splice(0, audit.records.length - 200)
  }

  const pendingOp = {
    recordId,
    action,
    targetKey,
    entry: context.entry,
    userId: context.userId,
    status: OP_STATUS_PENDING,
    createdAt: record.triggeredAt
  }
  audit.pendingOps.push(pendingOp)

  _saveAudit(audit)

  _appendLog({
    action: 'begin_operation',
    recordId,
    operationAction: action,
    targetKey,
    entry: context.entry,
    userId: context.userId
  })

  return { success: true, recordId, record }
}

function commitOperation(recordId, afterSnapshot) {
  const audit = _loadAudit()
  const record = audit.records.find(r => r.id === recordId)
  if (!record) {
    return { success: false, errors: ['审计记录不存在'] }
  }
  if (record.status !== OP_STATUS_PENDING) {
    return { success: false, errors: [`审计记录状态不是 pending，当前: ${record.status}`] }
  }

  record.status = OP_STATUS_COMMITTED
  record.afterSnapshot = afterSnapshot ? JSON.parse(JSON.stringify(afterSnapshot)) : null
  record.completedAt = _now()

  const pendingIdx = audit.pendingOps.findIndex(p => p.recordId === recordId)
  if (pendingIdx >= 0) {
    audit.pendingOps.splice(pendingIdx, 1)
  }

  delete audit.lockTable[record.targetKey]
  _saveAudit(audit)

  _appendLog({
    action: 'commit_operation',
    recordId,
    operationAction: record.action,
    targetKey: record.targetKey
  })

  return { success: true }
}

function failOperation(recordId, error) {
  const audit = _loadAudit()
  const record = audit.records.find(r => r.id === recordId)
  if (!record) {
    return { success: false, errors: ['审计记录不存在'] }
  }

  record.status = OP_STATUS_FAILED
  record.error = error || 'unknown error'
  record.completedAt = _now()

  const pendingIdx = audit.pendingOps.findIndex(p => p.recordId === recordId)
  if (pendingIdx >= 0) {
    audit.pendingOps[pendingIdx].status = OP_STATUS_FAILED
  }

  delete audit.lockTable[record.targetKey]
  _saveAudit(audit)

  _appendLog({
    action: 'fail_operation',
    recordId,
    operationAction: record.action,
    targetKey: record.targetKey,
    error
  })

  return { success: true }
}

function recoverPendingOperations() {
  const audit = _loadAudit()
  const pending = audit.pendingOps.filter(p => p.status === OP_STATUS_PENDING)
  if (pending.length === 0) {
    return { success: true, recovered: 0, total: 0, results: [] }
  }

  const results = []
  const currentDrafts = store.loadDrafts()
  const currentCommits = store.loadCommits()

  const undoSnapshot = {
    action: 'auto_recover',
    timestamp: _now(),
    previousDrafts: JSON.parse(JSON.stringify(currentDrafts)),
    previousCommits: JSON.parse(JSON.stringify(currentCommits)),
    recoveredRecordIds: []
  }

  let recovered = 0
  pending.forEach(pendingOp => {
    const record = audit.records.find(r => r.id === pendingOp.recordId)
    if (!record) {
      const idx = audit.pendingOps.findIndex(p => p.recordId === pendingOp.recordId)
      if (idx >= 0) audit.pendingOps.splice(idx, 1)
      results.push({ recordId: pendingOp.recordId, success: false, reason: '审计记录已丢失' })
      return
    }

    if (record.beforeSnapshot) {
      if (record.action === ACTION_APPLY && record.beforeSnapshot.commits) {
        store.saveCommits(JSON.parse(JSON.stringify(record.beforeSnapshot.commits)))
        record.status = OP_STATUS_RECOVERED
        record.completedAt = _now()
        const pIdx = audit.pendingOps.findIndex(p => p.recordId === record.id)
        if (pIdx >= 0) audit.pendingOps.splice(pIdx, 1)
        delete audit.lockTable[record.targetKey]
        recovered++
        undoSnapshot.recoveredRecordIds.push(record.id)
        results.push({ recordId: record.id, success: true, action: record.action })
      } else if (record.action === ACTION_ARCHIVE && record.beforeSnapshot.drafts) {
        store.saveDrafts(JSON.parse(JSON.stringify(record.beforeSnapshot.drafts)))
        if (record.beforeSnapshot.commits) {
          store.saveCommits(JSON.parse(JSON.stringify(record.beforeSnapshot.commits)))
        }
        record.status = OP_STATUS_RECOVERED
        record.completedAt = _now()
        const pIdx = audit.pendingOps.findIndex(p => p.recordId === record.id)
        if (pIdx >= 0) audit.pendingOps.splice(pIdx, 1)
        delete audit.lockTable[record.targetKey]
        recovered++
        undoSnapshot.recoveredRecordIds.push(record.id)
        results.push({ recordId: record.id, success: true, action: record.action })
      } else if (record.action === ACTION_IMPORT && record.beforeSnapshot.drafts) {
        store.saveDrafts(JSON.parse(JSON.stringify(record.beforeSnapshot.drafts)))
        record.status = OP_STATUS_RECOVERED
        record.completedAt = _now()
        const pIdx = audit.pendingOps.findIndex(p => p.recordId === record.id)
        if (pIdx >= 0) audit.pendingOps.splice(pIdx, 1)
        delete audit.lockTable[record.targetKey]
        recovered++
        undoSnapshot.recoveredRecordIds.push(record.id)
        results.push({ recordId: record.id, success: true, action: record.action })
      } else {
        record.status = OP_STATUS_FAILED
        record.error = '无法自动恢复: 缺少 beforeSnapshot 数据'
        record.completedAt = _now()
        const pIdx = audit.pendingOps.findIndex(p => p.recordId === record.id)
        if (pIdx >= 0) audit.pendingOps.splice(pIdx, 1)
        delete audit.lockTable[record.targetKey]
        results.push({ recordId: record.id, success: false, reason: '无法自动恢复' })
      }
    } else {
      record.status = OP_STATUS_FAILED
      record.error = '无法自动恢复: beforeSnapshot 为空'
      record.completedAt = _now()
      const pIdx = audit.pendingOps.findIndex(p => p.recordId === record.id)
      if (pIdx >= 0) audit.pendingOps.splice(pIdx, 1)
      delete audit.lockTable[record.targetKey]
      results.push({ recordId: record.id, success: false, reason: 'beforeSnapshot 为空' })
    }
  })

  _saveAudit(audit)

  if (recovered > 0) {
    _saveUndo(undoSnapshot)
  }

  _appendLog({
    action: 'auto_recover',
    pendingCount: pending.length,
    recoveredCount: recovered
  })

  return { success: true, recovered, total: pending.length, results }
}

function rollbackOperation(recordId, context) {
  const audit = _loadAudit()
  const record = audit.records.find(r => r.id === recordId)
  if (!record) {
    return { success: false, errors: ['审计记录不存在'] }
  }
  if (record.status !== OP_STATUS_COMMITTED && record.status !== OP_STATUS_RECOVERED) {
    return { success: false, errors: ['只能回滚已提交或已恢复的操作'] }
  }

  if (!record.beforeSnapshot) {
    return { success: false, errors: ['无法回滚: beforeSnapshot 为空'] }
  }

  const currentDrafts = store.loadDrafts()
  const currentCommits = store.loadCommits()

  const undoSnapshot = {
    action: 'rollback',
    recordId,
    timestamp: _now(),
    previousDrafts: JSON.parse(JSON.stringify(currentDrafts)),
    previousCommits: JSON.parse(JSON.stringify(currentCommits)),
    operator: context ? context.userId : record.userId,
    operatorName: context ? (context.userName || context.userId) : record.userName
  }

  if (record.beforeSnapshot.commits) {
    store.saveCommits(JSON.parse(JSON.stringify(record.beforeSnapshot.commits)))
  }
  if (record.beforeSnapshot.drafts) {
    store.saveDrafts(JSON.parse(JSON.stringify(record.beforeSnapshot.drafts)))
  }

  record.status = OP_STATUS_ROLLED_BACK
  record.completedAt = _now()

  _saveAudit(audit)
  _saveUndo(undoSnapshot)

  _appendLog({
    action: 'rollback',
    recordId,
    operationAction: record.action,
    targetKey: record.targetKey,
    operator: context ? context.userId : record.userId
  })

  return { success: true, recordId }
}

function undoLastRecoveryOrRollback() {
  const undoSnap = _loadUndo()
  if (!undoSnap) {
    return { success: false, reason: '没有可撤销的恢复或回滚操作' }
  }

  store.saveDrafts(JSON.parse(JSON.stringify(undoSnap.previousDrafts)))
  store.saveCommits(JSON.parse(JSON.stringify(undoSnap.previousCommits)))

  _clearUndo()

  _appendLog({
    action: 'undo_recovery_or_rollback',
    originalAction: undoSnap.action,
    recordId: undoSnap.recordId || null
  })

  return {
    success: true,
    action: undoSnap.action,
    recordId: undoSnap.recordId || null,
    timestamp: undoSnap.timestamp
  }
}

function peekUndo() {
  return _loadUndo()
}

function listRecords(options) {
  options = options || {}
  const audit = _loadAudit()
  let list = audit.records.slice()

  if (options.action) list = list.filter(r => r.action === options.action)
  if (options.entry) list = list.filter(r => r.entry === options.entry)
  if (options.userId) list = list.filter(r => r.userId === options.userId)
  if (options.status) list = list.filter(r => r.status === options.status)
  if (options.targetKey) list = list.filter(r => r.targetKey === options.targetKey)

  list.sort((a, b) => new Date(b.triggeredAt) - new Date(a.triggeredAt))
  return list
}

function getRecord(recordId) {
  const audit = _loadAudit()
  return audit.records.find(r => r.id === recordId) || null
}

function getPendingOperations() {
  const audit = _loadAudit()
  return audit.pendingOps.filter(p => p.status === OP_STATUS_PENDING).slice()
}

function getLockInfo(targetKey) {
  const audit = _loadAudit()
  return audit.lockTable[targetKey] || null
}

function getLockTable() {
  const audit = _loadAudit()
  return { ...audit.lockTable }
}

function getStatus() {
  const audit = _loadAudit()
  const pending = audit.pendingOps.filter(p => p.status === OP_STATUS_PENDING).length
  const total = audit.records.length
  const byStatus = {}
  audit.records.forEach(r => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1
  })
  const byAction = {}
  audit.records.forEach(r => {
    byAction[r.action] = (byAction[r.action] || 0) + 1
  })
  return {
    totalRecords: total,
    pendingOperations: pending,
    activeLocks: Object.keys(audit.lockTable).length,
    byStatus,
    byAction,
    hasUndo: !!_loadUndo()
  }
}

function exportAuditToJson(options) {
  options = options || {}
  const audit = _loadAudit()
  const logs = store.loadOperationAuditLogs()

  let records = audit.records
  if (options.status) records = records.filter(r => r.status === options.status)
  if (options.action) records = records.filter(r => r.action === options.action)

  return {
    schemaVersion: 1,
    type: 'operation-audit-export',
    exportedAt: _now(),
    records: JSON.parse(JSON.stringify(records)),
    pendingOps: JSON.parse(JSON.stringify(audit.pendingOps)),
    lockTable: JSON.parse(JSON.stringify(audit.lockTable)),
    logs: logs.slice(-100)
  }
}

function exportAuditToFile(outputPath, options) {
  const fs = require('fs')
  const path = require('path')
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    return { success: false, errors: [`输出目录不存在: ${dir}`] }
  }
  try {
    const data = exportAuditToJson(options)
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
    return { success: true, path: outputPath }
  } catch (e) {
    return { success: false, errors: [`写入文件失败: ${e.message}`] }
  }
}

function importAuditFromJson(data, options) {
  options = options || {}
  if (!data || data.type !== 'operation-audit-export') {
    return { success: false, errors: ['审计导入格式不正确：缺少 type=operation-audit-export'] }
  }
  if (!Array.isArray(data.records)) {
    return { success: false, errors: ['审计导入格式不正确：缺少 records 数组'] }
  }

  const audit = _loadAudit()
  const existingIds = new Set(audit.records.map(r => r.id))
  let importedCount = 0
  let skipped = 0
  let conflicts = []

  data.records.forEach(r => {
    if (!r || !r.id) {
      skipped++
      return
    }
    if (existingIds.has(r.id)) {
      if (options.force) {
        const idx = audit.records.findIndex(er => er.id === r.id)
        if (idx >= 0) audit.records[idx] = JSON.parse(JSON.stringify(r))
        importedCount++
      } else {
        conflicts.push(r.id)
        skipped++
      }
    } else {
      audit.records.push(JSON.parse(JSON.stringify(r)))
      importedCount++
    }
  })

  if (Array.isArray(data.pendingOps)) {
    data.pendingOps.forEach(p => {
      if (!audit.pendingOps.find(ep => ep.recordId === p.recordId)) {
        audit.pendingOps.push(JSON.parse(JSON.stringify(p)))
      }
    })
  }

  _saveAudit(audit)

  if (data.logs && Array.isArray(data.logs)) {
    const existingLogs = store.loadOperationAuditLogs()
    const merged = [...existingLogs]
    data.logs.forEach(l => {
      if (!merged.find(m => m.timestamp === l.timestamp && m.action === l.action && m.recordId === l.recordId)) {
        merged.push(l)
      }
    })
    merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    store.saveOperationAuditLogs(merged.slice(-300))
  }

  _appendLog({
    action: 'import',
    importedCount,
    skipped,
    conflictCount: conflicts.length,
    operator: options.operator
  })

  return { success: true, importedCount, skipped, conflictCount: conflicts.length, conflicts }
}

function importAuditFromFile(filePath, options) {
  const fs = require('fs')
  const path = require('path')
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(absPath)) {
    return { success: false, errors: [`文件不存在: ${absPath}`] }
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const data = JSON.parse(raw)
    return importAuditFromJson(data, options)
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { success: false, errors: [`JSON 解析失败: ${e.message}`] }
    }
    return { success: false, errors: [`读取文件失败: ${e.message}`] }
  }
}

function listLogs(limit) {
  const logs = store.loadOperationAuditLogs()
  const n = limit || 50
  return logs.slice(-n).reverse()
}

function orchestrateApply(draftId, context, applyFn) {
  const validationErrors = _validateContext(context)
  if (validationErrors.length > 0) {
    return {
      success: false,
      errors: validationErrors,
      blocked: true,
      reason: 'invalid_audit_context'
    }
  }

  const drafts = store.loadDrafts()
  const draft = drafts.find(d => d.id === draftId)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${draftId}`], blocked: false }
  }

  const targetKey = `draft:${draftId}:apply`
  const currentCommits = store.loadCommits()
  const beforeSnapshot = {
    commits: JSON.parse(JSON.stringify(currentCommits)),
    drafts: JSON.parse(JSON.stringify(drafts))
  }

  const beginResult = beginOperation(ACTION_APPLY, targetKey, context, beforeSnapshot)
  if (!beginResult.success) {
    return beginResult
  }

  const recordId = beginResult.recordId

  try {
    const result = applyFn()

    if (result && result.success === false) {
      failOperation(recordId, (result.errors || ['operation failed']).join('; '))
      return result
    }

    const afterCommits = store.loadCommits()
    commitOperation(recordId, {
      commits: JSON.parse(JSON.stringify(afterCommits)),
      drafts: JSON.parse(JSON.stringify(store.loadDrafts()))
    })

    result._auditRecordId = recordId
    result._auditEntry = context.entry
    result._auditUserId = context.userId
    result._auditTriggeredAt = beginResult.record.triggeredAt
    return result
  } catch (e) {
    failOperation(recordId, e.message)
    return { success: false, errors: [e.message] }
  }
}

function orchestrateArchive(draftId, context, archiveFn) {
  const validationErrors = _validateContext(context)
  if (validationErrors.length > 0) {
    return {
      success: false,
      errors: validationErrors,
      blocked: true,
      reason: 'invalid_audit_context'
    }
  }

  const drafts = store.loadDrafts()
  const draft = drafts.find(d => d.id === draftId)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${draftId}`], blocked: false }
  }

  const targetKey = `draft:${draftId}:archive`
  const currentCommits = store.loadCommits()
  const beforeSnapshot = {
    commits: JSON.parse(JSON.stringify(currentCommits)),
    drafts: JSON.parse(JSON.stringify(drafts))
  }

  const beginResult = beginOperation(ACTION_ARCHIVE, targetKey, context, beforeSnapshot)
  if (!beginResult.success) {
    return beginResult
  }

  const recordId = beginResult.recordId

  try {
    const result = archiveFn()

    if (result && result.success === false) {
      failOperation(recordId, (result.errors || ['operation failed']).join('; '))
      return result
    }

    const afterDrafts = store.loadDrafts()
    const afterCommits = store.loadCommits()
    commitOperation(recordId, {
      drafts: JSON.parse(JSON.stringify(afterDrafts)),
      commits: JSON.parse(JSON.stringify(afterCommits))
    })

    result._auditRecordId = recordId
    result._auditEntry = context.entry
    result._auditUserId = context.userId
    result._auditTriggeredAt = beginResult.record.triggeredAt
    return result
  } catch (e) {
    failOperation(recordId, e.message)
    return { success: false, errors: [e.message] }
  }
}

function orchestrateImport(context, importFn, beforeSnapshot) {
  const validationErrors = _validateContext(context)
  if (validationErrors.length > 0) {
    return {
      success: false,
      errors: validationErrors,
      blocked: true,
      reason: 'invalid_audit_context'
    }
  }

  const targetKey = `import:${context.userId}:${_now()}`
  const drafts = store.loadDrafts()
  if (!beforeSnapshot) {
    beforeSnapshot = {
      drafts: JSON.parse(JSON.stringify(drafts))
    }
  }

  const beginResult = beginOperation(ACTION_IMPORT, targetKey, context, beforeSnapshot)
  if (!beginResult.success) {
    return beginResult
  }

  const recordId = beginResult.recordId

  try {
    const result = importFn()

    if (result && result.success === false) {
      failOperation(recordId, (result.errors || ['operation failed']).join('; '))
      return result
    }

    const afterDrafts = store.loadDrafts()
    commitOperation(recordId, {
      drafts: JSON.parse(JSON.stringify(afterDrafts))
    })

    result._auditRecordId = recordId
    result._auditEntry = context.entry
    result._auditUserId = context.userId
    result._auditTriggeredAt = beginResult.record.triggeredAt
    return result
  } catch (e) {
    failOperation(recordId, e.message)
    return { success: false, errors: [e.message] }
  }
}

module.exports = {
  ENTRY_WEB,
  ENTRY_CLI,
  ACTION_APPLY,
  ACTION_ARCHIVE,
  ACTION_IMPORT,
  OP_STATUS_PENDING,
  OP_STATUS_COMMITTED,
  OP_STATUS_FAILED,
  OP_STATUS_RECOVERED,
  OP_STATUS_ROLLED_BACK,
  beginOperation,
  commitOperation,
  failOperation,
  recoverPendingOperations,
  rollbackOperation,
  undoLastRecoveryOrRollback,
  peekUndo,
  listRecords,
  getRecord,
  getPendingOperations,
  getLockInfo,
  getLockTable,
  getStatus,
  exportAuditToJson,
  exportAuditToFile,
  importAuditFromJson,
  importAuditFromFile,
  listLogs,
  orchestrateApply,
  orchestrateArchive,
  orchestrateImport
}
