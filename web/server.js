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

const WEB_DIR = path.join(__dirname)

function sendJson(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendError(res, message, status) {
  sendJson(res, { error: message }, status || 400)
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
      const md = exporter.generateMarkdown(body.version)
      return sendJson(res, { markdown: md })
    } catch (e) {
      return sendError(res, e.message)
    }
  }

  if (url.pathname === '/api/export/file' && method === 'POST') {
    const body = await parseBody(req)
    try {
      const fp = exporter.exportToFile(body.version, body.outputDir)
      return sendJson(res, { path: fp })
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

module.exports = function startServer(port) {
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

  server.listen(port, () => {
    console.log(`\x1b[32m发布说明工具 Web 界面已启动: http://localhost:${port}\x1b[0m`)
  })
}

if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 3000
  startServer(port)
}
