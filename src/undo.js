const store = require('./store')

function push(actionType, description) {
  const stack = store.loadUndoStack()
  const commits = store.loadCommits()
  stack.push({
    type: actionType,
    description,
    timestamp: new Date().toISOString(),
    snapshot: JSON.parse(JSON.stringify(commits))
  })
  if (stack.length > 50) {
    stack.splice(0, stack.length - 50)
  }
  store.saveUndoStack(stack)
}

function pop() {
  const stack = store.loadUndoStack()
  if (stack.length === 0) {
    return { success: false, reason: '没有历史可撤销: 撤销栈为空' }
  }
  const entry = stack.pop()
  store.saveCommits(entry.snapshot)
  store.saveUndoStack(stack)
  return {
    success: true,
    action: entry.type,
    description: entry.description,
    timestamp: entry.timestamp
  }
}

function peek() {
  const stack = store.loadUndoStack()
  if (stack.length === 0) return null
  const top = stack[stack.length - 1]
  return {
    type: top.type,
    description: top.description,
    timestamp: top.timestamp
  }
}

function size() {
  return store.loadUndoStack().length
}

function clear() {
  store.saveUndoStack([])
}

module.exports = { push, pop, peek, size, clear }
