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

function importBackupFromFile(filePath, options) {
  options = options || {}
  const force = options.force === true
  const dryRun = options.dryRun === true

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

  const newConfig = JSON.parse(JSON.stringify(data.config))
  const existingConfig = configModule.get()
  const existingConfigSnapshot = JSON.parse(JSON.stringify(existingConfig))

  const conflict = detectConflict(newConfig, existingConfig)
  if (conflict.hasConflict) {
    logs.push(`检测到 ${conflict.changes.length} 处配置差异`)
    conflict.changes.forEach(c => {
      logs.push(`  - ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
    })
  } else {
    logs.push('新配置与当前配置完全一致')
  }

  const dupById = isDuplicateBackup(data)
  if (dupById) {
    warnings.push(`已存在相同 backupId 的备份 (${data.backupId})`)
  }
  const dupByChecksum = findBackupByChecksum(data.checksum)
  if (dupByChecksum) {
    warnings.push(`已存在相同内容的备份 (${dupByChecksum.filename})`)
  }

  if (!force && (dupById || dupByChecksum) && !conflict.hasConflict) {
    warnings.push('检测到重复导入且配置无变化，将跳过实际写入（使用 force=true 可强制执行）')
    return {
      success: true,
      skipped: true,
      reason: 'duplicate_no_change',
      errors,
      warnings,
      logs
    }
  }

  if (dryRun) {
    logs.push('dry-run 模式，未实际写入配置')
    return {
      success: true,
      dryRun: true,
      errors,
      warnings,
      logs,
      wouldApply: conflict.changes
    }
  }

  const previousSnapshot = {
    backupId: data.backupId || ('imported-' + Date.now()),
    name: data.name || '导入的配置',
    restoredAt: new Date().toISOString(),
    previousConfig: existingConfigSnapshot,
    restoredConfig: JSON.parse(JSON.stringify(newConfig)),
    sourcePath: path.resolve(filePath)
  }

  try {
    store.saveConfig(JSON.parse(JSON.stringify(newConfig)))
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

  return {
    success: true,
    restoredConfig: newConfig,
    previousConfig: existingConfigSnapshot,
    changes: conflict.changes,
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
    restoredConfig: snap.restoredConfig
  }
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
  BACKUP_SCHEMA_VERSION,
  KNOWN_CONFIG_KEYS,
  KNOWN_KEYWORD_CATEGORIES,
  _testExports: {
    computeChecksum,
    detectConflict,
    buildBackupSnapshot
  }
}
