const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('./store')

const PROFILE_SCHEMA_VERSION = 1

const KNOWN_CATEGORIES = ['breaking', 'feature', 'fix', 'other']

const DEFAULT_GROUP_ORDER = ['breaking', 'feature', 'fix', 'other']

const CATEGORY_LABELS = {
  breaking: '⚠ 破坏性变更',
  feature: '✨ 新功能',
  fix: '🐛 修复',
  other: '📋 其他'
}

const REQUIRED_FIELDS = [
  'name',
  'titleTemplate',
  'groupOrder',
  'includeTicket',
  'includeAuthor',
  'includeDate',
  'outputDir'
]

function generateProfileId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = crypto.randomBytes(4).toString('hex')
  return `profile-${ts}-${rand}`
}

function getDefaultProfile() {
  return {
    id: '__default__',
    name: '默认方案',
    titleTemplate: '发布说明 - ${version}',
    groupOrder: [...DEFAULT_GROUP_ORDER],
    includeTicket: true,
    includeAuthor: false,
    includeDate: true,
    outputDir: '',
    isDefault: false,
    createdAt: null,
    updatedAt: null,
    schemaVersion: PROFILE_SCHEMA_VERSION
  }
}

function validateProfile(profile, options) {
  options = options || {}
  const strict = options.strict !== false
  const errors = []
  const warnings = []
  const info = []

  if (!profile || typeof profile !== 'object') {
    errors.push('方案不是合法对象')
    return { valid: false, errors, warnings, info }
  }

  if (strict) {
    for (const f of REQUIRED_FIELDS) {
      if (!(f in profile)) {
        errors.push(`缺少必要字段: ${f}`)
      }
    }
  }

  if (profile.name !== undefined) {
    if (typeof profile.name !== 'string') {
      errors.push('name 必须是字符串')
    } else if (profile.name.trim().length === 0) {
      errors.push('name 不能为空')
    }
  }

  if (profile.titleTemplate !== undefined) {
    if (typeof profile.titleTemplate !== 'string') {
      errors.push('titleTemplate 必须是字符串')
    } else if (profile.titleTemplate.length === 0) {
      warnings.push('titleTemplate 为空，将使用默认格式')
    }
  }

  if (profile.groupOrder !== undefined) {
    if (!Array.isArray(profile.groupOrder)) {
      errors.push('groupOrder 必须是数组')
    } else {
      const seen = new Set()
      profile.groupOrder.forEach((cat, i) => {
        if (typeof cat !== 'string') {
          errors.push(`groupOrder[${i}] 必须是字符串`)
        } else if (!KNOWN_CATEGORIES.includes(cat)) {
          warnings.push(`groupOrder[${i}] "${cat}" 不是已知分类，将被忽略`)
        } else if (seen.has(cat)) {
          errors.push(`groupOrder 存在重复分类: ${cat}`)
        } else {
          seen.add(cat)
        }
      })
      KNOWN_CATEGORIES.forEach(cat => {
        if (!seen.has(cat)) {
          warnings.push(`groupOrder 缺少分类 "${cat}"，导出时该分类将被跳过`)
        }
      })
    }
  }

  for (const f of ['includeTicket', 'includeAuthor', 'includeDate']) {
    if (profile[f] !== undefined && typeof profile[f] !== 'boolean') {
      errors.push(`${f} 必须是布尔值`)
    }
  }

  if (profile.outputDir !== undefined && typeof profile.outputDir !== 'string') {
    errors.push('outputDir 必须是字符串')
  }

  if (profile.schemaVersion !== undefined) {
    if (typeof profile.schemaVersion !== 'number') {
      errors.push('schemaVersion 必须是数字')
    } else if (profile.schemaVersion > PROFILE_SCHEMA_VERSION) {
      errors.push(`schemaVersion 过高 (${profile.schemaVersion})，当前工具仅支持 v${PROFILE_SCHEMA_VERSION}`)
    } else if (profile.schemaVersion < PROFILE_SCHEMA_VERSION) {
      warnings.push(`schemaVersion 较低 (${profile.schemaVersion})，可能存在字段缺失，将尝试兼容导入`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info
  }
}

function normalizeProfile(input) {
  const def = getDefaultProfile()
  const result = {
    id: input.id || generateProfileId(),
    name: input.name || def.name,
    titleTemplate: input.titleTemplate || def.titleTemplate,
    groupOrder: Array.isArray(input.groupOrder) ? input.groupOrder.filter(c => KNOWN_CATEGORIES.includes(c)) : [...def.groupOrder],
    includeTicket: typeof input.includeTicket === 'boolean' ? input.includeTicket : def.includeTicket,
    includeAuthor: typeof input.includeAuthor === 'boolean' ? input.includeAuthor : def.includeAuthor,
    includeDate: typeof input.includeDate === 'boolean' ? input.includeDate : def.includeDate,
    outputDir: typeof input.outputDir === 'string' ? input.outputDir : def.outputDir,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const dedup = []
  const seen = new Set()
  for (const c of result.groupOrder) {
    if (!seen.has(c)) {
      seen.add(c)
      dedup.push(c)
    }
  }
  result.groupOrder = dedup
  return result
}

function writeLog(entry) {
  try {
    store.appendExportProfileLog(entry)
    return true
  } catch (e) {
    return false
  }
}

function saveUndoSnapshot(description, profilesBefore, defaultBefore) {
  try {
    store.saveExportProfileUndo({
      timestamp: new Date().toISOString(),
      description,
      profiles: JSON.parse(JSON.stringify(profilesBefore)),
      default: defaultBefore
    })
    return true
  } catch (e) {
    return false
  }
}

function listProfiles() {
  const data = store.loadExportProfiles()
  const profiles = data.profiles.map(p => normalizeProfile(p))
  const defId = data.default
  profiles.forEach(p => { p.isDefault = p.id === defId })
  return profiles
}

function getProfile(id) {
  const profiles = listProfiles()
  return profiles.find(p => p.id === id) || null
}

function getProfileByName(name) {
  const profiles = listProfiles()
  return profiles.find(p => p.name === name) || null
}

function getDefaultProfileId() {
  const data = store.loadExportProfiles()
  return data.default
}

function getDefaultProfileObj() {
  const defId = getDefaultProfileId()
  if (defId) {
    const p = getProfile(defId)
    if (p) return p
  }
  return normalizeProfile({})
}

function setDefault(id) {
  const logs = []
  const warnings = []
  const errors = []

  const data = store.loadExportProfiles()
  const profiles = data.profiles
  const exists = profiles.some(p => p.id === id)

  if (!exists) {
    errors.push(`方案不存在: ${id}`)
    return { success: false, errors, warnings, logs }
  }

  const prevDefault = data.default

  saveUndoSnapshot(`设置默认方案: ${id}`, profiles, prevDefault)

  data.default = id
  store.saveExportProfiles(data)

  logs.push(`已设置默认方案: ${id}`)
  if (prevDefault) logs.push(`原默认方案: ${prevDefault}`)

  writeLog({
    timestamp: new Date().toISOString(),
    action: 'set_default',
    profileId: id,
    previousDefault: prevDefault || null,
    success: true
  })

  return { success: true, errors, warnings, logs, profileId: id, previousDefault: prevDefault }
}

function createProfile(input, options) {
  options = options || {}
  const force = options.force === true

  const logs = []
  const warnings = []
  const errors = []

  const preNorm = normalizeProfile(input)

  const validation = validateProfile(preNorm)
  validation.errors.forEach(e => errors.push(e))
  validation.warnings.forEach(w => warnings.push(w))
  validation.info.forEach(i => logs.push(i))

  if (!validation.valid) {
    errors.push('方案字段校验失败')
    return { success: false, errors, warnings, logs }
  }

  const profile = preNorm

  const data = store.loadExportProfiles()
  const profiles = data.profiles

  const sameNameIdx = profiles.findIndex(p => p.name === profile.name)
  if (sameNameIdx >= 0) {
    if (!force) {
      errors.push(`已存在同名方案 "${profile.name}"，使用 force=true 可覆盖`)
      return {
        success: false,
        blocked: true,
        reason: 'duplicate_name',
        duplicateName: profile.name,
        existingProfileId: profiles[sameNameIdx].id,
        errors,
        warnings,
        logs
      }
    }
    warnings.push(`已存在同名方案 "${profile.name}"，将覆盖原有方案 (id: ${profiles[sameNameIdx].id})`)
  }

  saveUndoSnapshot(
    sameNameIdx >= 0 ? `覆盖方案: ${profile.name}` : `创建方案: ${profile.name}`,
    profiles,
    data.default
  )

  if (sameNameIdx >= 0) {
    profile.id = profiles[sameNameIdx].id
    profile.createdAt = profiles[sameNameIdx].createdAt
    profile.updatedAt = new Date().toISOString()
    if (data.default === profiles[sameNameIdx].id) {
      data.default = profile.id
    }
    profiles[sameNameIdx] = profile
  } else {
    if (profiles.length === 0) {
      data.default = profile.id
      logs.push('这是第一个方案，已自动设为默认')
    }
    profiles.push(profile)
  }

  store.saveExportProfiles(data)

  profile.isDefault = data.default === profile.id

  logs.push(`方案已保存: ${profile.name} (id: ${profile.id})`)

  writeLog({
    timestamp: new Date().toISOString(),
    action: sameNameIdx >= 0 ? 'update' : 'create',
    profileId: profile.id,
    profileName: profile.name,
    overwritten: sameNameIdx >= 0,
    success: true
  })

  return { success: true, profile, errors, warnings, logs, created: sameNameIdx < 0, overwritten: sameNameIdx >= 0 }
}

function updateProfile(id, updates, options) {
  options = options || {}
  const force = options.force === true

  const logs = []
  const warnings = []
  const errors = []

  const data = store.loadExportProfiles()
  const profiles = data.profiles
  const idx = profiles.findIndex(p => p.id === id)

  if (idx < 0) {
    errors.push(`方案不存在: ${id}`)
    return { success: false, errors, warnings, logs }
  }

  if (updates.name !== undefined && typeof updates.name === 'string') {
    const sameNameIdx = profiles.findIndex((p, i) => i !== idx && p.name === updates.name)
    if (sameNameIdx >= 0 && !force) {
      errors.push(`已存在同名方案 "${updates.name}"，使用 force=true 可覆盖`)
      return {
        success: false,
        blocked: true,
        reason: 'duplicate_name',
        duplicateName: updates.name,
        existingProfileId: profiles[sameNameIdx].id,
        errors,
        warnings,
        logs
      }
    }
  }

  const merged = { ...profiles[idx], ...updates }
  const validation = validateProfile(merged)
  validation.errors.forEach(e => errors.push(e))
  validation.warnings.forEach(w => warnings.push(w))
  if (!validation.valid) {
    errors.push('更新后的方案校验失败')
    return { success: false, errors, warnings, logs }
  }

  const normalized = normalizeProfile(merged)
  normalized.id = profiles[idx].id
  normalized.createdAt = profiles[idx].createdAt
  normalized.updatedAt = new Date().toISOString()

  saveUndoSnapshot(`更新方案: ${normalized.name}`, profiles, data.default)

  if (updates.name !== undefined && typeof updates.name === 'string') {
    const sameNameIdx = profiles.findIndex((p, i) => i !== idx && p.name === updates.name)
    if (sameNameIdx >= 0) {
      warnings.push(`覆盖同名方案 "${updates.name}" (id: ${profiles[sameNameIdx].id})`)
      if (data.default === profiles[sameNameIdx].id) {
        data.default = normalized.id
        warnings.push(`被覆盖的方案曾是默认方案，默认方案已切换为当前方案`)
      }
      profiles.splice(sameNameIdx, 1)
      if (sameNameIdx < idx) idx--
    }
  }

  profiles[idx] = normalized
  store.saveExportProfiles(data)

  normalized.isDefault = data.default === normalized.id

  logs.push(`方案已更新: ${normalized.name} (id: ${normalized.id})`)

  writeLog({
    timestamp: new Date().toISOString(),
    action: 'update',
    profileId: normalized.id,
    profileName: normalized.name,
    success: true
  })

  return { success: true, profile: normalized, errors, warnings, logs }
}

function deleteProfile(id) {
  const logs = []
  const warnings = []
  const errors = []

  const data = store.loadExportProfiles()
  const profiles = data.profiles
  const idx = profiles.findIndex(p => p.id === id)

  if (idx < 0) {
    errors.push(`方案不存在: ${id}`)
    return { success: false, errors, warnings, logs }
  }

  const profile = profiles[idx]
  const wasDefault = data.default === id
  const prevDefault = data.default

  saveUndoSnapshot(`删除方案: ${profile.name}`, profiles, data.default)

  profiles.splice(idx, 1)

  if (wasDefault) {
    if (profiles.length > 0) {
      data.default = profiles[0].id
      warnings.push(`已删除的方案是默认方案，已将 "${profiles[0].name}" 设为新的默认方案`)
    } else {
      data.default = null
      warnings.push(`已删除的方案是默认方案，当前已无默认方案`)
    }
  }

  store.saveExportProfiles(data)

  logs.push(`方案已删除: ${profile.name} (id: ${id})`)
  if (wasDefault) logs.push('被删除的方案是默认方案')

  writeLog({
    timestamp: new Date().toISOString(),
    action: 'delete',
    profileId: id,
    profileName: profile.name,
    wasDefault,
    newDefault: data.default,
    success: true
  })

  return {
    success: true,
    deleted: profile,
    wasDefault,
    newDefault: data.default,
    errors,
    warnings,
    logs
  }
}

function duplicateProfile(id, newName) {
  const logs = []
  const warnings = []
  const errors = []

  const data = store.loadExportProfiles()
  const profiles = data.profiles
  const source = profiles.find(p => p.id === id)

  if (!source) {
    errors.push(`源方案不存在: ${id}`)
    return { success: false, errors, warnings, logs }
  }

  if (newName) {
    const sameName = profiles.find(p => p.name === newName)
    if (sameName) {
      errors.push(`已存在同名方案 "${newName}"`)
      return { success: false, errors, warnings, logs }
    }
  }

  const name = newName || `${source.name} (副本)`
  const copy = normalizeProfile({
    ...JSON.parse(JSON.stringify(source)),
    name,
    id: null,
    createdAt: null,
    updatedAt: null
  })

  saveUndoSnapshot(`复制方案: ${source.name} → ${name}`, profiles, data.default)

  profiles.push(copy)
  store.saveExportProfiles(data)

  copy.isDefault = data.default === copy.id

  logs.push(`方案已复制: ${source.name} → ${name} (id: ${copy.id})`)

  writeLog({
    timestamp: new Date().toISOString(),
    action: 'duplicate',
    sourceProfileId: id,
    sourceProfileName: source.name,
    newProfileId: copy.id,
    newProfileName: copy.name,
    success: true
  })

  return { success: true, profile: copy, errors, warnings, logs }
}

function resolveOutputDir(profile) {
  if (profile && profile.outputDir && profile.outputDir.trim()) {
    return profile.outputDir.trim()
  }
  return path.join(store.DATA_DIR, '..', 'output')
}

function checkOutputWritable(dir) {
  const logs = []
  const warnings = []
  const errors = []

  if (!dir) {
    errors.push('输出目录未指定')
    return { writable: false, errors, warnings, logs }
  }

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const testFile = path.join(dir, `.write-test-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.tmp`)
    fs.writeFileSync(testFile, 'test', 'utf-8')
    fs.unlinkSync(testFile)
    logs.push(`输出目录可写: ${dir}`)
    return { writable: true, dir, errors, warnings, logs }
  } catch (e) {
    errors.push(`输出目录不可写: ${dir} (${e.message})`)
    return { writable: false, dir, errors, warnings, logs }
  }
}

function exportProfileToJson(id) {
  const profile = getProfile(id)
  if (!profile) {
    return { success: false, errors: [`方案不存在: ${id}`], warnings: [], logs: [] }
  }
  const snapshot = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: JSON.parse(JSON.stringify({
      name: profile.name,
      titleTemplate: profile.titleTemplate,
      groupOrder: profile.groupOrder,
      includeTicket: profile.includeTicket,
      includeAuthor: profile.includeAuthor,
      includeDate: profile.includeDate,
      outputDir: profile.outputDir,
      schemaVersion: profile.schemaVersion
    }))
  }
  return { success: true, data: snapshot }
}

function exportProfileToFile(id, outputPath) {
  const result = exportProfileToJson(id)
  if (!result.success) return result
  try {
    const dir = path.dirname(outputPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(outputPath, JSON.stringify(result.data, null, 2), 'utf-8')
    return { success: true, path: outputPath }
  } catch (e) {
    return { success: false, errors: [`写出文件失败: ${e.message}`], warnings: [], logs: [] }
  }
}

function importProfileFromJson(data, options) {
  options = options || {}
  const force = options.force === true
  const asName = options.asName || null

  const logs = []
  const warnings = []
  const errors = []

  if (!data || typeof data !== 'object') {
    errors.push('导入数据不是合法 JSON 对象')
    return { success: false, errors, warnings, logs }
  }

  let profileData
  if (data.profile) {
    if (data.schemaVersion !== undefined) {
      if (typeof data.schemaVersion !== 'number') {
        errors.push('schemaVersion 必须是数字')
      } else if (data.schemaVersion > PROFILE_SCHEMA_VERSION) {
        errors.push(`schemaVersion 过高 (${data.schemaVersion})，当前工具仅支持 v${PROFILE_SCHEMA_VERSION}`)
      } else if (data.schemaVersion < PROFILE_SCHEMA_VERSION) {
        warnings.push(`schemaVersion 较低 (${data.schemaVersion})，将尝试兼容导入`)
      }
    }
    profileData = data.profile
    logs.push('从标准导出格式导入')
  } else {
    profileData = data
    warnings.push('检测到非标准格式（旧方案 JSON），尝试直接导入')
  }

  if (asName) {
    profileData = { ...profileData, name: asName }
    logs.push(`使用导入时指定的方案名: ${asName}`)
  }

  const validation = validateProfile(profileData)
  validation.errors.forEach(e => errors.push(e))
  validation.warnings.forEach(w => warnings.push(w))
  validation.info.forEach(i => logs.push(i))

  if (!validation.valid) {
    errors.push('导入方案字段校验失败')
    return { success: false, errors, warnings, logs }
  }

  const createResult = createProfile(profileData, { force })
  createResult.errors = (errors || []).concat(createResult.errors || [])
  createResult.warnings = (warnings || []).concat(createResult.warnings || [])
  createResult.logs = (logs || []).concat(createResult.logs || [])
  return createResult
}

function importProfileFromFile(filePath, options) {
  options = options || {}
  const logs = []
  const warnings = []
  const errors = []

  if (!fs.existsSync(filePath)) {
    errors.push(`文件不存在: ${filePath}`)
    return { success: false, errors, warnings, logs }
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    logs.push(`已读取文件: ${filePath}`)
    return importProfileFromJson(data, options)
  } catch (e) {
    errors.push(`读取/解析文件失败: ${e.message}`)
    return { success: false, errors, warnings, logs }
  }
}

function undoLastChange() {
  const undoSnapshot = store.loadExportProfileUndo()
  const logs = []
  const warnings = []
  const errors = []

  if (!undoSnapshot) {
    errors.push('没有可撤销的方案操作')
    return { success: false, errors, warnings, logs, reason: 'no_undo_snapshot' }
  }

  const data = store.loadExportProfiles()
  const profilesBefore = data.profiles
  const defaultBefore = data.default

  try {
    store.saveExportProfiles({
      profiles: undoSnapshot.profiles,
      default: undoSnapshot.default
    })
    const verify = store.loadExportProfiles()
    if (!verify || !Array.isArray(verify.profiles)) {
      throw new Error('撤销后校验失败')
    }
  } catch (e) {
    errors.push(`撤销失败: ${e.message}`)
    try {
      store.saveExportProfiles({ profiles: profilesBefore, default: defaultBefore })
      logs.push('已自动回滚到撤销前状态')
    } catch (rbErr) {
      errors.push(`回滚失败！方案数据可能处于不一致状态: ${rbErr.message}`)
    }
    return { success: false, errors, warnings, logs }
  }

  logs.push(`已撤销: ${undoSnapshot.description} (操作时间: ${undoSnapshot.timestamp})`)

  writeLog({
    timestamp: new Date().toISOString(),
    action: 'undo',
    description: undoSnapshot.description,
    undoneAt: undoSnapshot.timestamp,
    success: true
  })

  try {
    store.clearExportProfileUndo()
  } catch (e) {
    warnings.push(`清除撤销快照失败: ${e.message}`)
  }

  return {
    success: true,
    description: undoSnapshot.description,
    timestamp: undoSnapshot.timestamp,
    errors,
    warnings,
    logs
  }
}

function peekUndo() {
  const snap = store.loadExportProfileUndo()
  if (!snap) return null
  return {
    description: snap.description,
    timestamp: snap.timestamp
  }
}

function listLogs(limit) {
  const logs = store.loadExportProfileLogs()
  const n = typeof limit === 'number' ? Math.min(limit, logs.length) : logs.length
  return logs.slice(logs.length - n).reverse()
}

module.exports = {
  getDefaultProfile,
  validateProfile,
  normalizeProfile,
  listProfiles,
  getProfile,
  getProfileByName,
  getDefaultProfileId,
  getDefaultProfileObj,
  setDefault,
  createProfile,
  updateProfile,
  deleteProfile,
  duplicateProfile,
  resolveOutputDir,
  checkOutputWritable,
  exportProfileToJson,
  exportProfileToFile,
  importProfileFromJson,
  importProfileFromFile,
  undoLastChange,
  peekUndo,
  listLogs,
  PROFILE_SCHEMA_VERSION,
  KNOWN_CATEGORIES,
  DEFAULT_GROUP_ORDER,
  CATEGORY_LABELS,
  REQUIRED_FIELDS
}
