const http = require('http')
const fs = require('fs')
const path = require('path')

const store = require('../src/store')
const config = require('../src/config')
const importer = require('../src/importer')
const classifier = require('../src/classifier')
const validator = require('../src/validator')
const reviewer = require('../src/reviewer')
const undo = require('../src/undo')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const configBackup = require('../src/configBackup')
const exportProfile = require('../src/exportProfile')
const draft = require('../src/draft')
const versionRegistry = require('../src/versionRegistry')
const draftVault = require('../src/draftVault')
const operationAudit = require('../src/operationAudit')

const WEB_DIR = path.join(__dirname)

function sendJson(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendError(res, message, status) {
  sendJson(res, { error: message }, status || 400)
}

function _headerVal(raw) {
  if (!raw) return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

function route(method, pathname, handlers) {
  const handler = handlers[pathname]
  if (handler) return handler
  return null
}

async function handleApi(req, res, pathname) {
  const method = req.method.toUpperCase()
  const url = new URL(pathname, 'http://localhost')

  if (url.pathname === '/api/config' && method === 'GET') {
    return sendJson(res, config.get())
  }
  if (url.pathname === '/api/config' && method === 'PUT') {
    const body = await parseBody(req)
    const errors = config.validateConfig({ ...config.get(), ...body })
    if (errors.length > 0) return sendError(res, errors.join('; '))
    const updated = config.update(body)
    return sendJson(res, updated)
  }
  if (url.pathname === '/api/config/reset' && method === 'POST') {
    return sendJson(res, config.reset())
  }

  if (url.pathname === '/api/config/backup' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = configBackup.exportBackup(body.name)
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/config/backups' && method === 'GET') {
    return sendJson(res, configBackup.listBackups())
  }

  if (url.pathname === '/api/config/backups' && method === 'DELETE') {
    const body = await parseBody(req)
    if (!body.filename) return sendError(res, '缺少 filename 参数')
    return sendJson(res, configBackup.deleteBackup(body.filename))
  }

  if (url.pathname === '/api/config/restore' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      const opts = { force: body.force, dryRun: body.dryRun }
      if (Array.isArray(body.fields) && body.fields.length > 0) {
        opts.fields = body.fields
      }
      if (body.path) {
        result = configBackup.importBackupFromFile(body.path, opts)
      } else if (body.filename) {
        result = configBackup.importBackup(body.filename, opts)
      } else if (body.backupData) {
        const fs = require('fs')
        const os = require('os')
        const tmpFile = path.join(os.tmpdir(), `config-upload-${Date.now()}.json`)
        fs.writeFileSync(tmpFile, JSON.stringify(body.backupData), 'utf-8')
        result = configBackup.importBackupFromFile(tmpFile, opts)
        try { fs.unlinkSync(tmpFile) } catch {}
      } else {
        return sendError(res, '缺少 path, filename 或 backupData 参数')
      }
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/config/diff' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      if (body.path) {
        result = configBackup.diffBackupFromFile(body.path)
      } else if (body.filename) {
        const resolved = store.readBackupFile(body.filename)
        if (!resolved) return sendError(res, `备份不存在: ${body.filename}`, 404)
        result = configBackup.diffBackupFromFile(resolved.path)
      } else if (body.backupData) {
        result = { success: true, ...configBackup.diffBackup(body.backupData) }
      } else {
        return sendError(res, '缺少 path, filename 或 backupData 参数')
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/config/restore/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '10', 10)
    try {
      const logs = configBackup.listRestoreLogs(isNaN(n) ? 10 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/config/restore/undo' && method === 'POST') {
    const result = configBackup.undoLastRestore()
    if (!result.success && result.reason) {
      return sendError(res, result.reason, 400)
    }
    if (!result.success && result.errors.length > 0) {
      return sendError(res, result.errors.join('; '), 400)
    }
    return sendJson(res, result)
  }

  if (url.pathname === '/api/config/restore/peek' && method === 'GET') {
    return sendJson(res, configBackup.peekRestoreUndo())
  }

  if (url.pathname === '/api/config/validate' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.backupData) return sendError(res, '缺少 backupData 参数')
    const validation = configBackup.validateBackupStructure(body.backupData)
    return sendJson(res, validation)
  }

  if (url.pathname === '/api/commits' && method === 'GET') {
    const commits = store.loadCommits()
    const cat = url.searchParams.get('category')
    const list = cat ? commits.filter(c => c.category === cat) : commits
    return sendJson(res, list)
  }

  if (url.pathname === '/api/import/git' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = importer.importFromGit(body.dir || '.')
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/import/csv' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = importer.importFromCsv(body.file)
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/classify' && method === 'POST') {
    const result = classifier.classify()
    return sendJson(res, result)
  }

  if (url.pathname === '/api/validate' && method === 'GET') {
    const result = validator.validate()
    return sendJson(res, result)
  }

  if (url.pathname === '/api/commits/review' && method === 'POST') {
    const body = await parseBody(req)
    try {
      if (Array.isArray(body.ids)) {
        const count = reviewer.batchReview(body.ids, body.note)
        return sendJson(res, { count })
      }
      const c = reviewer.review(body.id, body.note)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/commits/unreview' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const c = reviewer.unreview(body.id)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/commits/category' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const c = classifier.setCategory(body.id, body.category)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/commits/version' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const c = classifier.setVersion(body.id, body.version)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/commits/ticket' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const c = reviewer.setTicket(body.id, body.ticket)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/commits/resolve' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const c = validator.resolveIssue(body.id, body.issueIndex)
      return sendJson(res, c)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/undo' && method === 'POST') {
    const result = undo.pop()
    return sendJson(res, result)
  }

  if (url.pathname === '/api/undo/peek' && method === 'GET') {
    return sendJson(res, undo.peek())
  }

  if (url.pathname === '/api/undo/size' && method === 'GET') {
    return sendJson(res, { size: undo.size() })
  }

  if (url.pathname === '/api/archives' && method === 'GET') {
    return sendJson(res, archiver.listArchives())
  }

  if (url.pathname === '/api/archive' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const snapshot = archiver.archive(body.version)
      return sendJson(res, snapshot)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/archive' && method === 'GET') {
    const version = url.searchParams.get('version')
    if (!version) return sendError(res, '缺少 version 参数')
    const snapshot = archiver.getArchive(version)
    if (!snapshot) return sendError(res, `归档不存在: ${version}`, 404)
    return sendJson(res, snapshot)
  }

  if (url.pathname === '/api/export' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const opts = {}
      if (body.profileId) opts.profileId = body.profileId
      if (body.profileName) opts.profileName = body.profileName
      if (body.profile) opts.profile = body.profile
      let profileObj = null
      if (body.profileId || body.profileName || body.profile) {
        profileObj = exporter.resolveProfile(opts)
      }
      const md = exporter.generateMarkdown(body.version, profileObj)
      return sendJson(res, { markdown: md, profileId: profileObj ? profileObj.id : null, profileName: profileObj ? profileObj.name : null })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/file' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const opts = {}
      if (body.profileId) opts.profileId = body.profileId
      if (body.profileName) opts.profileName = body.profileName
      if (body.profile) opts.profile = body.profile
      const result = exporter.exportToFile(body.version, body.outputDir, opts)
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles' && method === 'GET') {
    try {
      const profiles = exportProfile.listProfiles()
      return sendJson(res, { profiles })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = exportProfile.createProfile(body, { force: body.force })
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/default' && method === 'GET') {
    try {
      const profile = exportProfile.getDefaultProfileObj()
      return sendJson(res, { profile })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/default' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.id) return sendError(res, '缺少 id 参数')
    try {
      const result = exportProfile.setDefault(body.id)
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/export/profiles/') && method === 'GET') {
    const id = url.pathname.substring('/api/export/profiles/'.length)
    if (!id || id === 'default' || id === 'logs' || id === 'undo') {
    } else {
      try {
        const profile = exportProfile.getProfile(id)
        if (!profile) return sendError(res, `方案不存在: ${id}`, 404)
        return sendJson(res, { profile })
      } catch (e) {
        return sendError(res, e.message)
      }
    }
  }

  if (url.pathname.startsWith('/api/export/profiles/') && method === 'PUT') {
    const id = url.pathname.substring('/api/export/profiles/'.length)
    const body = await parseBody(req)
    try {
      const result = exportProfile.updateProfile(id, body, { force: body.force })
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/export/profiles/') && method === 'DELETE') {
    const id = url.pathname.substring('/api/export/profiles/'.length)
    try {
      const result = exportProfile.deleteProfile(id)
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/export/profiles/') && url.pathname.endsWith('/duplicate') && method === 'POST') {
    const id = url.pathname.substring('/api/export/profiles/'.length, url.pathname.length - '/duplicate'.length)
    const body = await parseBody(req)
    try {
      const result = exportProfile.duplicateProfile(id, body.newName)
      if (!result.success && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/export/profiles/') && url.pathname.endsWith('/export') && method === 'POST') {
    const id = url.pathname.substring('/api/export/profiles/'.length, url.pathname.length - '/export'.length)
    const body = await parseBody(req)
    try {
      if (body.outputPath) {
        const result = exportProfile.exportProfileToFile(id, body.outputPath)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
        return sendJson(res, result)
      } else {
        const result = exportProfile.exportProfileToJson(id)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
        return sendJson(res, result)
      }
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/import' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      const opts = { force: body.force }
      if (body.asName) opts.asName = body.asName
      if (body.path) {
        result = exportProfile.importProfileFromFile(body.path, opts)
      } else if (body.profileData) {
        result = exportProfile.importProfileFromJson(body.profileData, opts)
      } else {
        return sendError(res, '缺少 path 或 profileData 参数')
      }
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/validate' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.profileData) return sendError(res, '缺少 profileData 参数')
    const validation = exportProfile.validateProfile(body.profileData)
    return sendJson(res, validation)
  }

  if (url.pathname === '/api/export/profiles/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '20', 10)
    try {
      const logs = exportProfile.listLogs(isNaN(n) ? 20 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/undo' && method === 'POST') {
    try {
      const result = exportProfile.undoLastChange()
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/profiles/undo/peek' && method === 'GET') {
    try {
      return sendJson(res, exportProfile.peekUndo())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts' && method === 'GET') {
    try {
      const drafts = draft.listDrafts()
      return sendJson(res, { drafts })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = draft.createDraft({ ...body, _vaultSource: 'web' })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && method === 'GET') {
    const id = url.pathname.substring('/api/drafts/'.length)
    if (!id || id === 'logs' || id === 'undo') {
    } else {
      try {
        const d = draft.getDraft(id)
        if (!d) return sendError(res, `草稿不存在: ${id}`, 404)
        return sendJson(res, { draft: d })
      } catch (e) {
        return sendError(res, e.message)
      }
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && method === 'PUT') {
    const id = url.pathname.substring('/api/drafts/'.length)
    const body = await parseBody(req)
    try {
      const result = draft.updateDraft(id, body, { force: body.force, _vaultSource: 'web' })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && method === 'DELETE') {
    const id = url.pathname.substring('/api/drafts/'.length)
    try {
      const result = draft.deleteDraft(id)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && url.pathname.endsWith('/duplicate') && method === 'POST') {
    const id = url.pathname.substring('/api/drafts/'.length, url.pathname.length - '/duplicate'.length)
    const body = await parseBody(req)
    try {
      const opts = { _vaultSource: 'web' }
      if (body.resolve) opts.resolve = body.resolve
      const result = draft.duplicateDraft(id, body.newName, opts)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && url.pathname.endsWith('/apply') && method === 'POST') {
    const id = url.pathname.substring('/api/drafts/'.length, url.pathname.length - '/apply'.length)
    const body = await parseBody(req)
    try {
      const auditContext = {
        entry: operationAudit.ENTRY_WEB,
        userId: body.userId || _headerVal(req.headers['x-user-id']) || null,
        userName: body.userName || _headerVal(req.headers['x-user-name']) || null,
        sessionId: body.sessionId || _headerVal(req.headers['x-session-id']) || null,
        requestId: body.requestId || null
      }
      if (!auditContext.userId) {
        return sendError(res, '审计拦截: 必须提供 userId (通过 body.userId 或 X-User-Id 头)', 403)
      }
      const result = draft.applyDraft(id, { _auditContext: auditContext })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && url.pathname.endsWith('/archive') && method === 'POST') {
    const id = url.pathname.substring('/api/drafts/'.length, url.pathname.length - '/archive'.length)
    const body = await parseBody(req)
    try {
      const auditContext = {
        entry: operationAudit.ENTRY_WEB,
        userId: body.userId || _headerVal(req.headers['x-user-id']) || null,
        userName: body.userName || _headerVal(req.headers['x-user-name']) || null,
        sessionId: body.sessionId || _headerVal(req.headers['x-session-id']) || null,
        requestId: body.requestId || null
      }
      if (!auditContext.userId) {
        return sendError(res, '审计拦截: 必须提供 userId (通过 body.userId 或 X-User-Id 头)', 403)
      }
      const opts = { _auditContext: auditContext, _vaultSource: 'web' }
      if (body.userId) opts.userId = body.userId
      if (body.userName) opts.userName = body.userName
      const result = draft.archiveDraft(id, opts)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/drafts/') && url.pathname.endsWith('/export') && method === 'POST') {
    const id = url.pathname.substring('/api/drafts/'.length, url.pathname.length - '/export'.length)
    const body = await parseBody(req)
    try {
      if (body.outputPath) {
        const result = draft.exportDraftToFile(id, body.outputPath)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
        return sendJson(res, result)
      } else {
        const result = draft.exportDraftToJson(id)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
        return sendJson(res, result)
      }
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/compare' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = draft.compareDrafts(body.id1, body.id2)
      if (!result.success && result.errors) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/import' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const auditContext = {
        entry: operationAudit.ENTRY_WEB,
        userId: body.userId || _headerVal(req.headers['x-user-id']) || null,
        userName: body.userName || _headerVal(req.headers['x-user-name']) || null,
        sessionId: body.sessionId || _headerVal(req.headers['x-session-id']) || null,
        requestId: body.requestId || null
      }
      if (!auditContext.userId) {
        return sendError(res, '审计拦截: 必须提供 userId (通过 body.userId 或 X-User-Id 头)', 403)
      }
      let result
      const opts = { force: body.force, _vaultSource: 'web', _auditContext: auditContext }
      if (body.asName) opts.asName = body.asName
      if (body.userId) opts.userId = body.userId
      if (body.userName) opts.userName = body.userName
      if (body.path) {
        result = draft.importDraftFromFile(body.path, opts)
      } else if (body.draftData) {
        result = draft.importDraftFromJson(body.draftData, opts)
      } else {
        return sendError(res, '缺少 path 或 draftData 参数')
      }
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '20', 10)
    try {
      const logs = draft.listLogs(isNaN(n) ? 20 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/undo' && method === 'POST') {
    try {
      const result = draft.undoLastChange()
      if (!result.success && result.reason) {
        return sendError(res, result.reason, 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/undo/peek' && method === 'GET') {
    try {
      return sendJson(res, draft.peekUndo())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/undo/size' && method === 'GET') {
    try {
      return sendJson(res, { size: draft.undoStackSize() })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/undo/stack' && method === 'GET') {
    try {
      return sendJson(res, { stack: draft.peekUndoStack() })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/drafts/reconcile' && method === 'POST') {
    try {
      draft.reconcileRegistry()
      return sendJson(res, { success: true })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry' && method === 'GET') {
    try {
      const opts = {}
      const version = url.searchParams.get('version')
      const status = url.searchParams.get('status')
      const userId = url.searchParams.get('userId')
      const draftId = url.searchParams.get('draftId')
      if (version) opts.version = version
      if (status) opts.status = status
      if (userId) opts.userId = userId
      if (draftId) opts.draftId = draftId
      const entries = versionRegistry.listEntries(opts)
      return sendJson(res, { entries })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/version-registry/') && method === 'GET') {
    const version = decodeURIComponent(url.pathname.substring('/api/version-registry/'.length))
    if (version === 'logs') {
    } else if (version === 'undo') {
    } else if (version === 'export') {
    } else if (version === 'reconcile') {
    } else {
      try {
        const entry = versionRegistry.getEntry(version)
        return sendJson(res, { entry })
      } catch (e) {
        return sendError(res, e.message)
      }
    }
  }

  if (url.pathname === '/api/version-registry/check' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.version) return sendError(res, '缺少 version 参数')
    try {
      const result = versionRegistry.checkAvailability(body.version, {
        userId: body.userId,
        userName: body.userName
      })
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/occupy' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.version) return sendError(res, '缺少 version 参数')
    try {
      const opts = {
        isAdmin: !!body.isAdmin,
        userId: body.userId,
        userName: body.userName,
        sourceAction: body.sourceAction,
        draftId: body.draftId,
        draftName: body.draftName,
        takeoverReason: body.takeoverReason
      }
      const result = versionRegistry.occupyVersion(body.version, opts)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/preoccupy' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.version) return sendError(res, '缺少 version 参数')
    try {
      const result = versionRegistry.preoccupyVersion(body.version, {
        userId: body.userId,
        userName: body.userName,
        draftName: body.draftName
      })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/release' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.version) return sendError(res, '缺少 version 参数')
    try {
      const result = versionRegistry.releaseVersion(body.version, {
        isAdmin: !!body.isAdmin,
        userId: body.userId,
        userName: body.userName,
        reason: body.reason
      })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/takeover' && method === 'POST') {
    const body = await parseBody(req)
    if (!body.version) return sendError(res, '缺少 version 参数')
    if (!body.reason) return sendError(res, '必须指定接管理由 reason')
    try {
      const result = versionRegistry.takeoverVersion(body.version, {
        isAdmin: true,
        userId: body.userId,
        userName: body.userName,
        draftId: body.draftId,
        draftName: body.draftName,
        reason: body.reason
      })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), result.blocked ? 409 : 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '50', 10)
    try {
      const logs = versionRegistry.listLogs(isNaN(n) ? 50 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/undo' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = versionRegistry.undoLastChange({
        userId: body && body.userId,
        userName: body && body.userName
      })
      if (!result.success && result.reason) {
        return sendError(res, result.reason, 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/undo/peek' && method === 'GET') {
    try {
      return sendJson(res, versionRegistry.peekUndo())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/export' && method === 'POST') {
    const body = await parseBody(req)
    try {
      if (body.outputPath) {
        const result = versionRegistry.exportRegistryToFile(body.outputPath)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
        return sendJson(res, result)
      } else {
        const result = versionRegistry.exportRegistryToJson()
        return sendJson(res, result)
      }
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/import' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      const opts = {
        force: !!body.force,
        userId: body.userId,
        userName: body.userName
      }
      if (body.path) {
        result = versionRegistry.importRegistryFromFile(body.path, opts)
      } else if (body.registryData) {
        result = versionRegistry.importRegistryFromJson(body.registryData, opts)
      } else {
        return sendError(res, '缺少 path 或 registryData 参数')
      }
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/version-registry/reconcile' && method === 'POST') {
    try {
      const drafts = draft.listDrafts()
      const result = versionRegistry.reconcileWithDrafts(drafts)
      return sendJson(res, { success: true, ...result })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/unresolved' && method === 'GET') {
    return sendJson(res, reviewer.listUnresolved())
  }

  if (url.pathname === '/api/unreviewed' && method === 'GET') {
    return sendJson(res, reviewer.listUnreviewed())
  }

  if (url.pathname === '/api/vault/status' && method === 'GET') {
    try {
      return sendJson(res, draftVault.getStatus())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/snapshots' && method === 'GET') {
    try {
      const options = {}
      const draftId = url.searchParams.get('draftId')
      const action = url.searchParams.get('action')
      const status = url.searchParams.get('status')
      const source = url.searchParams.get('source')
      const operator = url.searchParams.get('operator')
      if (draftId) options.draftId = draftId
      if (action) options.action = action
      if (status) options.status = status
      if (source) options.source = source
      if (operator) options.operator = operator
      return sendJson(res, { snapshots: draftVault.listSnapshots(options) })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/vault/snapshots/') && url.pathname.endsWith('/commit') && method === 'POST') {
    const id = url.pathname.substring('/api/vault/snapshots/'.length, url.pathname.length - '/commit'.length)
    try {
      const result = draftVault.commitSnapshot(id)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/vault/snapshots/') && url.pathname.endsWith('/recover') && method === 'POST') {
    const id = url.pathname.substring('/api/vault/snapshots/'.length, url.pathname.length - '/recover'.length)
    const body = await parseBody(req)
    try {
      const result = draftVault.recoverFromSnapshot(id, { conflictResolution: body.conflictResolution })
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/vault/snapshots/') && url.pathname.endsWith('/rollback') && method === 'POST') {
    const id = url.pathname.substring('/api/vault/snapshots/'.length, url.pathname.length - '/rollback'.length)
    const body = await parseBody(req)
    try {
      const result = draftVault.rollbackSnapshot(id, body)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/vault/snapshots/') && method === 'GET') {
    const id = url.pathname.substring('/api/vault/snapshots/'.length)
    try {
      const snapshot = draftVault.getSnapshot(id)
      if (!snapshot) return sendError(res, `快照不存在: ${id}`, 404)
      return sendJson(res, { snapshot })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/vault/snapshots/') && method === 'DELETE') {
    const id = url.pathname.substring('/api/vault/snapshots/'.length)
    try {
      const result = draftVault.archiveSnapshot(id)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/pending' && method === 'GET') {
    try {
      return sendJson(res, { pending: draftVault.findPendingTxns() })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/recover-pending' && method === 'POST') {
    try {
      const result = draftVault.recoverPendingTxns()
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/undo-recovery' && method === 'POST') {
    try {
      const result = draftVault.undoLastRecovery()
      if (!result.success && result.reason) {
        return sendError(res, result.reason, 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/undo-recovery/peek' && method === 'GET') {
    try {
      return sendJson(res, draftVault.peekRecoveryUndo())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/resolve-conflict' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const result = draftVault.resolveConflict(body.snapshotId, body.resolution, body)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/export' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      if (body.outputPath) {
        result = draftVault.exportVaultToFile(body.outputPath, body)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
      } else {
        result = draftVault.exportVaultToJson(body)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/import' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      const opts = { force: body.force }
      if (body.path) {
        result = draftVault.importVaultFromFile(body.path, opts)
      } else if (body.vaultData) {
        result = draftVault.importVaultFromJson(body.vaultData, opts)
      } else {
        return sendError(res, '缺少 path 或 vaultData 参数')
      }
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/vault/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '50', 10)
    try {
      const logs = draftVault.listLogs(isNaN(n) ? 50 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/status' && method === 'GET') {
    try {
      return sendJson(res, operationAudit.getStatus())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/records' && method === 'GET') {
    try {
      const options = {}
      const action = url.searchParams.get('action')
      const entry = url.searchParams.get('entry')
      const userId = url.searchParams.get('userId')
      const status = url.searchParams.get('status')
      const targetKey = url.searchParams.get('targetKey')
      if (action) options.action = action
      if (entry) options.entry = entry
      if (userId) options.userId = userId
      if (status) options.status = status
      if (targetKey) options.targetKey = targetKey
      return sendJson(res, { records: operationAudit.listRecords(options) })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/audit/records/') && method === 'GET') {
    const recordId = url.pathname.substring('/api/audit/records/'.length)
    try {
      const record = operationAudit.getRecord(recordId)
      if (!record) return sendError(res, `审计记录不存在: ${recordId}`, 404)
      return sendJson(res, { record })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname.startsWith('/api/audit/records/') && url.pathname.endsWith('/rollback') && method === 'POST') {
    const recordId = url.pathname.substring('/api/audit/records/'.length, url.pathname.length - '/rollback'.length)
    const body = await parseBody(req)
    try {
      const context = body ? {
        entry: operationAudit.ENTRY_WEB,
        userId: body.userId || null,
        userName: body.userName || null
      } : null
      const result = operationAudit.rollbackOperation(recordId, context)
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/pending' && method === 'GET') {
    try {
      return sendJson(res, { pending: operationAudit.getPendingOperations() })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/recover-pending' && method === 'POST') {
    try {
      const result = operationAudit.recoverPendingOperations()
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/undo' && method === 'POST') {
    try {
      const result = operationAudit.undoLastRecoveryOrRollback()
      if (!result.success && result.reason) {
        return sendError(res, result.reason, 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/undo/peek' && method === 'GET') {
    try {
      return sendJson(res, operationAudit.peekUndo())
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/locks' && method === 'GET') {
    try {
      return sendJson(res, { locks: operationAudit.getLockTable() })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/export' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      if (body && body.outputPath) {
        result = operationAudit.exportAuditToFile(body.outputPath, body)
        if (!result.success && result.errors) {
          return sendError(res, result.errors.join('; '), 400)
        }
      } else {
        result = operationAudit.exportAuditToJson(body)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/import' && method === 'POST') {
    const body = await parseBody(req)
    try {
      let result
      const opts = { force: body && body.force }
      if (body && body.path) {
        result = operationAudit.importAuditFromFile(body.path, opts)
      } else if (body && body.auditData) {
        result = operationAudit.importAuditFromJson(body.auditData, opts)
      } else {
        return sendError(res, '缺少 path 或 auditData 参数')
      }
      if (!result.success && result.errors && result.errors.length > 0) {
        return sendError(res, result.errors.join('; '), 400)
      }
      return sendJson(res, result)
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/audit/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('limit') || '50', 10)
    try {
      const logs = operationAudit.listLogs(isNaN(n) ? 50 : n)
      return sendJson(res, { logs })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  sendError(res, `未找到接口: ${method} ${url.pathname}`, 404)
}

function serveStatic(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  res.writeHead(200, { 'Content-Type': contentType })
  fs.createReadStream(filePath).pipe(res)
}

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, req.url)
    }

    let filePath
    if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = path.join(WEB_DIR, 'index.html')
      serveStatic(res, filePath, 'text/html; charset=utf-8')
    } else if (url.pathname === '/style.css') {
      filePath = path.join(WEB_DIR, 'style.css')
      serveStatic(res, filePath, 'text/css; charset=utf-8')
    } else if (url.pathname === '/app.js') {
      filePath = path.join(WEB_DIR, 'app.js')
      serveStatic(res, filePath, 'application/javascript; charset=utf-8')
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })

  console.log('\x1b[36m正在执行版本注册表一致性检查...\x1b[0m')
  const reconcileResult = versionRegistry.reconcileWithDrafts()
  if (reconcileResult.fixes && reconcileResult.fixes.length > 0) {
    console.log(`\x1b[33m版本注册表一致性修复完成，共修复 ${reconcileResult.fixes.length} 处问题:\x1b[0m`)
    reconcileResult.fixes.forEach((fix, i) => {
      console.log(`  ${i + 1}. [${fix.type}] ${fix.description}${fix.version ? ' (版本: ' + fix.version + ')' : ''}`)
    })
  } else if (reconcileResult.ok) {
    console.log('\x1b[32m版本注册表一致性检查通过，无需修复\x1b[0m')
  }

  const vaultPending = draftVault.findPendingTxns()
  if (vaultPending.length > 0) {
    console.log('\x1b[33m草稿恢复保险箱发现未完成事务，正在自动恢复...\x1b[0m')
    const vaultResult = draftVault.recoverPendingTxns()
    if (vaultResult.recovered > 0) {
      console.log(`\x1b[32m草稿恢复保险箱自动恢复完成: ${vaultResult.recovered}/${vaultResult.total} 条事务已恢复\x1b[0m`)
    }
  }

  const auditPending = operationAudit.getPendingOperations()
  if (auditPending.length > 0) {
    console.log('\x1b[33m操作来源审计发现未完成操作，正在自动恢复...\x1b[0m')
    const auditResult = operationAudit.recoverPendingOperations()
    if (auditResult.recovered > 0) {
      console.log(`\x1b[32m操作来源审计自动恢复完成: ${auditResult.recovered}/${auditResult.total} 条操作已恢复\x1b[0m`)
    }
  }

  server.listen(port, () => {
    console.log(`\x1b[32m发布说明工具 Web 界面已启动: http://localhost:${port}\x1b[0m`)
  })
}

module.exports = startServer
module.exports.startServer = startServer
module.exports.handleApi = handleApi

if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 3000
  startServer(port)
}
