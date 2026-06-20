const store = require('./store')

const STATUS_PENDING = 'pending'
const STATUS_COMMITTED = 'committed'
const STATUS_RECOVERED = 'recovered'
const STATUS_ROLLED_BACK = 'rolled_back'
const STATUS_ARCHIVED = 'archived'

const SOURCE_WEB = 'web'
const SOURCE_CLI = 'cli'

const ACTION_CREATE = 'create'
const ACTION_UPDATE = 'update'
const ACTION_DUPLICATE = 'duplicate'
const ACTION_APPLY = 'apply'
const ACTION_IMPORT = 'import'
const ACTION_ARCHIVE = 'archive'
const ACTION_VERSION_CHANGE = 'version_change'

function _now() {
  return new Date().toISOString()
}

function _genVaultId() {
  return 'vt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

function _loadVault() {
  return store.loadDraftVault() || { snapshots: [], pendingTxns: [] }
}

function _saveVault(data) {
  store.saveDraftVault(data)
}

function _appendLog(entry) {
  store.appendDraftVaultLog({
    ...entry,
    timestamp: entry.timestamp || _now()
  })
}

function _loadRecoveryUndo() {
  return store.loadDraftVaultRecoveryUndo() || null
}

function _saveRecoveryUndo(snapshot) {
  store.saveDraftVaultRecoveryUndo(snapshot)
}

function _clearRecoveryUndo() {
  store.clearDraftVaultRecoveryUndo()
}

function createSnapshot(draftId, action, source, options) {
  options = options || {}
  const vault = _loadVault()
  const drafts = store.loadDrafts()
  const draft = drafts.find(d => d.id === draftId)

  const snapshot = {
    id: _genVaultId(),
    draftId: draftId || null,
    draftName: draft ? draft.name : (options.draftName || null),
    action,
    source: source || SOURCE_CLI,
    operator: options.operator || options.userId || 'anonymous',
    operatorName: options.operatorName || options.userName || '匿名用户',
    status: STATUS_PENDING,
    body: draft ? JSON.parse(JSON.stringify(draft.commits)) : (options.body || []),
    summary: draft ? draft.description : (options.summary || ''),
    version: draft ? draft.version : (options.version || ''),
    name: draft ? draft.name : (options.name || ''),
    draftSnapshot: draft ? JSON.parse(JSON.stringify(draft)) : null,
    draftsSnapshot: JSON.parse(JSON.stringify(drafts)),
    commitsSnapshot: JSON.parse(JSON.stringify(store.loadCommits())),
    versionRegistrySnapshot: JSON.parse(JSON.stringify(store.loadVersionRegistry())),
    createdAt: _now(),
    completedAt: null,
    error: null
  }

  vault.snapshots.push(snapshot)
  if (vault.snapshots.length > 100) {
    vault.snapshots.splice(0, vault.snapshots.length - 100)
  }

  const txn = {
    snapshotId: snapshot.id,
    draftId: snapshot.draftId,
    action,
    status: STATUS_PENDING,
    createdAt: snapshot.createdAt
  }
  vault.pendingTxns.push(txn)

  _saveVault(vault)

  _appendLog({
    action: 'create_snapshot',
    snapshotId: snapshot.id,
    draftId,
    draftAction: action,
    source,
    operator: snapshot.operator
  })

  return { success: true, snapshotId: snapshot.id, snapshot }
}

function commitSnapshot(snapshotId) {
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }
  if (snap.status !== STATUS_PENDING) {
    return { success: false, errors: [`快照状态不是 pending，当前: ${snap.status}`] }
  }

  snap.status = STATUS_COMMITTED
  snap.completedAt = _now()

  const txnIdx = vault.pendingTxns.findIndex(t => t.snapshotId === snapshotId)
  if (txnIdx >= 0) {
    vault.pendingTxns.splice(txnIdx, 1)
  }

  _saveVault(vault)

  _appendLog({
    action: 'commit_snapshot',
    snapshotId,
    draftId: snap.draftId,
    draftAction: snap.action
  })

  return { success: true }
}

function markSnapshotFailed(snapshotId, error) {
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }

  snap.status = STATUS_PENDING
  snap.error = error || 'unknown error'
  snap.completedAt = _now()

  const txnIdx = vault.pendingTxns.findIndex(t => t.snapshotId === snapshotId)
  if (txnIdx >= 0) {
    vault.pendingTxns[txnIdx].status = STATUS_PENDING
    vault.pendingTxns[txnIdx].error = error
  }

  _saveVault(vault)

  _appendLog({
    action: 'snapshot_failed',
    snapshotId,
    draftId: snap.draftId,
    error
  })

  return { success: true }
}

function listSnapshots(options) {
  options = options || {}
  const vault = _loadVault()
  let list = vault.snapshots.slice()

  if (options.draftId) {
    list = list.filter(s => s.draftId === options.draftId)
  }
  if (options.action) {
    list = list.filter(s => s.action === options.action)
  }
  if (options.status) {
    list = list.filter(s => s.status === options.status)
  }
  if (options.source) {
    list = list.filter(s => s.source === options.source)
  }
  if (options.operator) {
    list = list.filter(s => s.operator === options.operator)
  }

  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return list
}

function getSnapshot(snapshotId) {
  const vault = _loadVault()
  return vault.snapshots.find(s => s.id === snapshotId) || null
}

function findPendingTxns() {
  const vault = _loadVault()
  return vault.pendingTxns.slice()
}

function recoverFromSnapshot(snapshotId, options) {
  options = options || {}
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }

  if (snap.status === STATUS_COMMITTED || snap.status === STATUS_ARCHIVED) {
    return { success: false, errors: ['已提交或已归档的快照无需恢复'] }
  }

  const currentDrafts = store.loadDrafts()
  const currentDraft = snap.draftId ? currentDrafts.find(d => d.id === snap.draftId) : null

  const undoSnapshot = {
    action: 'recover',
    snapshotId,
    draftId: snap.draftId,
    timestamp: _now(),
    previousDrafts: JSON.parse(JSON.stringify(currentDrafts)),
    previousCommits: JSON.parse(JSON.stringify(store.loadCommits())),
    previousVersionRegistry: JSON.parse(JSON.stringify(store.loadVersionRegistry()))
  }

  const conflictResolution = options.conflictResolution || 'prefer_body'

  let conflict = null
  if (currentDraft && snap.draftSnapshot) {
    if (currentDraft.version && snap.version && currentDraft.version !== snap.version) {
      const versionRegistry = require('./versionRegistry')
      const vrCheck = versionRegistry.checkAvailability(snap.version, { excludeDraftId: snap.draftId })
      if (!vrCheck.available && !vrCheck.selfOccupied) {
        conflict = {
          type: 'version_conflict',
          currentVersion: currentDraft.version,
          snapshotVersion: snap.version,
          occupier: vrCheck.occupier,
          resolution: conflictResolution
        }
      }
    }

    if (currentDraft.name !== snap.name) {
      const nameCheck = currentDrafts.find(d => d.name === snap.name && d.id !== snap.draftId)
      if (nameCheck) {
        conflict = conflict || {}
        conflict.nameConflict = {
          type: 'name_conflict',
          currentName: currentDraft.name,
          snapshotName: snap.name,
          conflictingDraftId: nameCheck.id
        }
        conflict.resolution = conflictResolution
      }
    }
  }

  if (conflict && conflictResolution === 'abort') {
    return {
      success: false,
      errors: ['恢复中止：存在冲突'],
      conflict,
      snapshotId
    }
  }

  if (snap.draftSnapshot) {
    const restoredDraft = JSON.parse(JSON.stringify(snap.draftSnapshot))

    restoredDraft.commits = JSON.parse(JSON.stringify(snap.body))

    if (conflictResolution === 'prefer_body' || conflictResolution === 'rename_on_conflict') {
      if (conflict && conflict.nameConflict && conflictResolution === 'rename_on_conflict') {
        let suffix = 1
        let tryName = restoredDraft.name
        while (currentDrafts.find(d => d.name === tryName && d.id !== restoredDraft.id)) {
          suffix++
          tryName = `${restoredDraft.name} (恢复${suffix})`
        }
        restoredDraft.name = tryName
      }

      if (conflict && conflict.type === 'version_conflict' && conflictResolution === 'prefer_body') {
        const versionRegistry = require('./versionRegistry')
        if (snap.version) {
          try {
            versionRegistry.occupyVersion(snap.version, {
              draftId: restoredDraft.id,
              draftName: restoredDraft.name,
              sourceAction: versionRegistry.SOURCE_UPDATE,
              force: true,
              isAdmin: true,
              reason: '草稿恢复保险箱: 恢复快照时优先还原正文',
              userId: snap.operator,
              userName: snap.operatorName
            })
          } catch (e) {
            // version conflict not fatal for body restore
          }
        }
      }
    }

    const idx = currentDrafts.findIndex(d => d.id === restoredDraft.id)
    if (idx >= 0) {
      currentDrafts[idx] = restoredDraft
    } else {
      currentDrafts.push(restoredDraft)
    }

    store.saveDrafts(currentDrafts)
  }

  if (snap.commitsSnapshot) {
    store.saveCommits(JSON.parse(JSON.stringify(snap.commitsSnapshot)))
  }

  if (snap.versionRegistrySnapshot) {
    store.saveVersionRegistry(JSON.parse(JSON.stringify(snap.versionRegistrySnapshot)))
  }

  snap.status = STATUS_RECOVERED
  snap.completedAt = _now()

  const txnIdx = vault.pendingTxns.findIndex(t => t.snapshotId === snapshotId)
  if (txnIdx >= 0) {
    vault.pendingTxns.splice(txnIdx, 1)
  }

  _saveVault(vault)
  _saveRecoveryUndo(undoSnapshot)

  _appendLog({
    action: 'recover',
    snapshotId,
    draftId: snap.draftId,
    draftAction: snap.action,
    conflictResolution,
    hadConflict: !!conflict,
    operator: options.operator || snap.operator
  })

  return {
    success: true,
    recovered: true,
    snapshotId,
    draftId: snap.draftId,
    conflict: conflict || null
  }
}

function recoverPendingTxns() {
  const vault = _loadVault()
  const pending = vault.pendingTxns.slice()
  if (pending.length === 0) {
    return { success: true, recovered: 0, results: [] }
  }

  const results = []
  let recovered = 0

  pending.forEach(txn => {
    const snap = vault.snapshots.find(s => s.id === txn.snapshotId)
    if (!snap) {
      const txnIdx = vault.pendingTxns.findIndex(t => t.snapshotId === txn.snapshotId)
      if (txnIdx >= 0) vault.pendingTxns.splice(txnIdx, 1)
      results.push({ snapshotId: txn.snapshotId, success: false, reason: '快照已丢失' })
      return
    }

    if (snap.status === STATUS_PENDING) {
      const result = recoverFromSnapshot(txn.snapshotId, { conflictResolution: 'prefer_body' })
      results.push({ snapshotId: txn.snapshotId, ...result })
      if (result.success) recovered++
    }
  })

  _appendLog({
    action: 'auto_recover',
    pendingCount: pending.length,
    recoveredCount: recovered
  })

  return { success: true, recovered, total: pending.length, results }
}

function rollbackSnapshot(snapshotId, options) {
  options = options || {}
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }

  if (snap.status !== STATUS_COMMITTED && snap.status !== STATUS_RECOVERED) {
    return { success: false, errors: ['只能回滚已提交或已恢复的快照'] }
  }

  const currentDrafts = store.loadDrafts()

  const undoSnapshot = {
    action: 'rollback',
    snapshotId,
    draftId: snap.draftId,
    timestamp: _now(),
    previousDrafts: JSON.parse(JSON.stringify(currentDrafts)),
    previousCommits: JSON.parse(JSON.stringify(store.loadCommits())),
    previousVersionRegistry: JSON.parse(JSON.stringify(store.loadVersionRegistry()))
  }

  if (snap.draftsSnapshot) {
    store.saveDrafts(JSON.parse(JSON.stringify(snap.draftsSnapshot)))
  }
  if (snap.commitsSnapshot) {
    store.saveCommits(JSON.parse(JSON.stringify(snap.commitsSnapshot)))
  }
  if (snap.versionRegistrySnapshot) {
    store.saveVersionRegistry(JSON.parse(JSON.stringify(snap.versionRegistrySnapshot)))
  }

  snap.status = STATUS_ROLLED_BACK
  snap.completedAt = _now()

  _saveVault(vault)
  _saveRecoveryUndo(undoSnapshot)

  _appendLog({
    action: 'rollback',
    snapshotId,
    draftId: snap.draftId,
    draftAction: snap.action,
    operator: options.operator || snap.operator
  })

  return { success: true, snapshotId }
}

function undoLastRecovery() {
  const undoSnap = _loadRecoveryUndo()
  if (!undoSnap) {
    return { success: false, reason: '没有可撤销的恢复或回滚操作' }
  }

  store.saveDrafts(JSON.parse(JSON.stringify(undoSnap.previousDrafts)))
  store.saveCommits(JSON.parse(JSON.stringify(undoSnap.previousCommits)))
  store.saveVersionRegistry(JSON.parse(JSON.stringify(undoSnap.previousVersionRegistry)))

  _clearRecoveryUndo()

  _appendLog({
    action: 'undo_recovery',
    originalAction: undoSnap.action,
    snapshotId: undoSnap.snapshotId,
    draftId: undoSnap.draftId
  })

  return {
    success: true,
    action: undoSnap.action,
    snapshotId: undoSnap.snapshotId,
    timestamp: undoSnap.timestamp
  }
}

function peekRecoveryUndo() {
  return _loadRecoveryUndo()
}

function resolveConflict(snapshotId, resolution, options) {
  options = options || {}
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }

  const currentDrafts = store.loadDrafts()
  const currentDraft = snap.draftId ? currentDrafts.find(d => d.id === snap.draftId) : null

  const resolutionPlan = {
    snapshotId,
    draftId: snap.draftId,
    versionResolution: null,
    nameResolution: null,
    actions: []
  }

  if (snap.version) {
    const versionRegistry = require('./versionRegistry')
    const vrCheck = versionRegistry.checkAvailability(snap.version, { excludeDraftId: snap.draftId })
    if (!vrCheck.available && !vrCheck.selfOccupied) {
      if (resolution === 'takeover' && options.isAdmin) {
        resolutionPlan.versionResolution = 'takeover'
        resolutionPlan.actions.push({
          type: 'takeover_version',
          version: snap.version,
          reason: options.reason || '管理员接管冲突版本'
        })
      } else if (resolution === 'change_version' && options.newVersion) {
        resolutionPlan.versionResolution = 'change'
        resolutionPlan.actions.push({
          type: 'change_version',
          fromVersion: snap.version,
          toVersion: options.newVersion
        })
      } else if (resolution === 'clear_version') {
        resolutionPlan.versionResolution = 'clear'
        resolutionPlan.actions.push({
          type: 'clear_version',
          version: snap.version
        })
      } else {
        return {
          success: false,
          errors: ['版本冲突未解决'],
          availableResolutions: ['takeover', 'change_version', 'clear_version'],
          conflict: {
            type: 'version_conflict',
            occupier: vrCheck.occupier,
            version: snap.version
          }
        }
      }
    }
  }

  if (snap.name && currentDraft) {
    const nameCheck = currentDrafts.find(d => d.name === snap.name && d.id !== snap.draftId)
    if (nameCheck) {
      if (resolution === 'rename' && options.newName) {
        resolutionPlan.nameResolution = 'rename'
        resolutionPlan.actions.push({
          type: 'rename',
          fromName: snap.name,
          toName: options.newName
        })
      } else if (resolution === 'auto_rename') {
        let suffix = 1
        let tryName = snap.name
        while (currentDrafts.find(d => d.name === tryName && d.id !== snap.draftId)) {
          suffix++
          tryName = `${snap.name} (${suffix})`
        }
        resolutionPlan.nameResolution = 'auto_rename'
        resolutionPlan.actions.push({
          type: 'rename',
          fromName: snap.name,
          toName: tryName
        })
      } else if (resolution === 'overwrite' && options.isAdmin) {
        resolutionPlan.nameResolution = 'overwrite'
        resolutionPlan.actions.push({
          type: 'overwrite',
          name: snap.name,
          targetDraftId: nameCheck.id
        })
      } else {
        return {
          success: false,
          errors: ['名称冲突未解决'],
          availableResolutions: ['rename', 'auto_rename', 'overwrite'],
          conflict: {
            type: 'name_conflict',
            name: snap.name,
            conflictingDraftId: nameCheck.id
          }
        }
      }
    }
  }

  _appendLog({
    action: 'resolve_conflict',
    snapshotId,
    resolution,
    actions: resolutionPlan.actions
  })

  return { success: true, resolutionPlan }
}

function archiveSnapshot(snapshotId) {
  const vault = _loadVault()
  const snap = vault.snapshots.find(s => s.id === snapshotId)
  if (!snap) {
    return { success: false, errors: ['快照不存在'] }
  }

  if (snap.status === STATUS_PENDING) {
    return { success: false, errors: ['不能归档未完成的事务快照'] }
  }

  snap.status = STATUS_ARCHIVED
  snap.completedAt = snap.completedAt || _now()

  snap.draftsSnapshot = null
  snap.commitsSnapshot = null
  snap.versionRegistrySnapshot = null
  snap.draftSnapshot = null

  _saveVault(vault)

  _appendLog({
    action: 'archive_snapshot',
    snapshotId,
    draftId: snap.draftId
  })

  return { success: true }
}

function cleanArchivedSnapshots(maxAge) {
  const vault = _loadVault()
  const cutoff = maxAge ? new Date(Date.now() - maxAge).toISOString() : null
  const before = vault.snapshots.length

  vault.snapshots = vault.snapshots.filter(s => {
    if (s.status !== STATUS_ARCHIVED) return true
    if (cutoff && s.completedAt && s.completedAt < cutoff) return false
    if (!cutoff) return false
    return true
  })

  _saveVault(vault)

  const removed = before - vault.snapshots.length

  if (removed > 0) {
    _appendLog({
      action: 'clean_archived',
      removedCount: removed
    })
  }

  return { success: true, removed }
}

function exportVaultToJson(options) {
  options = options || {}
  const vault = _loadVault()
  const logs = store.loadDraftVaultLogs()

  let snapshots = vault.snapshots
  if (options.status) {
    snapshots = snapshots.filter(s => s.status === options.status)
  }

  return {
    schemaVersion: 1,
    type: 'draft-vault-export',
    exportedAt: _now(),
    snapshots: JSON.parse(JSON.stringify(snapshots)),
    pendingTxns: JSON.parse(JSON.stringify(vault.pendingTxns)),
    logs: logs.slice(-100)
  }
}

function exportVaultToFile(outputPath, options) {
  const fs = require('fs')
  const path = require('path')
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    return { success: false, errors: [`输出目录不存在: ${dir}`] }
  }
  try {
    const data = exportVaultToJson(options)
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
    return { success: true, path: outputPath }
  } catch (e) {
    return { success: false, errors: [`写入文件失败: ${e.message}`] }
  }
}

function importVaultFromJson(data, options) {
  options = options || {}
  if (!data || data.type !== 'draft-vault-export') {
    return { success: false, errors: ['保险箱导入格式不正确：缺少 type=draft-vault-export'] }
  }
  if (!Array.isArray(data.snapshots)) {
    return { success: false, errors: ['保险箱导入格式不正确：缺少 snapshots 数组'] }
  }

  const vault = _loadVault()
  const existingIds = new Set(vault.snapshots.map(s => s.id))
  let importedCount = 0
  let skipped = 0
  let conflicts = []

  data.snapshots.forEach(s => {
    if (!s || !s.id) {
      skipped++
      return
    }
    if (existingIds.has(s.id)) {
      if (options.force) {
        const idx = vault.snapshots.findIndex(es => es.id === s.id)
        if (idx >= 0) vault.snapshots[idx] = JSON.parse(JSON.stringify(s))
        importedCount++
      } else {
        conflicts.push(s.id)
        skipped++
      }
    } else {
      vault.snapshots.push(JSON.parse(JSON.stringify(s)))
      importedCount++
    }
  })

  if (Array.isArray(data.pendingTxns)) {
    data.pendingTxns.forEach(t => {
      if (!vault.pendingTxns.find(et => et.snapshotId === t.snapshotId)) {
        vault.pendingTxns.push(JSON.parse(JSON.stringify(t)))
      }
    })
  }

  _saveVault(vault)

  if (data.logs && Array.isArray(data.logs)) {
    const existingLogs = store.loadDraftVaultLogs()
    const merged = [...existingLogs]
    data.logs.forEach(l => {
      if (!merged.find(m => m.timestamp === l.timestamp && m.action === l.action && m.snapshotId === l.snapshotId)) {
        merged.push(l)
      }
    })
    merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    store.saveDraftVaultLogs(merged.slice(-200))
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

function importVaultFromFile(filePath, options) {
  const fs = require('fs')
  const path = require('path')
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(absPath)) {
    return { success: false, errors: [`文件不存在: ${absPath}`] }
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const data = JSON.parse(raw)
    return importVaultFromJson(data, options)
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { success: false, errors: [`JSON 解析失败: ${e.message}`] }
    }
    return { success: false, errors: [`读取文件失败: ${e.message}`] }
  }
}

function listLogs(limit) {
  const logs = store.loadDraftVaultLogs()
  const n = limit || 50
  return logs.slice(-n).reverse()
}

function getStatus() {
  const vault = _loadVault()
  const pending = vault.pendingTxns.length
  const total = vault.snapshots.length
  const byStatus = {}
  vault.snapshots.forEach(s => {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1
  })
  return {
    totalSnapshots: total,
    pendingTransactions: pending,
    byStatus,
    hasRecoveryUndo: !!_loadRecoveryUndo()
  }
}

function wrapOperation(draftId, action, source, operator, operationFn, options) {
  options = options || {}
  const snapResult = createSnapshot(draftId, action, source, {
    operator: operator || 'anonymous',
    operatorName: options.operatorName || operator || '匿名用户',
    userId: operator,
    userName: options.operatorName || operator,
    draftName: options.draftName
  })

  if (!snapResult.success) {
    return { success: false, errors: ['创建保险箱快照失败'], originalErrors: snapResult.errors }
  }

  const snapshotId = snapResult.snapshotId

  try {
    const result = operationFn()

    if (result && result.success === false) {
      markSnapshotFailed(snapshotId, (result.errors || ['operation failed']).join('; '))
      return result
    }

    commitSnapshot(snapshotId)
    return result
  } catch (e) {
    markSnapshotFailed(snapshotId, e.message)
    return { success: false, errors: [e.message] }
  }
}

module.exports = {
  STATUS_PENDING,
  STATUS_COMMITTED,
  STATUS_RECOVERED,
  STATUS_ROLLED_BACK,
  STATUS_ARCHIVED,
  SOURCE_WEB,
  SOURCE_CLI,
  ACTION_CREATE,
  ACTION_UPDATE,
  ACTION_DUPLICATE,
  ACTION_APPLY,
  ACTION_IMPORT,
  ACTION_ARCHIVE,
  ACTION_VERSION_CHANGE,
  createSnapshot,
  commitSnapshot,
  markSnapshotFailed,
  listSnapshots,
  getSnapshot,
  findPendingTxns,
  recoverFromSnapshot,
  recoverPendingTxns,
  rollbackSnapshot,
  undoLastRecovery,
  peekRecoveryUndo,
  resolveConflict,
  archiveSnapshot,
  cleanArchivedSnapshots,
  exportVaultToJson,
  exportVaultToFile,
  importVaultFromJson,
  importVaultFromFile,
  listLogs,
  getStatus,
  wrapOperation
}
