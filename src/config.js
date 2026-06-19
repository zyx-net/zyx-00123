const store = require('./store')

function get() {
  return store.loadConfig()
}

function update(partial) {
  const config = get()
  const updated = { ...config, ...partial }
  if (partial.keywords) {
    updated.keywords = { ...config.keywords, ...partial.keywords }
  }
  store.saveConfig(updated)
  return updated
}

function reset() {
  store.saveConfig(null)
  return get()
}

function validateConfig(config) {
  const errors = []
  try { new RegExp(config.ticketPattern) } catch { errors.push('ticketPattern 不是合法正则') }
  try { new RegExp(config.versionPattern) } catch { errors.push('versionPattern 不是合法正则') }
  if (!Array.isArray(config.ignorePatterns)) {
    errors.push('ignorePatterns 必须是数组')
  } else {
    config.ignorePatterns.forEach((p, i) => {
      try { new RegExp(p) } catch { errors.push(`ignorePatterns[${i}] 不是合法正则`) }
    })
  }
  return errors
}

module.exports = { get, update, reset, validateConfig }
