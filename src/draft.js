const store = require('./store')
const config = require('./config')
const validator = require('./validator')
const archiver = require('./archiver')
const crypto = require('crypto')

function genId() {
  return 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
}

function listDrafts() {
  const drafts = store.loadDrafts()
  return drafts.map(d => ({
    id: d.id,
    name: d.name,
    version: d.version,
    description: d.description,
    commitCount: d.commits ? d.commits.length : 0,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    profileName: d.exportOptions ? d.exportOptions.profileName : null
  })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

function getDraft(id) {
  const drafts = store.loadDrafts()
  return drafts.find(d => d.id === id) || null
}

function getDraftByName(name) {
  const drafts = store.loadDrafts()
  return drafts.find(d => d.name === name) || null
}

function findDuplicateName(name, excludeId) {
  const drafts = store.loadDrafts()
  return drafts.find(d => d.name === name && d.id !== excludeId) || null
}

function findDuplicateVersion(version, excludeId) {
  const drafts = store.loadDrafts()
  return drafts.find(d => d.version === version && d.id !== excludeId) || null
}

function createDraft(options) {
  options = options || {}
  const name = options.name
  const version = options.version || ''
  const description = options.description || ''
  const force = options.force || false

  if (!name) {
    return { success: false, errors: ['草稿名称不能为空'], blocked: false }
  }

  const byName = findDuplicateName(name)
  if (byName && !force) {
    return {
      success: false,
      errors: [`同名草稿已存在: ${name}`],
      blocked: true,
      reason: 'duplicate_name',
      existingId: byName.id
    }
  }

  if (version) {
    const byVersion = findDuplicateVersion(version)
    if (byVersion && !force) {
      return {
        success: false,
        errors: [`同版本号草稿已存在: ${version} (${byVersion.name})`],
        blocked: true,
        reason: 'duplicate_version',
        existingId: byVersion.id
      }
    }
  }

  const commits = store.loadCommits()
  const filteredCommits = options.commits
    ? options.commits
    : commits.filter(c => c.category !== 'ignored')

  const cfg = config.get()
  const now = new Date().toISOString()

  const draft = {
    id: genId(),
    name,
    version,
    description,
    commits: JSON.parse(JSON.stringify(filteredCommits)),
    rules: JSON.parse(JSON.stringify(cfg)),
    exportOptions: options.exportOptions || {
      profileId: null,
      profileName: null,
      outputDir: null
    },
    createdAt: now,
    updatedAt: now
  }

  const drafts = store.loadDrafts()
  const draftsBefore = JSON.parse(JSON.stringify(drafts))

  if (byName && force) {
    const idx = drafts.findIndex(d => d.id === byName.id)
    if (idx >= 0) {
      draft.id = byName.id
      draft.createdAt = byName.createdAt
      drafts[idx] = draft
    } else {
      drafts.push(draft)
    }
  } else {
    drafts.push(draft)
  }

  store.saveDrafts(drafts)

  store.appendDraftLog({
    action: 'create',
    draftId: draft.id,
    draftName: name,
    timestamp: now,
    description: `创建草稿: ${name}`
  })

  _saveUndoSnapshot('create', draft.id, `创建草稿: ${name}`, null, draftsBefore)

  return {
    success: true,
    draft,
    overwritten: !!(byName && force)
  }
}

function updateDraft(id, updates, options) {
  options = options || {}
  const force = options.force || false

  const drafts = store.loadDrafts()
  const idx = drafts.findIndex(d => d.id === id)
  if (idx < 0) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const oldDraft = drafts[idx]
  const newName = updates.name !== undefined ? updates.name : oldDraft.name
  const newVersion = updates.version !== undefined ? updates.version : oldDraft.version

  if (newName !== oldDraft.name) {
    const byName = findDuplicateName(newName, id)
    if (byName && !force) {
      return {
        success: false,
        errors: [`同名草稿已存在: ${newName}`],
        blocked: true,
        reason: 'duplicate_name',
        existingId: byName.id
      }
    }
  }

  if (newVersion && newVersion !== oldDraft.version) {
    const byVersion = findDuplicateVersion(newVersion, id)
    if (byVersion && !force) {
      return {
        success: false,
        errors: [`同版本号草稿已存在: ${newVersion} (${byVersion.name})`],
        blocked: true,
        reason: 'duplicate_version',
        existingId: byVersion.id
      }
    }
  }

  const updated = { ...oldDraft }

  if (updates.name !== undefined) updated.name = updates.name
  if (updates.version !== undefined) updated.version = updates.version
  if (updates.description !== undefined) updated.description = updates.description
  if (updates.commits !== undefined) updated.commits = JSON.parse(JSON.stringify(updates.commits))
  if (updates.exportOptions !== undefined) {
    updated.exportOptions = { ...updated.exportOptions, ...updates.exportOptions }
  }

  updated.updatedAt = new Date().toISOString()

  const draftsBefore = JSON.parse(JSON.stringify(drafts))
  drafts[idx] = updated
  store.saveDrafts(drafts)

  store.appendDraftLog({
    action: 'update',
    draftId: id,
    draftName: updated.name,
    timestamp: updated.updatedAt,
    description: `更新草稿: ${updated.name}`
  })

  _saveUndoSnapshot('update', id, `更新草稿: ${updated.name}`, oldDraft, draftsBefore)

  return { success: true, draft: updated }
}

function deleteDraft(id) {
  const drafts = store.loadDrafts()
  const idx = drafts.findIndex(d => d.id === id)
  if (idx < 0) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const draftsBefore = JSON.parse(JSON.stringify(drafts))
  const deleted = drafts[idx]
  drafts.splice(idx, 1)
  store.saveDrafts(drafts)

  const now = new Date().toISOString()
  store.appendDraftLog({
    action: 'delete',
    draftId: id,
    draftName: deleted.name,
    timestamp: now,
    description: `删除草稿: ${deleted.name}`
  })

  _saveUndoSnapshot('delete', id, `删除草稿: ${deleted.name}`, deleted, draftsBefore)

  return { success: true, deleted }
}

function duplicateDraft(id, newName, options) {
  options = options || {}
  const resolve = options.resolve || 'cancel'

  const draftObj = getDraft(id)
  if (!draftObj) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const name = newName || `${draftObj.name} (副本)`

  const byName = findDuplicateName(name)
  const byVersion = draftObj.version ? findDuplicateVersion(draftObj.version, draftObj.id) : null

  if (byName || byVersion) {
    if (resolve === 'cancel') {
      const errors = []
      let reason = ''
      let existingId = null
      if (byName) {
        errors.push(`同名草稿已存在: ${name}`)
        reason = 'duplicate_name'
        existingId = byName.id
      }
      if (byVersion && byVersion.id !== (byName ? byName.id : null)) {
        errors.push(`同版本号草稿已存在: ${draftObj.version} (${byVersion.name})`)
        reason = 'duplicate_version'
        existingId = byVersion.id
      } else if (byVersion && !byName) {
        errors.push(`同版本号草稿已存在: ${draftObj.version} (${byVersion.name})`)
        reason = 'duplicate_version'
        existingId = byVersion.id
      }
      return {
        success: false,
        errors,
        blocked: true,
        reason,
        existingId,
        conflictDetails: {
          nameConflict: byName ? { existingId: byName.id, existingName: byName.name } : null,
          versionConflict: byVersion ? { existingId: byVersion.id, existingVersion: draftObj.version, existingName: byVersion.name } : null
        }
      }
    }

    if (resolve === 'rename') {
      let finalName = name
      let suffix = 1
      while (findDuplicateName(finalName)) {
        suffix++
        finalName = `${name} (${suffix})`
      }
      return _doDuplicateDraft(draftObj, finalName)
    }

    if (resolve === 'overwrite') {
      if (!byName) {
        return {
          success: false,
          errors: ['覆盖模式需要指定已存在的同名草稿'],
          blocked: true,
          reason: 'no_name_match'
        }
      }
      return _doOverwriteDraft(draftObj, name, byName)
    }
  }

  return _doDuplicateDraft(draftObj, name)
}

function _doDuplicateDraft(sourceDraft, newName) {
  const draftsBefore = store.loadDrafts()
  const now = new Date().toISOString()
  const newDraft = {
    ...JSON.parse(JSON.stringify(sourceDraft)),
    id: genId(),
    name: newName,
    createdAt: now,
    updatedAt: now
  }

  const drafts = store.loadDrafts()
  drafts.push(newDraft)
  store.saveDrafts(drafts)

  store.appendDraftLog({
    action: 'duplicate',
    draftId: newDraft.id,
    draftName: newName,
    sourceDraftId: sourceDraft.id,
    sourceDraftName: sourceDraft.name,
    timestamp: now,
    description: `复制草稿: ${sourceDraft.name} → ${newName}`
  })

  _pushUndoSnapshot('duplicate', newDraft.id, `复制草稿: ${sourceDraft.name} → ${newName}`, null, draftsBefore)

  return { success: true, draft: newDraft }
}

function _doOverwriteDraft(sourceDraft, targetName, existingDraft) {
  const draftsBefore = JSON.parse(JSON.stringify(store.loadDrafts()))
  const now = new Date().toISOString()
  const overwrittenDraft = {
    ...JSON.parse(JSON.stringify(sourceDraft)),
    id: existingDraft.id,
    name: targetName,
    createdAt: existingDraft.createdAt,
    updatedAt: now
  }

  const drafts = store.loadDrafts()
  const idx = drafts.findIndex(d => d.id === existingDraft.id)
  if (idx < 0) {
    return { success: false, errors: [`目标草稿不存在: ${existingDraft.id}`], blocked: false }
  }
  drafts[idx] = overwrittenDraft
  store.saveDrafts(drafts)

  store.appendDraftLog({
    action: 'duplicate_overwrite',
    draftId: overwrittenDraft.id,
    draftName: targetName,
    sourceDraftId: sourceDraft.id,
    sourceDraftName: sourceDraft.name,
    overwrittenDraftId: existingDraft.id,
    overwrittenDraftName: existingDraft.name,
    timestamp: now,
    description: `覆盖复制草稿: ${sourceDraft.name} → ${targetName} (覆盖 ${existingDraft.name})`
  })

  _pushUndoSnapshot('duplicate_overwrite', overwrittenDraft.id, `覆盖复制草稿: ${sourceDraft.name} → ${targetName}`, existingDraft, draftsBefore)

  return { success: true, draft: overwrittenDraft, overwritten: true }
}

function applyDraft(id) {
  const draft = getDraft(id)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const currentCommits = store.loadCommits()
  store.saveCommits(JSON.parse(JSON.stringify(draft.commits)))

  const now = new Date().toISOString()
  store.appendDraftLog({
    action: 'apply',
    draftId: id,
    draftName: draft.name,
    timestamp: now,
    description: `应用草稿: ${draft.name}`
  })

  return {
    success: true,
    draft,
    previousCommitCount: currentCommits.length,
    appliedCommitCount: draft.commits.length
  }
}

function archiveDraft(id) {
  const draft = getDraft(id)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  if (!draft.version) {
    return { success: false, errors: ['草稿未设置版本号，无法归档'], blocked: false }
  }

  const currentCommits = store.loadCommits()

  try {
    store.saveCommits(JSON.parse(JSON.stringify(draft.commits)))

    const check = validator.checkArchiveReadiness(draft.version)
    if (!check.ready) {
      store.saveCommits(currentCommits)
      return { success: false, errors: [check.reason], blocked: false }
    }

    const snapshot = archiver.archive(draft.version)

    const drafts = store.loadDrafts()
    const idx = drafts.findIndex(d => d.id === id)
    if (idx >= 0) {
      drafts.splice(idx, 1)
      store.saveDrafts(drafts)
    }

    store.saveCommits(currentCommits)

    const now = new Date().toISOString()
    store.appendDraftLog({
      action: 'archive',
      draftId: id,
      draftName: draft.name,
      version: draft.version,
      timestamp: now,
      description: `归档草稿: ${draft.name} → ${draft.version}`
    })

    return { success: true, snapshot, draft }
  } catch (e) {
    store.saveCommits(currentCommits)
    return { success: false, errors: [e.message], blocked: false }
  }
}

function compareDrafts(id1, id2) {
  const d1 = getDraft(id1)
  const d2 = getDraft(id2)

  if (!d1) return { success: false, errors: [`草稿不存在: ${id1}`] }
  if (!d2) return { success: false, errors: [`草稿不存在: ${id2}`] }

  const eo1 = d1.exportOptions || {}
  const eo2 = d2.exportOptions || {}

  const diff = {
    name: { same: d1.name === d2.name, value1: d1.name, value2: d2.name },
    version: { same: d1.version === d2.version, value1: d1.version, value2: d2.version },
    description: { same: d1.description === d2.description, value1: d1.description, value2: d2.description },
    commitCount: { same: d1.commits.length === d2.commits.length, value1: d1.commits.length, value2: d2.commits.length },
    commits: _diffCommits(d1.commits, d2.commits),
    exportOptions: {
      profileId: {
        same: (eo1.profileId || null) === (eo2.profileId || null),
        value1: eo1.profileId || null,
        value2: eo2.profileId || null
      },
      profileName: {
        same: (eo1.profileName || null) === (eo2.profileName || null),
        value1: eo1.profileName || null,
        value2: eo2.profileName || null
      },
      outputDir: {
        same: (eo1.outputDir || null) === (eo2.outputDir || null),
        value1: eo1.outputDir || null,
        value2: eo2.outputDir || null
      }
    },
    rules: _diffRules(d1.rules, d2.rules),
    createdAt: { same: d1.createdAt === d2.createdAt, value1: d1.createdAt, value2: d2.createdAt },
    updatedAt: { same: d1.updatedAt === d2.updatedAt, value1: d1.updatedAt, value2: d2.updatedAt }
  }

  return { success: true, diff, draft1: d1, draft2: d2 }
}

function _diffCommits(c1, c2) {
  const map1 = new Map(c1.map(c => [c.id, c]))
  const map2 = new Map(c2.map(c => [c.id, c]))

  const added = []
  const removed = []
  const modified = []
  const unchanged = []

  map1.forEach((c, id) => {
    if (!map2.has(id)) {
      removed.push({ id: c.id, message: c.message })
    } else {
      const other = map2.get(id)
      const changes = _diffCommitFields(c, other)
      if (changes.length > 0) {
        modified.push({ id, changes })
      } else {
        unchanged.push(id)
      }
    }
  })

  map2.forEach((c, id) => {
    if (!map1.has(id)) {
      added.push({ id: c.id, message: c.message })
    }
  })

  return { added, removed, modified, unchanged: unchanged.length }
}

function _diffCommitFields(c1, c2) {
  const changes = []
  const fields = ['message', 'category', 'version', 'ticket', 'note', 'author', 'date', 'reviewed']
  fields.forEach(f => {
    const v1 = c1[f]
    const v2 = c2[f]
    if (JSON.stringify(v1) !== JSON.stringify(v2)) {
      changes.push({ field: f, value1: v1, value2: v2 })
    }
  })
  return changes
}

function _diffRules(r1, r2) {
  if (!r1 && !r2) return { same: true, changes: [] }
  if (!r1 || !r2) return { same: false, changes: [{ field: 'rules', value1: r1, value2: r2 }] }
  const changes = []
  const allKeys = new Set([...Object.keys(r1), ...Object.keys(r2)])
  allKeys.forEach(k => {
    if (JSON.stringify(r1[k]) !== JSON.stringify(r2[k])) {
      changes.push({ field: k, value1: r1[k], value2: r2[k] })
    }
  })
  return { same: changes.length === 0, changes }
}

function exportDraftToJson(id) {
  const draft = getDraft(id)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${id}`] }
  }

  const data = {
    schemaVersion: 1,
    type: 'release-notes-draft',
    exportedAt: new Date().toISOString(),
    draft: {
      name: draft.name,
      version: draft.version,
      description: draft.description,
      commits: draft.commits,
      rules: draft.rules,
      exportOptions: draft.exportOptions
    }
  }

  return { success: true, data }
}

function exportDraftToFile(id, outputPath) {
  const result = exportDraftToJson(id)
  if (!result.success) return result

  const fs = require('fs')
  const path = require('path')

  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    return { success: false, errors: [`输出目录不存在: ${dir}`] }
  }

  try {
    fs.writeFileSync(outputPath, JSON.stringify(result.data, null, 2), 'utf-8')
    return { success: true, path: outputPath, data: result.data }
  } catch (e) {
    return { success: false, errors: [`写入文件失败: ${e.message}`] }
  }
}

function importDraftFromJson(data, options) {
  options = options || {}
  const asName = options.asName || null
  const force = options.force || false

  if (!data || !data.draft || data.type !== 'release-notes-draft') {
    return { success: false, errors: ['草稿文件格式不正确'], blocked: false }
  }

  const draftData = data.draft
  const name = asName || draftData.name

  if (!name) {
    return { success: false, errors: ['草稿名称不能为空'], blocked: false }
  }

  const byName = findDuplicateName(name)
  if (byName && !force) {
    return {
      success: false,
      errors: [`同名草稿已存在: ${name}`],
      blocked: true,
      reason: 'duplicate_name',
      existingId: byName.id
    }
  }

  if (draftData.version) {
    const byVersion = findDuplicateVersion(draftData.version)
    if (byVersion && !force) {
      return {
        success: false,
        errors: [`同版本号草稿已存在: ${draftData.version} (${byVersion.name})`],
        blocked: true,
        reason: 'duplicate_version',
        existingId: byVersion.id
      }
    }
  }

  const now = new Date().toISOString()
  const newDraft = {
    id: genId(),
    name,
    version: draftData.version || '',
    description: draftData.description || '',
    commits: JSON.parse(JSON.stringify(draftData.commits || [])),
    rules: draftData.rules || config.get(),
    exportOptions: draftData.exportOptions || { profileId: null, profileName: null, outputDir: null },
    createdAt: now,
    updatedAt: now
  }

  const drafts = store.loadDrafts()
  const draftsBefore = JSON.parse(JSON.stringify(drafts))

  if (byName && force) {
    const idx = drafts.findIndex(d => d.id === byName.id)
    if (idx >= 0) {
      newDraft.id = byName.id
      newDraft.createdAt = byName.createdAt
      drafts[idx] = newDraft
    } else {
      drafts.push(newDraft)
    }
  } else {
    drafts.push(newDraft)
  }

  store.saveDrafts(drafts)

  store.appendDraftLog({
    action: 'import',
    draftId: newDraft.id,
    draftName: name,
    timestamp: now,
    description: `导入草稿: ${name}`
  })

  _saveUndoSnapshot('import', newDraft.id, `导入草稿: ${name}`, null, draftsBefore)

  return {
    success: true,
    draft: newDraft,
    overwritten: !!(byName && force)
  }
}

function importDraftFromFile(filePath, options) {
  const fs = require('fs')
  const path = require('path')

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  if (!fs.existsSync(absPath)) {
    return { success: false, errors: [`文件不存在: ${absPath}`], blocked: false }
  }

  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const data = JSON.parse(raw)
    return importDraftFromJson(data, options)
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { success: false, errors: [`JSON 解析失败: ${e.message}`], blocked: false }
    }
    return { success: false, errors: [`读取文件失败: ${e.message}`], blocked: false }
  }
}

function listLogs(limit) {
  const logs = store.loadDraftLogs()
  const n = limit || 20
  return logs.slice(-n).reverse()
}

const MAX_UNDO_STACK = 20

function _pushUndoSnapshot(action, draftId, description, extraData, draftsBefore) {
  const snapshot = {
    action,
    draftId,
    description,
    timestamp: new Date().toISOString(),
    draftsSnapshot: draftsBefore ? JSON.parse(JSON.stringify(draftsBefore)) : JSON.parse(JSON.stringify(store.loadDrafts())),
    extraData: extraData ? JSON.parse(JSON.stringify(extraData)) : null
  }
  const stack = store.loadDraftUndoStack()
  stack.push(snapshot)
  if (stack.length > MAX_UNDO_STACK) {
    stack.splice(0, stack.length - MAX_UNDO_STACK)
  }
  store.saveDraftUndoStack(stack)
}

function _saveUndoSnapshot(action, draftId, description, extraData, draftsBefore) {
  _pushUndoSnapshot(action, draftId, description, extraData, draftsBefore)
}

function peekUndo() {
  const stack = store.loadDraftUndoStack()
  if (stack.length === 0) return null
  return stack[stack.length - 1]
}

function undoLastChange() {
  const stack = store.loadDraftUndoStack()
  if (stack.length === 0) {
    return { success: false, reason: '没有可撤销的草稿操作' }
  }

  const snap = stack.pop()
  const currentDrafts = store.loadDrafts()
  store.saveDrafts(snap.draftsSnapshot)
  store.saveDraftUndoStack(stack)

  const now = new Date().toISOString()
  store.appendDraftLog({
    action: 'undo',
    draftId: snap.draftId,
    timestamp: now,
    description: `撤销操作: ${snap.description}`
  })

  return {
    success: true,
    action: snap.action,
    description: snap.description,
    timestamp: snap.timestamp
  }
}

function undoStackSize() {
  return store.loadDraftUndoStack().length
}

function peekUndoStack() {
  return store.loadDraftUndoStack()
}

module.exports = {
  listDrafts,
  getDraft,
  getDraftByName,
  createDraft,
  updateDraft,
  deleteDraft,
  duplicateDraft,
  applyDraft,
  archiveDraft,
  compareDrafts,
  exportDraftToJson,
  exportDraftToFile,
  importDraftFromJson,
  importDraftFromFile,
  listLogs,
  peekUndo,
  undoLastChange,
  undoStackSize,
  peekUndoStack
}
