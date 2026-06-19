const store = require('./store')

function review(commitId, note) {
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  c.reviewed = true
  if (note !== undefined && note !== null) {
    c.note = note
  }
  store.saveCommits(commits)
  return c
}

function batchReview(commitIds, note) {
  const commits = store.loadCommits()
  commitIds.forEach(id => {
    const c = commits.find(x => x.id === id)
    if (c) {
      c.reviewed = true
      if (note !== undefined && note !== null) {
        c.note = note
      }
    }
  })
  store.saveCommits(commits)
  return commitIds.length
}

function unreview(commitId) {
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  c.reviewed = false
  store.saveCommits(commits)
  return c
}

function listByCategory(category) {
  const commits = store.loadCommits()
  return commits.filter(c => c.category === category && c.category !== 'ignored')
}

function listUnresolved() {
  const commits = store.loadCommits()
  return commits.filter(c => c.issues && c.issues.length > 0 && !c.resolved && c.category !== 'ignored')
}

function listUnreviewed() {
  const commits = store.loadCommits()
  return commits.filter(c => !c.reviewed && c.category !== 'ignored')
}

function setTicket(commitId, ticket) {
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  c.ticket = ticket
  c.issues = c.issues.filter(i => i !== '缺失工单号')
  if (c.issues.length === 0) c.resolved = true
  store.saveCommits(commits)
  return c
}

module.exports = { review, batchReview, unreview, listByCategory, listUnresolved, listUnreviewed, setTicket }
