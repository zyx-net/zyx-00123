const store = require('./store')
const config = require('./config')
const validator = require('./validator')
const archiver = require('./archiver')
const versionRegistry = require('./versionRegistry')
const draftVault = require('./draftVault')
const operationAudit = require('./operationAudit')
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

function createDraft(options) {
  options = options || {}
  const name = options.name
  const version = options.version || ''
  const description = options.description || ''
  const force = options.force || false
  const isAdmin = options.isAdmin || false
  const userId = options.userId
  const userName = options.userName
  const takeoverReason = options.takeoverReason || ''

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

  if (force && isAdmin && !takeoverReason) {
    return {
      success: false,
      errors: ['管理员强制接管必须提供接管理由'],
      blocked: true,
      reason: 'no_takeover_reason'
    }
  }

  const currentCommits = store.loadCommits()
  const filteredCommits = options.commits
    ? options.commits
    : currentCommits.filter(c => c.category !== 'ignored')

  const vaultSnap = draftVault.createSnapshot(null, draftVault.ACTION_CREATE, options._vaultSource || draftVault.SOURCE_CLI, {
    operator: userId,
    operatorName: userName,
    draftName: name,
    version,
    summary: description,
    body: JSON.parse(JSON.stringify(filteredCommits))
  })

  let occupyResult = null
  if (version) {
    occupyResult = versionRegistry.occupyVersion(version, {
      userId,
      userName,
      sourceAction: versionRegistry.SOURCE_CREATE,
      force,
      isAdmin,
      reason: takeoverReason
    })
    if (!occupyResult.success) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, occupyResult.errors.join('; '))
      return {
        success: false,
        errors: occupyResult.errors,
        blocked: occupyResult.blocked,
        reason: occupyResult.reason,
        versionConflict: occupyResult.conflict
      }
    }
  }

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

  try {
    store.saveDrafts(drafts)
  } catch (e) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, e.message)
    if (version && occupyResult && occupyResult.success) {
      versionRegistry.undoLastChange({ userId, userName })
    }
    return { success: false, errors: [`保存草稿失败: ${e.message}`], blocked: false }
  }

  if (version && occupyResult && occupyResult.entry) {
    const updateResult = versionRegistry.occupyVersion(version, {
      userId,
      userName,
      draftId: draft.id,
      draftName: name,
      sourceAction: versionRegistry.SOURCE_CREATE,
      force: true,
      isAdmin: true
    })
    if (!updateResult.success) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, updateResult.errors.join('; '))
      store.saveDrafts(draftsBefore)
      return {
        success: false,
        errors: updateResult.errors,
        blocked: updateResult.blocked,
        reason: updateResult.reason
      }
    }
  }

  store.appendDraftLog({
    action: 'create',
    draftId: draft.id,
    draftName: name,
    version,
    timestamp: now,
    description: `创建草稿: ${name}${version ? ' (版本: ' + version + ')' : ''}`
  })

  _saveUndoSnapshot('create', draft.id, `创建草稿: ${name}`, null, draftsBefore)

  draftVault.commitSnapshot(vaultSnap.snapshotId)

  return {
    success: true,
    draft,
    overwritten: !!(byName && force),
    versionRegistryEntry: occupyResult ? occupyResult.entry : null,
    tookOver: occupyResult ? occupyResult.tookOver : false
  }
}

function updateDraft(id, updates, options) {
  options = options || {}
  const force = options.force || false
  const isAdmin = options.isAdmin || false
  const userId = options.userId
  const userName = options.userName
  const takeoverReason = options.takeoverReason || ''

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

  const vaultSnap = draftVault.createSnapshot(id, draftVault.ACTION_UPDATE, options._vaultSource || draftVault.SOURCE_CLI, {
    operator: userId || 'system',
    operatorName: userName || '系统编排',
    draftName: oldDraft.name,
    version: newVersion
  })

  if (newVersion !== oldDraft.version) {
    const vr = versionRegistry.updateEntryForDraft(id, newName, newVersion, {
      userId,
      userName,
      force,
      isAdmin,
      reason: takeoverReason
    })
    if (!vr.success) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, vr.errors.join('; '))
      return {
        success: false,
        errors: vr.errors,
        blocked: vr.blocked,
        reason: vr.reason,
        versionConflict: vr.conflict
      }
    }
  } else if (newName !== oldDraft.name && newVersion) {
    versionRegistry.updateEntryForDraft(id, newName, newVersion, {
      userId,
      userName
    })
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

  try {
    store.saveDrafts(drafts)
  } catch (e) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, e.message)
    return { success: false, errors: [`保存草稿失败: ${e.message}`], blocked: false }
  }

  store.appendDraftLog({
    action: 'update',
    draftId: id,
    draftName: updated.name,
    version: newVersion,
    timestamp: updated.updatedAt,
    description: `更新草稿: ${updated.name}${newVersion ? ' (版本: ' + newVersion + ')' : ''}`
  })

  _saveUndoSnapshot('update', id, `更新草稿: ${updated.name}`, oldDraft, draftsBefore)

  draftVault.commitSnapshot(vaultSnap.snapshotId)

  return { success: true, draft: updated }
}

function deleteDraft(id, options) {
  options = options || {}
  const drafts = store.loadDrafts()
  const idx = drafts.findIndex(d => d.id === id)
  if (idx < 0) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const draftsBefore = JSON.parse(JSON.stringify(drafts))
  const deleted = drafts[idx]
  drafts.splice(idx, 1)
  store.saveDrafts(drafts)

  versionRegistry.releaseByDraftId(id, {
    userId: options.userId,
    userName: options.userName,
    reason: '删除草稿'
  })

  const now = new Date().toISOString()
  store.appendDraftLog({
    action: 'delete',
    draftId: id,
    draftName: deleted.name,
    version: deleted.version,
    timestamp: now,
    description: `删除草稿: ${deleted.name}${deleted.version ? ' (版本: ' + deleted.version + ')' : ''}`
  })

  _saveUndoSnapshot('delete', id, `删除草稿: ${deleted.name}`, deleted, draftsBefore)

  return { success: true, deleted }
}

function duplicateDraft(id, newName, options) {
  options = options || {}
  const resolve = options.resolve || 'cancel'
  const isAdmin = options.isAdmin || false
  const userId = options.userId
  const userName = options.userName
  const takeoverReason = options.takeoverReason || ''

  const draftObj = getDraft(id)
  if (!draftObj) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const vaultSnap = draftVault.createSnapshot(id, draftVault.ACTION_DUPLICATE, options._vaultSource || draftVault.SOURCE_CLI, {
    operator: userId || 'system',
    operatorName: userName || '系统编排',
    draftName: draftObj.name,
    version: draftObj.version
  })

  const name = newName || `${draftObj.name} (副本)`

  const effectiveVersion = options.version !== undefined ? options.version : draftObj.version
  const sourceDraftForOperation = effectiveVersion !== draftObj.version
    ? { ...draftObj, version: effectiveVersion }
    : draftObj

  const byName = findDuplicateName(name)

  if ((resolve === 'force' || resolve === 'overwrite') && isAdmin && !takeoverReason) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, '管理员强制接管必须提供接管理由')
    return {
      success: false,
      errors: ['管理员强制接管必须提供接管理由'],
      blocked: true,
      reason: 'no_takeover_reason'
    }
  }

  let versionConflict = null
  if (sourceDraftForOperation.version) {
    const vr = versionRegistry.checkAvailability(sourceDraftForOperation.version, { userId })
    const allDrafts = store.loadDrafts()
    const draftWithSameVersion = allDrafts.find(d => d.version === sourceDraftForOperation.version)
    
    if (!vr.available || draftWithSameVersion) {
      if (draftWithSameVersion) {
        versionConflict = {
          available: false,
          existing: vr.existing || null,
          reason: 'version_occupied',
          occupier: vr.occupier || draftWithSameVersion.name,
          sourceAction: vr.sourceAction || 'unknown',
          draftName: draftWithSameVersion.name,
          draftId: draftWithSameVersion.id,
          updatedAt: draftWithSameVersion.updatedAt
        }
      } else {
        versionConflict = vr
      }
    }
  }

  if (byName || versionConflict) {
    if (resolve === 'cancel') {
      const errors = []
      let reason = ''
      let existingId = null
      if (byName) {
        errors.push(`同名草稿已存在: ${name}`)
        reason = 'duplicate_name'
        existingId = byName.id
      }
      if (versionConflict) {
        errors.push(`版本号 ${sourceDraftForOperation.version} 已被占用: ${versionConflict.occupier}（来源: ${versionConflict.sourceAction || '未知'}，草稿: ${versionConflict.draftName || '(未知)'}）`)
        if (!reason) {
          reason = 'version_occupied'
        }
        if (!existingId && versionConflict.existing) {
          existingId = versionConflict.existing.draftId
        }
      }
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, errors.join('; '))
      return {
        success: false,
        errors,
        blocked: true,
        reason,
        existingId,
        conflictDetails: {
          nameConflict: byName ? { existingId: byName.id, existingName: byName.name } : null,
          versionConflict: versionConflict ? {
            existingId: versionConflict.existing ? versionConflict.existing.draftId : null,
            existingVersion: sourceDraftForOperation.version,
            existingName: versionConflict.draftName,
            occupier: versionConflict.occupier,
            sourceAction: versionConflict.sourceAction,
            availableActions: isAdmin ? ['rename', 'change_version', 'takeover'] : ['rename', 'change_version', 'cancel']
          } : null
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
      let finalVersion = sourceDraftForOperation.version
      let versionSuffix = 1
      if (finalVersion) {
        const isVersionAvailable = (ver) => {
          const vr = versionRegistry.checkAvailability(ver, { userId })
          const allDrafts = store.loadDrafts()
          const hasSameVersion = allDrafts.some(d => d.version === ver)
          return vr.available && !hasSameVersion
        }
        while (!isVersionAvailable(finalVersion)) {
          versionSuffix++
          finalVersion = `${sourceDraftForOperation.version}-副本${versionSuffix}`
        }
      }
      const sourceWithNewVersion = { ...draftObj, version: finalVersion }
      return _doDuplicateDraft(sourceWithNewVersion, finalName, { userId, userName, snapshotId: vaultSnap.snapshotId })
    }

    if (resolve === 'overwrite') {
      if (!byName) {
        draftVault.markSnapshotFailed(vaultSnap.snapshotId, '覆盖模式需要指定已存在的同名草稿')
        return {
          success: false,
          errors: ['覆盖模式需要指定已存在的同名草稿'],
          blocked: true,
          reason: 'no_name_match'
        }
      }
      return _doOverwriteDraft(sourceDraftForOperation, name, byName, { userId, userName, isAdmin, takeoverReason, snapshotId: vaultSnap.snapshotId })
    }

    if (resolve === 'force' && isAdmin && versionConflict) {
      return _doDuplicateDraft(sourceDraftForOperation, name, { userId, userName, isAdmin, force: true, takeoverReason, snapshotId: vaultSnap.snapshotId })
    }
  }

  return _doDuplicateDraft(sourceDraftForOperation, name, { userId, userName, snapshotId: vaultSnap.snapshotId })
}

function _doDuplicateDraft(sourceDraft, newName, options) {
  options = options || {}
  const snapshotId = options.snapshotId
  const draftsBefore = store.loadDrafts()
  const now = new Date().toISOString()

  let occupyResult = null
  if (sourceDraft.version) {
    occupyResult = versionRegistry.occupyVersion(sourceDraft.version, {
      userId: options.userId,
      userName: options.userName,
      sourceAction: versionRegistry.SOURCE_DUPLICATE,
      force: options.force || false,
      isAdmin: options.isAdmin || false,
      reason: options.takeoverReason || ''
    })
    if (!occupyResult.success) {
      if (snapshotId) draftVault.markSnapshotFailed(snapshotId, occupyResult.errors.join('; '))
      return {
        success: false,
        errors: occupyResult.errors,
        blocked: occupyResult.blocked,
        reason: occupyResult.reason,
        versionConflict: occupyResult.conflict
      }
    }
  }

  const newDraft = {
    ...JSON.parse(JSON.stringify(sourceDraft)),
    id: genId(),
    name: newName,
    createdAt: now,
    updatedAt: now
  }

  const drafts = store.loadDrafts()
  drafts.push(newDraft)

  try {
    store.saveDrafts(drafts)
  } catch (e) {
    if (snapshotId) draftVault.markSnapshotFailed(snapshotId, e.message)
    if (sourceDraft.version && occupyResult && occupyResult.success) {
      versionRegistry.undoLastChange({ userId: options.userId, userName: options.userName })
    }
    return { success: false, errors: [`保存草稿失败: ${e.message}`], blocked: false }
  }

  if (sourceDraft.version && occupyResult && occupyResult.entry) {
    const updateResult = versionRegistry.occupyVersion(sourceDraft.version, {
      userId: options.userId,
      userName: options.userName,
      draftId: newDraft.id,
      draftName: newName,
      sourceAction: versionRegistry.SOURCE_DUPLICATE,
      force: true,
      isAdmin: true
    })
    if (!updateResult.success) {
      if (snapshotId) draftVault.markSnapshotFailed(snapshotId, updateResult.errors.join('; '))
      store.saveDrafts(draftsBefore)
      return {
        success: false,
        errors: updateResult.errors,
        blocked: updateResult.blocked,
        reason: updateResult.reason
      }
    }
  }

  store.appendDraftLog({
    action: 'duplicate',
    draftId: newDraft.id,
    draftName: newName,
    version: newDraft.version,
    sourceDraftId: sourceDraft.id,
    sourceDraftName: sourceDraft.name,
    timestamp: now,
    description: `复制草稿: ${sourceDraft.name} → ${newName}${newDraft.version ? ' (版本: ' + newDraft.version + ')' : ''}`
  })

  _pushUndoSnapshot('duplicate', newDraft.id, `复制草稿: ${sourceDraft.name} → ${newName}`, null, draftsBefore)

  if (snapshotId) draftVault.commitSnapshot(snapshotId)

  return { success: true, draft: newDraft, versionRegistryEntry: occupyResult ? occupyResult.entry : null, tookOver: occupyResult ? occupyResult.tookOver : false }
}

function _doOverwriteDraft(sourceDraft, targetName, existingDraft, options) {
  options = options || {}
  const snapshotId = options.snapshotId
  const draftsBefore = JSON.parse(JSON.stringify(store.loadDrafts()))
  const now = new Date().toISOString()

  let occupyResult = null
  if (sourceDraft.version) {
    if (sourceDraft.version !== existingDraft.version) {
      occupyResult = versionRegistry.occupyVersion(sourceDraft.version, {
        userId: options.userId,
        userName: options.userName,
        sourceAction: versionRegistry.SOURCE_DUPLICATE,
        force: true,
        isAdmin: options.isAdmin || false,
        reason: options.takeoverReason || ''
      })
      if (!occupyResult.success) {
        if (snapshotId) draftVault.markSnapshotFailed(snapshotId, occupyResult.errors.join('; '))
        return {
          success: false,
          errors: occupyResult.errors,
          blocked: occupyResult.blocked,
          reason: occupyResult.reason,
          versionConflict: occupyResult.conflict
        }
      }
    } else {
      versionRegistry.releaseVersion(sourceDraft.version, {
        userId: options.userId,
        userName: options.userName,
        reason: '覆盖前释放旧占用'
      })
      occupyResult = versionRegistry.occupyVersion(sourceDraft.version, {
        userId: options.userId,
        userName: options.userName,
        sourceAction: versionRegistry.SOURCE_DUPLICATE,
        force: false,
        isAdmin: options.isAdmin || false,
        draftId: existingDraft.id
      })
      if (!occupyResult.success) {
        if (snapshotId) draftVault.markSnapshotFailed(snapshotId, occupyResult.errors.join('; '))
        return {
          success: false,
          errors: occupyResult.errors,
          blocked: occupyResult.blocked,
          reason: occupyResult.reason,
          versionConflict: occupyResult.conflict
        }
      }
    }
  }

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
    if (snapshotId) draftVault.markSnapshotFailed(snapshotId, `目标草稿不存在: ${existingDraft.id}`)
    if (sourceDraft.version && occupyResult && occupyResult.success) {
      versionRegistry.undoLastChange({ userId: options.userId, userName: options.userName })
    }
    return { success: false, errors: [`目标草稿不存在: ${existingDraft.id}`], blocked: false }
  }
  drafts[idx] = overwrittenDraft

  try {
    store.saveDrafts(drafts)
  } catch (e) {
    if (snapshotId) draftVault.markSnapshotFailed(snapshotId, e.message)
    if (sourceDraft.version && occupyResult && occupyResult.success) {
      versionRegistry.undoLastChange({ userId: options.userId, userName: options.userName })
    }
    return { success: false, errors: [`保存草稿失败: ${e.message}`], blocked: false }
  }

  if (sourceDraft.version && occupyResult && occupyResult.entry) {
    const updateResult = versionRegistry.occupyVersion(sourceDraft.version, {
      userId: options.userId,
      userName: options.userName,
      draftId: overwrittenDraft.id,
      draftName: targetName,
      sourceAction: versionRegistry.SOURCE_DUPLICATE,
      force: true,
      isAdmin: true
    })
    if (!updateResult.success) {
      if (snapshotId) draftVault.markSnapshotFailed(snapshotId, updateResult.errors.join('; '))
      store.saveDrafts(draftsBefore)
      return {
        success: false,
        errors: updateResult.errors,
        blocked: updateResult.blocked,
        reason: updateResult.reason
      }
    }
  }

  store.appendDraftLog({
    action: 'duplicate_overwrite',
    draftId: overwrittenDraft.id,
    draftName: targetName,
    version: overwrittenDraft.version,
    sourceDraftId: sourceDraft.id,
    sourceDraftName: sourceDraft.name,
    overwrittenDraftId: existingDraft.id,
    overwrittenDraftName: existingDraft.name,
    timestamp: now,
    description: `覆盖复制草稿: ${sourceDraft.name} → ${targetName} (覆盖 ${existingDraft.name})`
  })

  _pushUndoSnapshot('duplicate_overwrite', overwrittenDraft.id, `覆盖复制草稿: ${sourceDraft.name} → ${targetName}`, existingDraft, draftsBefore)

  if (snapshotId) draftVault.commitSnapshot(snapshotId)

  return { success: true, draft: overwrittenDraft, overwritten: true, versionRegistryEntry: occupyResult ? occupyResult.entry : null }
}

function applyDraft(id, options) {
  options = options || {}
  const auditContext = options._auditContext || null

  if (auditContext) {
    return operationAudit.orchestrateApply(id, auditContext, () => _applyDraftInner(id))
  }

  return _applyDraftInner(id)
}

function _applyDraftInner(id) {
  const draft = getDraft(id)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  const currentCommits = store.loadCommits()

  const vaultSnap = draftVault.createSnapshot(id, draftVault.ACTION_APPLY, draftVault.SOURCE_CLI, {
    operator: 'system',
    operatorName: '系统编排',
    draftName: draft.name,
    version: draft.version
  })

  try {
    store.saveCommits(JSON.parse(JSON.stringify(draft.commits)))
  } catch (e) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, e.message)
    return { success: false, errors: [`应用草稿失败: ${e.message}`], blocked: false }
  }

  const now = new Date().toISOString()
  store.appendDraftLog({
    action: 'apply',
    draftId: id,
    draftName: draft.name,
    timestamp: now,
    description: `应用草稿: ${draft.name}`
  })

  draftVault.commitSnapshot(vaultSnap.snapshotId)

  return {
    success: true,
    draft,
    previousCommitCount: currentCommits.length,
    appliedCommitCount: draft.commits.length
  }
}

function archiveDraft(id, options) {
  options = options || {}
  const auditContext = options._auditContext || null

  if (auditContext) {
    return operationAudit.orchestrateArchive(id, auditContext, () => _archiveDraftInner(id, options))
  }

  return _archiveDraftInner(id, options)
}

function _archiveDraftInner(id, options) {
  options = options || {}
  const draft = getDraft(id)
  if (!draft) {
    return { success: false, errors: [`草稿不存在: ${id}`], blocked: false }
  }

  if (!draft.version) {
    return { success: false, errors: ['草稿未设置版本号，无法归档'], blocked: false }
  }

  const vaultSnap = draftVault.createSnapshot(id, draftVault.ACTION_ARCHIVE, (options._vaultSource || draftVault.SOURCE_CLI), {
    operator: options.userId || 'system',
    operatorName: options.userName || '系统编排',
    draftName: draft.name,
    version: draft.version
  })

  const currentCommits = store.loadCommits()

  try {
    store.saveCommits(JSON.parse(JSON.stringify(draft.commits)))

    const check = validator.checkArchiveReadiness(draft.version)
    if (!check.ready) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, check.reason)
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

    versionRegistry.releaseByDraftId(id, {
      userId: options.userId,
      userName: options.userName,
      reason: '草稿归档成功'
    })

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

    draftVault.commitSnapshot(vaultSnap.snapshotId)

    return { success: true, snapshot, draft }
  } catch (e) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, e.message)
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
  const auditContext = options._auditContext || null

  if (auditContext) {
    return operationAudit.orchestrateImport(auditContext, () => _importDraftFromJsonInner(data, options))
  }

  return _importDraftFromJsonInner(data, options)
}

function _importDraftFromJsonInner(data, options) {
  options = options || {}
  const asName = options.asName || null
  const force = options.force || false
  const isAdmin = options.isAdmin || false
  const userId = options.userId
  const userName = options.userName
  const takeoverReason = options.takeoverReason || ''

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

  if (force && isAdmin && !takeoverReason) {
    return {
      success: false,
      errors: ['管理员强制接管必须提供接管理由'],
      blocked: true,
      reason: 'no_takeover_reason'
    }
  }

  const vaultSnap = draftVault.createSnapshot(null, draftVault.ACTION_IMPORT, options._vaultSource || draftVault.SOURCE_CLI, {
    operator: userId || 'system',
    operatorName: userName || '系统编排',
    draftName: name,
    version: draftData.version || ''
  })

  let occupyResult = null
  if (draftData.version) {
    occupyResult = versionRegistry.occupyVersion(draftData.version, {
      userId,
      userName,
      sourceAction: versionRegistry.SOURCE_IMPORT,
      force,
      isAdmin,
      reason: takeoverReason
    })
    if (!occupyResult.success) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, occupyResult.errors.join('; '))
      return {
        success: false,
        errors: occupyResult.errors,
        blocked: occupyResult.blocked,
        reason: occupyResult.reason,
        versionConflict: occupyResult.conflict
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

  try {
    store.saveDrafts(drafts)
  } catch (e) {
    draftVault.markSnapshotFailed(vaultSnap.snapshotId, e.message)
    if (draftData.version && occupyResult && occupyResult.success) {
      versionRegistry.undoLastChange({ userId, userName })
    }
    return { success: false, errors: [`保存草稿失败: ${e.message}`], blocked: false }
  }

  if (draftData.version && occupyResult && occupyResult.entry) {
    const updateResult = versionRegistry.occupyVersion(draftData.version, {
      userId,
      userName,
      draftId: newDraft.id,
      draftName: name,
      sourceAction: versionRegistry.SOURCE_IMPORT,
      force: true,
      isAdmin: true
    })
    if (!updateResult.success) {
      draftVault.markSnapshotFailed(vaultSnap.snapshotId, updateResult.errors.join('; '))
      store.saveDrafts(draftsBefore)
      return {
        success: false,
        errors: updateResult.errors,
        blocked: updateResult.blocked,
        reason: updateResult.reason
      }
    }
  }

  store.appendDraftLog({
    action: 'import',
    draftId: newDraft.id,
    draftName: name,
    version: newDraft.version,
    timestamp: now,
    description: `导入草稿: ${name}${newDraft.version ? ' (版本: ' + newDraft.version + ')' : ''}`
  })

  _saveUndoSnapshot('import', newDraft.id, `导入草稿: ${name}`, null, draftsBefore)

  draftVault.commitSnapshot(vaultSnap.snapshotId)

  return {
    success: true,
    draft: newDraft,
    overwritten: !!(byName && force),
    versionRegistryEntry: occupyResult ? occupyResult.entry : null,
    tookOver: occupyResult ? occupyResult.tookOver : false
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

function reconcileRegistry() {
  const drafts = store.loadDrafts()
  return versionRegistry.reconcileWithDrafts(drafts)
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
  peekUndoStack,
  reconcileRegistry
}
