const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

// The canonical IDL lives at <repo>/idl, outside the project root.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../idl')]

// Cache transforms per project; the machine-wide Metro cache can serve stale transforms from other projects.
config.cacheStores = ({ FileStore }) => [
  new FileStore({ root: path.join(__dirname, 'node_modules', '.cache', 'metro') }),
]

module.exports = config
