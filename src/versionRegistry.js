const store = require('./store')

const STATUS_OCCUPIED = 'occupied'
const STATUS_PREOCCUPIED = 'preoccupied'

const SOURCE_CREATE = 'create'
const SOURCE_DUPLICATE = 'duplicate'
const SOURCE_IMPORT = 'import'
const SOURCE_UPDATE = 'update'
const SOURCE_MANUAL = 'manual'

function _now() {
  return new Date().toISOString()
}

function _genRegId() {
  return 'vr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

function _loadRegistry() {
  const data = store.loadVersionRegistry()
  if (!data || !Array.isArray(data.entries)) {
    return { entries: [] }
  }
  return data
}

function _saveRegistry(data) {
  store.saveVersionRegistry(data)
}

function _appendLog(entry) {
  store.appendVersionRegistryLog({
    ...entry,
    timestamp: entry.timestamp || _now()
  })
}

function _saveUndoSnapshot(action, version, description, previousEntries, extra) {
  const snapshot = {
    action,
    version,
    description,
    timestamp: _now(),
    previousEntries: previousEntries ? JSON.parse(JSON.stringify(previousEntries)) : null,
    extra: extra ? JSON.parse(JSON.stringify(extra)) : null
  }
  store.saveVersionRegistryUndo(snapshot)
}

function listEntries(options) {
  options = options || {}
  const { entries } = _loadRegistry()
  let list = entries.slice()

  if (options.version) {
    list = list.filter(e => e.version === options.version)
  }
  if (options.status) {
    list = list.filter(e => e.status === options.status)
  }
  if (options.userId) {
    list = list.filter(e => e.userId === options.userId)
  }
  if (options.draftId) {
    list = list.filter(e => e.draftId === options.draftId)
  }

  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  return list
}

function getEntry(version) {
  if (!version) return null
  const { entries } = _loadRegistry()
  return entries.find(e => e.version === version) || null
}

function getEntryByDraftId(draftId) {
  if (!draftId) return null
  const { entries } = _loadRegistry()
  return entries.find(e => e.draftId === draftId) || null
}

function checkAvailability(version, options) {
  options = options || {}
  if (!version) {
    return { available: true, reason: 'no_version' }
  }

  const existing = getEntry(version)
  if (!existing) {
    return { available: true }
  }

  if (options.excludeDraftId && existing.draftId === options.excludeDraftId) {
    return { available: true }
  }

  if ((options.userId || 'anonymous') === existing.userId) {
    return { available: true, selfOccupied: true, existing }
  }

  return {
    available: false,
    existing,
    reason: 'version_occupied',
    occupier: existing.userName || existing.userId || '(未知)',
    sourceAction: existing.sourceAction,
    draftName: existing.draftName,
    updatedAt: existing.updatedAt
  }
}

function _upsertEntry(registry, entry) {
  const idx = registry.entries.findIndex(e => e.version === entry.version)
  if (idx >= 0) {
    registry.entries[idx] = entry
  } else {
    registry.entries.push(entry)
  }
}

function occupyVersion(version, options) {
  options = options || {}
  if (!version) {
    return { success: false, errors: ['版本号不能为空'], blocked: false }
  }

  const registry = _loadRegistry()
  const existing = registry.entries.find(e => e.version === version)

  const storeMod = require('./store')
  const allDrafts = storeMod.loadDrafts()
  const duplicateDraft = allDrafts.find(d => d.version === version && d.id !== options.draftId)
  
  if (duplicateDraft && !options.force) {
    if (!existing) {
      return {
        success: false,
        errors: [`版本号 ${version} 已被草稿占用但未在登记表中: ${duplicateDraft.name}`],
        blocked: true,
        reason: 'version_orphaned_draft',
        conflict: {
          version,
          occupier: '(未登记)',
          sourceAction: 'orphaned',
          draftName: duplicateDraft.name,
          draftId: duplicateDraft.id,
          updatedAt: duplicateDraft.updatedAt,
          needsReconcile: true
        }
      }
    } else if (options.draftId !== duplicateDraft.id) {
      return {
        success: false,
        errors: [`版本号 ${version} 已被草稿占用: ${duplicateDraft.name}`],
        blocked: true,
        reason: 'version_occupied',
        conflict: {
          version,
          occupier: existing.userName || existing.userId || '(未知)',
          sourceAction: existing.sourceAction,
          draftName: duplicateDraft.name,
          draftId: duplicateDraft.id,
          updatedAt: duplicateDraft.updatedAt
        }
      }
    }
  }

  if (existing) {
    if (options.excludeDraftId && existing.draftId === options.excludeDraftId) {
    } else if ((options.userId || 'anonymous') === existing.userId) {
    } else if (options.force && options.isAdmin) {
      if (!options.reason) {
        return { success: false, errors: ['管理员强制接管必须提供接管理由'], blocked: true, reason: 'no_takeover_reason' }
      }
      _saveUndoSnapshot('takeover', version,
        `管理员强制接管版本 ${version}，理由: ${options.reason}`,
        registry.entries, { previousEntry: existing })
      _appendLog({
        action: 'takeover',
        version,
        previousUserId: existing.userId,
        previousUserName: existing.userName,
        previousDraftId: existing.draftId,
        previousDraftName: existing.draftName,
        userId: options.userId,
        userName: options.userName,
        draftId: options.draftId,
        draftName: options.draftName,
        sourceAction: options.sourceAction || SOURCE_MANUAL,
        reason: options.reason || '',
        isAdmin: true
      })
    } else {
      return {
        success: false,
        errors: [`版本号 ${version} 已被占用`],
        blocked: true,
        reason: 'version_occupied',
        conflict: {
          version,
          occupier: existing.userName || existing.userId || '(未知)',
          sourceAction: existing.sourceAction,
          draftName: existing.draftName,
          draftId: existing.draftId,
          updatedAt: existing.updatedAt,
          status: existing.status,
          history: existing.history || []
        }
      }
    }
  } else {
    _saveUndoSnapshot('occupy', version, `占用版本 ${version}`, registry.entries, null)
  }

  const previousEntry = existing
  const now = _now()

  const historyRecord = {
    action: existing ? (options.force && options.isAdmin ? 'takeover' : 'update') : 'occupy',
    timestamp: now,
    userId: options.userId,
    userName: options.userName,
    reason: options.reason || ''
  }

  const entry = {
    id: existing ? existing.id : _genRegId(),
    version,
    status: options.preoccupy ? STATUS_PREOCCUPIED : STATUS_OCCUPIED,
    userId: options.userId || 'anonymous',
    userName: options.userName || '匿名用户',
    sourceAction: options.sourceAction || (previousEntry ? previousEntry.sourceAction : SOURCE_MANUAL),
    draftId: options.draftId || (previousEntry ? previousEntry.draftId : null),
    draftName: options.draftName || (previousEntry ? previousEntry.draftName : null),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    history: existing ? [...(existing.history || []), historyRecord].slice(-50) : [historyRecord]
  }

  _upsertEntry(registry, entry)
  _saveRegistry(registry)

  if (!existing) {
    _appendLog({
      action: options.preoccupy ? 'preoccupy' : 'occupy',
      version,
      userId: options.userId,
      userName: options.userName,
      draftId: options.draftId,
      draftName: options.draftName,
      sourceAction: entry.sourceAction
    })
  } else if (options.force && options.isAdmin) {
  }

  return { success: true, entry, isNew: !existing, tookOver: !!(existing && options.force && options.isAdmin) }
}

function preoccupyVersion(version, options) {
  return occupyVersion(version, { ...options, preoccupy: true })
}

function releaseVersion(version, options) {
  options = options || {}
  if (!version) {
    return { success: false, errors: ['版本号不能为空'] }
  }

  const registry = _loadRegistry()
  const idx = registry.entries.findIndex(e => e.version === version)
  if (idx < 0) {
    return { success: false, errors: [`版本 ${version} 未被占用`] }
  }

  const existing = registry.entries[idx]
  const effectiveUserId = options.userId || 'anonymous'
  if (existing.userId !== effectiveUserId && !options.isAdmin) {
    return {
      success: false,
      errors: ['无权释放他人占用的版本'],
      blocked: true,
      reason: 'not_owner'
    }
  }

  _saveUndoSnapshot('release', version, `释放版本 ${version}`, registry.entries, { releasedEntry: existing })

  registry.entries.splice(idx, 1)
  _saveRegistry(registry)

  _appendLog({
    action: 'release',
    version,
    userId: options.userId || existing.userId,
    userName: options.userName || existing.userName,
    draftId: existing.draftId,
    draftName: existing.draftName,
    previousSourceAction: existing.sourceAction,
    reason: options.reason || ''
  })

  return { success: true, released: existing }
}

function releaseByDraftId(draftId, options) {
  options = options || {}
  if (!draftId) return { success: false, errors: ['草稿ID不能为空'] }
  const entry = getEntryByDraftId(draftId)
  if (!entry) return { success: true, released: null }
  const effectiveOptions = {
    ...options,
    userId: options.userId || entry.userId,
    userName: options.userName || entry.userName
  }
  return releaseVersion(entry.version, effectiveOptions)
}

function updateEntryForDraft(draftId, draftName, version, options) {
  options = options || {}
  if (!draftId) return { success: false, errors: ['草稿ID不能为空'] }

  const registry = _loadRegistry()
  const existingByIdx = registry.entries.findIndex(e => e.draftId === draftId)
  const now = _now()

  if (!version) {
    if (existingByIdx >= 0) {
      const existing = registry.entries[existingByIdx]
      _saveUndoSnapshot('release', existing.version,
        `草稿 ${draftName || draftId} 清除版本，释放 ${existing.version}`,
        registry.entries, { releasedEntry: existing })
      registry.entries.splice(existingByIdx, 1)
      _saveRegistry(registry)
      _appendLog({
        action: 'release',
        version: existing.version,
        userId: options.userId,
        userName: options.userName,
        draftId,
        draftName,
        previousSourceAction: existing.sourceAction,
        reason: 'draft_cleared_version'
      })
      return { success: true, released: existing }
    }
    return { success: true }
  }

  const existingByVersion = registry.entries.findIndex(e => e.version === version)

  if (existingByIdx >= 0) {
    const existing = registry.entries[existingByIdx]
    if (existing.version === version) {
      if (existing.draftName !== draftName) {
        existing.draftName = draftName
        existing.updatedAt = now
        _upsertEntry(registry, existing)
        _saveRegistry(registry)
      }
      return { success: true, entry: existing }
    }

    if (existingByVersion >= 0 && existingByVersion !== existingByIdx) {
      const other = registry.entries[existingByVersion]
      if (!options.force || !options.isAdmin) {
        return {
          success: false,
          errors: [`版本号 ${version} 已被其他草稿占用: ${other.draftName}`],
          blocked: true,
          reason: 'version_occupied',
          conflict: {
            version,
            occupier: other.userName || other.userId || '(未知)',
            sourceAction: other.sourceAction,
            draftName: other.draftName,
            draftId: other.draftId,
            updatedAt: other.updatedAt
          }
        }
      }
      _saveUndoSnapshot('takeover', version,
        `管理员接管版本 ${version}（草稿更新），理由: ${options.reason || '(未说明)'}`,
        registry.entries, { previousEntries: [existing, other] })

      _appendLog({
        action: 'takeover',
        version,
        previousUserId: other.userId,
        previousUserName: other.userName,
        previousDraftId: other.draftId,
        previousDraftName: other.draftName,
        userId: options.userId,
        userName: options.userName,
        draftId,
        draftName,
        sourceAction: SOURCE_UPDATE,
        reason: options.reason || '',
        isAdmin: true
      })
      registry.entries.splice(existingByVersion, 1)
    }

    _saveUndoSnapshot('update', existing.version,
      `草稿变更版本: ${existing.version} → ${version}`,
      registry.entries, { previousVersion: existing.version })

    const historyRecord = {
      action: 'update_version',
      timestamp: now,
      userId: options.userId,
      userName: options.userName,
      previousVersion: existing.version,
      newVersion: version,
      reason: options.reason || ''
    }

    existing.version = version
    existing.draftName = draftName
    existing.updatedAt = now
    existing.history = [...(existing.history || []), historyRecord].slice(-50)
    _upsertEntry(registry, existing)
    _saveRegistry(registry)

    _appendLog({
      action: 'update',
      version,
      previousVersion: existing.history[existing.history.length - 1] ? existing.history[existing.history.length - 1].previousVersion : null,
      userId: options.userId,
      userName: options.userName,
      draftId,
      draftName,
      sourceAction: SOURCE_UPDATE
    })

    return { success: true, entry: existing }
  }

  if (existingByVersion >= 0) {
    const other = registry.entries[existingByVersion]
    if (!options.force || !options.isAdmin) {
      return {
        success: false,
        errors: [`版本号 ${version} 已被其他草稿占用: ${other.draftName}`],
        blocked: true,
        reason: 'version_occupied',
        conflict: {
          version,
          occupier: other.userName || other.userId || '(未知)',
          sourceAction: other.sourceAction,
          draftName: other.draftName,
          draftId: other.draftId,
          updatedAt: other.updatedAt
        }
      }
    }
  }

  return occupyVersion(version, {
    ...options,
    draftId,
    draftName,
    sourceAction: SOURCE_UPDATE
  })
}

function takeoverVersion(version, options) {
  options = options || {}
  if (!options.reason) {
    return { success: false, errors: ['接管必须提供理由'], blocked: true, reason: 'no_reason' }
  }
  return occupyVersion(version, { ...options, force: true, isAdmin: true })
}

function listLogs(limit) {
  const logs = store.loadVersionRegistryLogs()
  const n = limit || 50
  return logs.slice(-n).reverse()
}

function peekUndo() {
  return store.loadVersionRegistryUndo()
}

function undoLastChange(options) {
  options = options || {}
  const snap = store.loadVersionRegistryUndo()
  if (!snap) {
    return { success: false, reason: '没有可撤销的版本登记操作' }
  }

  const currentRegistry = _loadRegistry()
  const previousEntries = snap.previousEntries ? JSON.parse(JSON.stringify(snap.previousEntries)) : []

  const newRegistry = { entries: previousEntries }
  _saveRegistry(newRegistry)
  store.clearVersionRegistryUndo()

  _appendLog({
    action: 'undo',
    version: snap.version,
    undoAction: snap.action,
    description: snap.description,
    userId: options.userId,
    userName: options.userName,
    timestamp: _now()
  })

  return {
    success: true,
    action: snap.action,
    description: snap.description,
    version: snap.version,
    timestamp: snap.timestamp
  }
}

function exportRegistryToJson() {
  const registry = _loadRegistry()
  const logs = store.loadVersionRegistryLogs()
  return {
    schemaVersion: 1,
    type: 'version-registry-export',
    exportedAt: _now(),
    entries: registry.entries || [],
    logs: logs.slice(-100)
  }
}

function exportRegistryToFile(outputPath) {
  const fs = require('fs')
  const path = require('path')
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    return { success: false, errors: [`输出目录不存在: ${dir}`] }
  }
  try {
    const data = exportRegistryToJson()
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
    return { success: true, path: outputPath, data }
  } catch (e) {
    return { success: false, errors: [`写入文件失败: ${e.message}`] }
  }
}

function importRegistryFromJson(data, options) {
  options = options || {}
  if (!data) {
    return { success: false, errors: ['导入数据不能为空'] }
  }
  const entries = data.entries || (data.registry && data.registry.entries)
  if (!Array.isArray(entries)) {
    return { success: false, errors: ['版本登记导入格式不正确：缺少 entries 数组'] }
  }

  const registry = _loadRegistry()
  const currentMap = new Map(registry.entries.map(e => [e.version, e]))
  let importedCount = 0
  let skipped = 0
  let conflicts = []

  entries.forEach(e => {
    if (!e || !e.version) {
      skipped++
      return
    }
    if (currentMap.has(e.version)) {
      if (options.force) {
        currentMap.set(e.version, JSON.parse(JSON.stringify(e)))
        importedCount++
      } else {
        conflicts.push(e.version)
        skipped++
      }
    } else {
      currentMap.set(e.version, JSON.parse(JSON.stringify(e)))
      importedCount++
    }
  })

  registry.entries = Array.from(currentMap.values())
  _saveRegistry(registry)

  if (data.logs && Array.isArray(data.logs)) {
    const existingLogs = store.loadVersionRegistryLogs()
    const merged = [...existingLogs]
    data.logs.forEach(l => {
      if (!merged.find(m => m.timestamp === l.timestamp && m.action === l.action && m.version === l.version)) {
        merged.push(l)
      }
    })
    merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    store.saveVersionRegistryLogs(merged.slice(-200))
  }

  _appendLog({
    action: 'import',
    userId: options.userId,
    userName: options.userName,
    importedCount,
    skipped,
    conflictCount: conflicts.length,
    timestamp: _now()
  })

  return {
    success: true,
    importedCount,
    skipped,
    conflictCount: conflicts.length,
    conflicts
  }
}

function importRegistryFromFile(filePath, options) {
  const fs = require('fs')
  const path = require('path')
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(absPath)) {
    return { success: false, errors: [`文件不存在: ${absPath}`] }
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const data = JSON.parse(raw)
    return importRegistryFromJson(data, options)
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { success: false, errors: [`JSON 解析失败: ${e.message}`] }
    }
    return { success: false, errors: [`读取文件失败: ${e.message}`] }
  }
}

function reconcileWithDrafts(drafts) {
  const registry = _loadRegistry()
  const store = require('./store')
  const actualDrafts = drafts || store.loadDrafts()
  const draftVersionMap = new Map()
  const duplicateVersions = []
  
  actualDrafts.forEach(d => {
    if (d.version) {
      if (draftVersionMap.has(d.version)) {
        duplicateVersions.push({
          version: d.version,
          draft1: draftVersionMap.get(d.version),
          draft2: d
        })
      } else {
        draftVersionMap.set(d.version, d)
      }
    }
  })

  const staleEntries = []
  const missingEntries = []
  const duplicateFixes = []

  duplicateVersions.forEach(dv => {
    const newer = dv.draft1.updatedAt > dv.draft2.updatedAt ? dv.draft1 : dv.draft2
    const older = dv.draft1.updatedAt > dv.draft2.updatedAt ? dv.draft2 : dv.draft1
    const existingEntry = registry.entries.find(e => e.version === dv.version)
    
    if (existingEntry) {
      if (existingEntry.draftId === older.id) {
        existingEntry.draftId = newer.id
        existingEntry.draftName = newer.name
        existingEntry.updatedAt = _now()
        existingEntry.history.push({
          action: 'reconcile_duplicate',
          timestamp: _now(),
          userId: 'system',
          userName: '系统恢复',
          reason: `重复版本检测，保留较新的草稿 ${newer.name}，旧草稿 ${older.name} 已被清除版本标记`
        })
        older.version = ''
        store.saveDrafts(actualDrafts)
        duplicateFixes.push({
          type: 'duplicate_version',
          version: dv.version,
          description: `检测到重复版本草稿，保留 ${newer.name}，已清除 ${older.name} 的版本标记`
        })
      } else {
        older.version = ''
        store.saveDrafts(actualDrafts)
        duplicateFixes.push({
          type: 'duplicate_version',
          version: dv.version,
          description: `检测到重复版本草稿，保留 ${newer.name}，已清除 ${older.name} 的版本标记`
        })
      }
    } else {
      older.version = ''
      store.saveDrafts(actualDrafts)
      draftVersionMap.set(dv.version, newer)
      duplicateFixes.push({
        type: 'duplicate_version',
        version: dv.version,
        description: `检测到重复版本草稿，保留 ${newer.name}，已清除 ${older.name} 的版本标记`
      })
    }
  })

  registry.entries.forEach(e => {
    if (!draftVersionMap.has(e.version)) {
      staleEntries.push(e)
    } else {
      const d = draftVersionMap.get(e.version)
      if (e.draftId !== d.id) {
        e.draftId = d.id
        e.draftName = d.name
        e.updatedAt = _now()
      }
    }
  })

  staleEntries.forEach(e => {
    const idx = registry.entries.findIndex(r => r.version === e.version)
    if (idx >= 0) registry.entries.splice(idx, 1)
  })

  draftVersionMap.forEach((d, version) => {
    const found = registry.entries.find(e => e.version === version)
    if (!found) {
      missingEntries.push({ version, draft: d })
      registry.entries.push({
        id: _genRegId(),
        version,
        status: STATUS_OCCUPIED,
        userId: 'system',
        userName: '系统恢复',
        sourceAction: SOURCE_MANUAL,
        draftId: d.id,
        draftName: d.name,
        createdAt: _now(),
        updatedAt: _now(),
        history: [{
          action: 'reconcile',
          timestamp: _now(),
          userId: 'system',
          userName: '系统恢复',
          reason: '跨重启数据一致性恢复'
        }]
      })
    }
  })

  _saveRegistry(registry)

  const fixes = [...duplicateFixes]
  staleEntries.forEach(e => {
    fixes.push({
      type: 'remove_stale',
      version: e.version,
      description: `删除孤立的版本占用记录（草稿已不存在）`
    })
  })
  missingEntries.forEach(m => {
    fixes.push({
      type: 'restore_missing',
      version: m.version,
      description: `恢复缺失的版本占用记录（草稿 ${m.draft.name}）`
    })
  })

  if (fixes.length > 0) {
    _appendLog({
      action: 'reconcile',
      staleRemoved: staleEntries.length,
      missingRestored: missingEntries.length,
      timestamp: _now(),
      fixes
    })
  }

  return {
    ok: fixes.length === 0,
    fixes,
    staleRemoved: staleEntries.length,
    missingRestored: missingEntries.length,
    staleVersions: staleEntries.map(e => e.version),
    restored: missingEntries.map(m => ({ version: m.version, draftId: m.draft.id, draftName: m.draft.name }))
  }
}

module.exports = {
  STATUS_OCCUPIED,
  STATUS_PREOCCUPIED,
  SOURCE_CREATE,
  SOURCE_DUPLICATE,
  SOURCE_IMPORT,
  SOURCE_UPDATE,
  SOURCE_MANUAL,
  listEntries,
  getEntry,
  getEntryByDraftId,
  checkAvailability,
  occupyVersion,
  preoccupyVersion,
  releaseVersion,
  releaseByDraftId,
  updateEntryForDraft,
  takeoverVersion,
  listLogs,
  peekUndo,
  undoLastChange,
  exportRegistryToJson,
  exportRegistryToFile,
  importRegistryFromJson,
  importRegistryFromFile,
  reconcileWithDrafts
}
