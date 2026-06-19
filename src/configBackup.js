const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('./store')
const configModule = require('./config')

const BACKUP_SCHEMA_VERSION = 1
const BACKUP_PREFIX = 'config-backup'

const KNOWN_CONFIG_KEYS = [
  'ticketPattern',
  'versionPattern',
  'versionPrefix',
  'keywords',
  'ignorePatterns'
]

const KNOWN_KEYWORD_CATEGORIES = ['feature', 'fix', 'breaking']

const SELECTABLE_FIELDS = [
  'ticketPattern',
  'versionPattern',
  'versionPrefix',
  'keywords.feature',
  'keywords.fix',
  'keywords.breaking',
  'ignorePatterns'
]

function generateBackupId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = crypto.randomBytes(4).toString('hex')
  return `${BACKUP_PREFIX}-${ts}-${rand}`
}

function buildBackupSnapshot(name) {
  const currentConfig = configModule.get()
  const snapshot = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupId: generateBackupId(),
    name: name || `配置备份 ${new Date().toLocaleString('zh-CN')}`,
    createdAt: new Date().toISOString(),
    config: {
      ticketPattern: currentConfig.ticketPattern,
      versionPattern: currentConfig.versionPattern,
      versionPrefix: currentConfig.versionPrefix,
      keywords: JSON.parse(JSON.stringify(currentConfig.keywords || {})),
      ignorePatterns: [...(currentConfig.ignorePatterns || [])]
    },
    checksum: null
  }
  snapshot.checksum = computeChecksum(snapshot.config)
  return snapshot
}

function computeChecksum(configData) {
  function canonicalStringify(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) {
      return '[' + value.map(canonicalStringify).join(',') + ']'
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value).sort()
      return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}'
    }
    return JSON.stringify(value)
  }
  const str = canonicalStringify(configData)
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex')
}

function getFieldValue(configObj, fieldPath) {
  const parts = fieldPath.split('.')
  let val = configObj
  for (const p of parts) {
    if (val === null || val === undefined) return undefined
    val = val[p]
  }
  return val
}

function setFieldValue(configObj, fieldPath, value) {
  const parts = fieldPath.split('.')
  let target = configObj
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] === undefined) {
      target[parts[i]] = {}
    }
    target = target[parts[i]]
  }
  target[parts[parts.length - 1]] = value
}

function diffArrays(backupArr, currentArr) {
  const b = backupArr || []
  const c = currentArr || []
  const added = []
  const removed = []
  const inBackup = new Set(b)
  const inCurrent = new Set(c)
  for (const item of b) {
    if (!inCurrent.has(item)) removed.push(item)
  }
  for (const item of c) {
    if (!inBackup.has(item)) added.push(item)
  }
  return { added, removed, identical: added.length === 0 && removed.length === 0 && b.length === c.length }
}

function computeDetailedDiff(backupConfig, currentConfig) {
  const diff = []
  for (const field of SELECTABLE_FIELDS) {
    const backupVal = getFieldValue(backupConfig, field)
    const currentVal = getFieldValue(currentConfig, field)
    const entry = {
      field,
      backupValue: JSON.parse(JSON.stringify(backupVal)),
      currentValue: JSON.parse(JSON.stringify(currentVal))
    }
    if (field.startsWith('keywords.') || field === 'ignorePatterns') {
      const arrDiff = diffArrays(backupVal || [], currentVal || [])
      entry.isArray = true
      entry.added = arrDiff.added
      entry.removed = arrDiff.removed
      entry.changed = !arrDiff.identical
    } else {
      entry.isArray = false
      entry.changed = backupVal !== currentVal
    }
    diff.push(entry)
  }
  return {
    fields: diff,
    changedFields: diff.filter(d => d.changed).map(d => d.field),
    hasChanges: diff.some(d => d.changed)
  }
}

function detectConflict(newConfig, existingConfig) {
  const changed = []

  for (const key of ['ticketPattern', 'versionPattern', 'versionPrefix']) {
    if (newConfig[key] !== existingConfig[key]) {
      changed.push({ field: key, from: existingConfig[key], to: newConfig[key] })
    }
  }

  for (const cat of KNOWN_KEYWORD_CATEGORIES) {
    const newKw = (newConfig.keywords && newConfig.keywords[cat]) || []
    const oldKw = (existingConfig.keywords && existingConfig.keywords[cat]) || []
    if (JSON.stringify(newKw) !== JSON.stringify(oldKw)) {
      changed.push({ field: `keywords.${cat}`, from: [...oldKw], to: [...newKw] })
    }
  }

  const newIg = newConfig.ignorePatterns || []
  const oldIg = existingConfig.ignorePatterns || []
  if (JSON.stringify(newIg) !== JSON.stringify(oldIg)) {
    changed.push({ field: 'ignorePatterns', from: [...oldIg], to: [...newIg] })
  }

  return { hasConflict: changed.length > 0, changes: changed }
}

function exportBackup(name) {
  const snapshot = buildBackupSnapshot(name)
  const filename = `${snapshot.backupId}.json`
  const filePath = store.writeBackupFile(filename, snapshot)
  return {
    success: true,
    filename,
    path: filePath,
    backupId: snapshot.backupId,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    checksum: snapshot.checksum
  }
}

function exportBackupToCustomPath(outputPath, name) {
  const snapshot = buildBackupSnapshot(name)
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf-8')
  return {
    success: true,
    path: outputPath,
    backupId: snapshot.backupId,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    checksum: snapshot.checksum
  }
}

function validateBackupStructure(data) {
  const errors = []
  const warnings = []
  const info = []

  if (!data || typeof data !== 'object') {
    errors.push('备份文件不是合法的 JSON 对象')
    return { valid: false, errors, warnings, info }
  }

  if (!data.schemaVersion) {
    errors.push('缺少 schemaVersion 字段')
  } else if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    if (data.schemaVersion > BACKUP_SCHEMA_VERSION) {
      errors.push(`schemaVersion 过高 (${data.schemaVersion})，当前工具仅支持 v${BACKUP_SCHEMA_VERSION}`)
    } else {
      warnings.push(`schemaVersion 较低 (${data.schemaVersion})，可能存在字段缺失，将尝试兼容导入`)
    }
  }

  if (!data.backupId) {
    warnings.push('缺少 backupId 字段，将自动生成')
  }

  if (!data.config) {
    errors.push('缺少 config 字段（配置主体）')
    return { valid: false, errors, warnings, info }
  }

  const cfg = data.config
  if (typeof cfg !== 'object') {
    errors.push('config 字段不是对象')
    return { valid: false, errors, warnings, info }
  }

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      warnings.push(`config 中存在未知键 "${key}"，导入时将被忽略`)
    }
  }

  const requiredTop = ['ticketPattern', 'versionPattern', 'versionPrefix']
  for (const key of requiredTop) {
    if (!(key in cfg)) {
      errors.push(`config 缺少必要字段 "${key}"`)
    } else if (typeof cfg[key] !== 'string') {
      errors.push(`config.${key} 必须是字符串`)
    }
  }

  if (!('keywords' in cfg)) {
    errors.push('config 缺少必要字段 "keywords"')
  } else if (typeof cfg.keywords !== 'object' || cfg.keywords === null) {
    errors.push('config.keywords 必须是对象')
  } else {
    for (const cat of Object.keys(cfg.keywords)) {
      if (!KNOWN_KEYWORD_CATEGORIES.includes(cat)) {
        warnings.push(`config.keywords 中存在未知分类 "${cat}"，导入时将被忽略`)
      }
    }
    for (const cat of KNOWN_KEYWORD_CATEGORIES) {
      if (!(cat in cfg.keywords)) {
        warnings.push(`config.keywords 缺少 "${cat}" 分类，将使用默认值`)
      } else if (!Array.isArray(cfg.keywords[cat])) {
        errors.push(`config.keywords.${cat} 必须是数组`)
      } else {
        cfg.keywords[cat].forEach((w, i) => {
          if (typeof w !== 'string') {
            errors.push(`config.keywords.${cat}[${i}] 必须是字符串`)
          }
        })
      }
    }
  }

  if (!('ignorePatterns' in cfg)) {
    errors.push('config 缺少必要字段 "ignorePatterns"')
  } else if (!Array.isArray(cfg.ignorePatterns)) {
    errors.push('config.ignorePatterns 必须是数组')
  } else {
    cfg.ignorePatterns.forEach((p, i) => {
      if (typeof p !== 'string') {
        errors.push(`config.ignorePatterns[${i}] 必须是字符串`)
      }
    })
  }

  if (data.checksum) {
    const actualChecksum = computeChecksum(cfg)
    if (actualChecksum !== data.checksum) {
      warnings.push('校验和不匹配，备份文件可能被手动编辑过')
    } else {
      info.push('校验和验证通过')
    }
  } else {
    warnings.push('缺少 checksum 字段，无法验证完整性')
  }

  const regexErrors = configModule.validateConfig(cfg)
  regexErrors.forEach(e => errors.push(e))

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info
  }
}

function diffBackup(backupData) {
  const currentConfig = configModule.get()
  const validation = validateBackupStructure(backupData)
  const detailedDiff = computeDetailedDiff(backupData.config, currentConfig)
  const conflict = detectConflict(backupData.config, currentConfig)
  return {
    valid: validation.valid,
    validation,
    detailedDiff,
    conflict,
    selectableFields: SELECTABLE_FIELDS
  }
}

function diffBackupFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { success: false, errors: [`备份文件不存在: ${filePath}`] }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    const result = diffBackup(data)
    return { success: true, ...result, sourcePath: filePath }
  } catch (e) {
    return { success: false, errors: [`读取/解析备份文件失败: ${e.message}`] }
  }
}

function isDuplicateBackup(newSnapshot) {
  if (!newSnapshot || !newSnapshot.backupId) return null
  const backups = store.listBackups()
  const existing = backups.find(b => b.filename.includes(newSnapshot.backupId))
  return existing || null
}

function findBackupByChecksum(checksum) {
  if (!checksum) return null
  const backups = store.listBackups()
  for (const b of backups) {
    const read = store.readBackupFile(b.filename)
    if (read && read.content && read.content.checksum === checksum) {
      return b
    }
  }
  return null
}

function writeRestoreLog(entry) {
  try {
    store.appendRestoreLog(entry)
    return true
  } catch (e) {
    return false
  }
}

function buildRestoredConfig(backupConfig, selectedFields, existingConfig) {
  const merged = JSON.parse(JSON.stringify(existingConfig))
  for (const field of selectedFields) {
    if (!SELECTABLE_FIELDS.includes(field)) continue
    const val = getFieldValue(backupConfig, field)
    if (val !== undefined) {
      setFieldValue(merged, field, JSON.parse(JSON.stringify(val)))
    }
  }
  return merged
}

function importBackupFromFile(filePath, options) {
  options = options || {}
  const force = options.force === true
  const dryRun = options.dryRun === true
  const selectedFields = Array.isArray(options.fields) ? options.fields : null

  const logs = []
  const warnings = []
  const errors = []

  if (!fs.existsSync(filePath)) {
    errors.push(`备份文件不存在: ${filePath}`)
    return { success: false, errors, warnings, logs }
  }

  let rawData
  try {
    rawData = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    errors.push(`读取备份文件失败: ${e.message}`)
    return { success: false, errors, warnings, logs }
  }

  let data
  try {
    data = JSON.parse(rawData)
  } catch (e) {
    errors.push(`备份文件不是合法 JSON: ${e.message}`)
    return { success: false, errors, warnings, logs }
  }

  logs.push(`已读取备份文件: ${filePath}`)

  const validation = validateBackupStructure(data)
  validation.errors.forEach(e => errors.push(e))
  validation.warnings.forEach(w => warnings.push(w))
  validation.info.forEach(i => logs.push(i))

  if (!validation.valid) {
    errors.push('备份文件结构验证失败，已中止导入')
    return { success: false, errors, warnings, logs }
  }

  const backupConfig = JSON.parse(JSON.stringify(data.config))
  const existingConfig = configModule.get()
  const existingConfigSnapshot = JSON.parse(JSON.stringify(existingConfig))

  const detailedDiff = computeDetailedDiff(backupConfig, existingConfig)
  const isPartial = selectedFields !== null && selectedFields.length > 0
  const effectiveFields = isPartial
    ? selectedFields.filter(f => SELECTABLE_FIELDS.includes(f) && detailedDiff.fields.find(d => d.field === f)?.changed)
    : detailedDiff.changedFields

  if (isPartial) {
    const invalid = selectedFields.filter(f => !SELECTABLE_FIELDS.includes(f))
    if (invalid.length > 0) {
      warnings.push(`忽略未知字段: ${invalid.join(', ')}`)
    }
    logs.push(`按项恢复模式，选中 ${selectedFields.length} 个字段，其中 ${effectiveFields.length} 个存在差异将被应用`)
  } else {
    logs.push(`整包恢复模式，共 ${effectiveFields.length} 个字段存在差异`)
  }

  for (const f of effectiveFields) {
    const d = detailedDiff.fields.find(x => x.field === f)
    if (d && d.isArray) {
      logs.push(`  - ${f}: 移除 ${JSON.stringify(d.removed)}, 新增 ${JSON.stringify(d.added)}`)
    } else if (d) {
      logs.push(`  - ${f}: ${JSON.stringify(d.currentValue)} → ${JSON.stringify(d.backupValue)}`)
    }
  }

  if (effectiveFields.length === 0) {
    logs.push('选中的字段与当前配置无差异，无需恢复')
  }

  const conflict = detectConflict(backupConfig, existingConfig)
  if (conflict.hasConflict) {
    const conflictFields = conflict.changes.map(c => c.field)
    const conflictingSelected = effectiveFields.filter(f => conflictFields.includes(f))
    if (conflictingSelected.length > 0) {
      warnings.push(`检测到 ${conflictingSelected.length} 个冲突字段（当前配置在备份导出后已被修改）: ${conflictingSelected.join(', ')}`)
    }
  }

  const dupById = isDuplicateBackup(data)
  if (dupById) {
    warnings.push(`已存在相同 backupId 的备份 (${data.backupId})`)
  }
  const dupByChecksum = findBackupByChecksum(data.checksum)
  if (dupByChecksum) {
    warnings.push(`已存在相同内容的备份 (${dupByChecksum.filename})`)
  }

  if (dryRun) {
    logs.push('dry-run 模式，未实际写入配置')
    return {
      success: true,
      dryRun: true,
      isPartial,
      selectedFields: effectiveFields,
      detailedDiff,
      errors,
      warnings,
      logs,
      wouldApply: conflict.changes.filter(c => effectiveFields.includes(c.field))
    }
  }

  if (effectiveFields.length === 0 && !force) {
    return {
      success: true,
      skipped: true,
      reason: isPartial ? 'no_changes_in_selected_fields' : ((dupById || dupByChecksum) ? 'duplicate_no_change' : 'no_changes_in_selected_fields'),
      isPartial,
      selectedFields: effectiveFields,
      errors,
      warnings,
      logs
    }
  }
  if (effectiveFields.length === 0 && force) {
    if (isPartial) {
      logs.push('force=true 但选中字段无差异，按项恢复无操作')
      return {
        success: true,
        skipped: true,
        reason: 'force_no_changes_partial',
        isPartial,
        selectedFields: effectiveFields,
        errors,
        warnings,
        logs
      }
    }
    logs.push('force=true 强制执行整包恢复（虽无差异）')
    const allFields = SELECTABLE_FIELDS.slice()
    if (dryRun) {
      logs.push('dry-run 模式，未实际写入配置')
      return {
        success: true,
        dryRun: true,
        isPartial: false,
        selectedFields: allFields,
        detailedDiff,
        errors,
        warnings,
        logs,
        wouldApply: []
      }
    }
  }

  const finalFields = effectiveFields.length > 0
    ? effectiveFields
    : (isPartial ? [] : SELECTABLE_FIELDS.slice())

  const mergedConfig = isPartial
    ? buildRestoredConfig(backupConfig, finalFields, existingConfigSnapshot)
    : JSON.parse(JSON.stringify(backupConfig))

  const appliedChanges = conflict.changes.filter(c => finalFields.includes(c.field))

  const previousSnapshot = {
    backupId: data.backupId || ('imported-' + Date.now()),
    name: data.name || '导入的配置',
    restoredAt: new Date().toISOString(),
    previousConfig: existingConfigSnapshot,
    restoredConfig: JSON.parse(JSON.stringify(mergedConfig)),
    sourcePath: path.resolve(filePath),
    isPartial,
    selectedFields: finalFields
  }

  try {
    store.saveConfig(JSON.parse(JSON.stringify(mergedConfig)))
    const verifyConfig = store.loadConfig()
    const verifyErrors = configModule.validateConfig(verifyConfig)
    if (verifyErrors.length > 0) {
      throw new Error('写入后校验失败: ' + verifyErrors.join('; '))
    }
  } catch (e) {
    errors.push(`写入配置失败: ${e.message}`)
    try {
      store.saveConfig(existingConfigSnapshot)
      logs.push('已自动回滚到原配置')
    } catch (rollbackErr) {
      errors.push(`回滚失败！配置可能处于不一致状态: ${rollbackErr.message}`)
    }
    return { success: false, errors, warnings, logs }
  }

  try {
    store.saveConfigRestoreUndo(previousSnapshot)
    logs.push('已保存恢复前快照，可使用 undo-restore 撤销')
  } catch (e) {
    warnings.push(`保存撤销快照失败: ${e.message}（不影响本次恢复结果）`)
  }

  try {
    writeRestoreLog({
      timestamp: new Date().toISOString(),
      action: isPartial ? 'partial_restore' : 'full_restore',
      backupId: data.backupId,
      backupName: data.name,
      sourcePath: path.resolve(filePath),
      selectedFields: finalFields,
      changes: appliedChanges,
      warnings: [...warnings],
      success: true
    })
    logs.push('恢复操作已写入日志')
  } catch (e) {
    warnings.push(`写入恢复日志失败: ${e.message}`)
  }

  return {
    success: true,
    restoredConfig: mergedConfig,
    previousConfig: existingConfigSnapshot,
    changes: appliedChanges,
    isPartial,
    selectedFields: finalFields,
    detailedDiff,
    errors,
    warnings,
    logs
  }
}

function importBackup(filename, options) {
  const resolved = store.readBackupFile(filename)
  if (!resolved) {
    return { success: false, errors: [`备份不存在: ${filename}`], warnings: [], logs: [] }
  }
  return importBackupFromFile(resolved.path, options)
}

function undoLastRestore() {
  const undoSnapshot = store.loadConfigRestoreUndo()
  if (!undoSnapshot) {
    return {
      success: false,
      reason: '没有可撤销的配置恢复操作',
      errors: [],
      warnings: [],
      logs: []
    }
  }

  const currentConfig = configModule.get()
  const currentConfigSnapshot = JSON.parse(JSON.stringify(currentConfig))
  const logs = []
  const errors = []
  const warnings = []

  logs.push(`准备撤销恢复操作，来源: ${undoSnapshot.sourcePath || undoSnapshot.backupId}`)
  logs.push(`恢复时间: ${undoSnapshot.restoredAt}`)
  if (undoSnapshot.isPartial) {
    logs.push(`本次撤销对应按项恢复，涉及字段: ${(undoSnapshot.selectedFields || []).join(', ')}`)
  }

  try {
    store.saveConfig(JSON.parse(JSON.stringify(undoSnapshot.previousConfig)))
    const verify = store.loadConfig()
    const verifyErrors = configModule.validateConfig(verify)
    if (verifyErrors.length > 0) {
      throw new Error('撤销后校验失败: ' + verifyErrors.join('; '))
    }
  } catch (e) {
    errors.push(`撤销失败: ${e.message}`)
    try {
      store.saveConfig(currentConfigSnapshot)
      logs.push('已自动回滚到撤销前的配置')
    } catch (rbErr) {
      errors.push(`回滚失败！配置可能处于不一致状态: ${rbErr.message}`)
    }
    return { success: false, errors, warnings, logs }
  }

  try {
    writeRestoreLog({
      timestamp: new Date().toISOString(),
      action: 'undo_restore',
      backupId: undoSnapshot.backupId,
      backupName: undoSnapshot.name,
      sourcePath: undoSnapshot.sourcePath,
      isPartial: undoSnapshot.isPartial,
      selectedFields: undoSnapshot.selectedFields || [],
      success: true
    })
    logs.push('撤销操作已写入日志')
  } catch (e) {
    warnings.push(`写入撤销日志失败: ${e.message}`)
  }

  try {
    store.clearConfigRestoreUndo()
    logs.push('已清除撤销快照')
  } catch (e) {
    warnings.push(`清除撤销快照失败: ${e.message}`)
  }

  return {
    success: true,
    restoredConfig: undoSnapshot.previousConfig,
    previousBeforeUndo: currentConfigSnapshot,
    sourceBackup: undoSnapshot.backupId,
    sourceName: undoSnapshot.name,
    isPartial: undoSnapshot.isPartial,
    selectedFields: undoSnapshot.selectedFields,
    errors,
    warnings,
    logs
  }
}

function peekRestoreUndo() {
  const snap = store.loadConfigRestoreUndo()
  if (!snap) return null
  return {
    backupId: snap.backupId,
    name: snap.name,
    restoredAt: snap.restoredAt,
    sourcePath: snap.sourcePath,
    previousConfig: snap.previousConfig,
    restoredConfig: snap.restoredConfig,
    isPartial: snap.isPartial,
    selectedFields: snap.selectedFields
  }
}

function listRestoreLogs(limit) {
  const logs = store.loadRestoreLogs()
  const n = typeof limit === 'number' ? Math.min(limit, logs.length) : logs.length
  return logs.slice(logs.length - n).reverse()
}

function listBackups() {
  return store.listBackups()
}

function deleteBackup(filename) {
  const result = store.deleteBackupFile(filename)
  return { success: result }
}

module.exports = {
  exportBackup,
  exportBackupToCustomPath,
  validateBackupStructure,
  importBackup,
  importBackupFromFile,
  undoLastRestore,
  peekRestoreUndo,
  listBackups,
  deleteBackup,
  computeDetailedDiff,
  diffBackup,
  diffBackupFromFile,
  listRestoreLogs,
  SELECTABLE_FIELDS,
  BACKUP_SCHEMA_VERSION,
  KNOWN_CONFIG_KEYS,
  KNOWN_KEYWORD_CATEGORIES,
  _testExports: {
    computeChecksum,
    detectConflict,
    buildBackupSnapshot,
    diffArrays,
    getFieldValue,
    setFieldValue,
    buildRestoredConfig
  }
}
