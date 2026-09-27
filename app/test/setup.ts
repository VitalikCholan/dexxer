// test/setup.ts — preloaded by `npm test` (`node --import tsx --import ./test/setup.ts`).
//
// 1. `__DEV__`: React Native's global. `false` here so the `if (__DEV__)`
//    self-check blocks at the bottom of `src/lib/*.ts` stay silent — the
//    suite calls those `assert*SelfCheck` functions directly and lets them
//    THROW, which is the whole point: on-device they only `console.error`.
// 2. `react-native` and `expo-modules-core` → `stubs/react-native.cjs` (see that file's header).
//    Resolved through CommonJS `_resolveFilename` because tsx compiles this
//    package's `.ts` files as CJS (`package.json` has no `"type": "module"`),
//    so every `import ... from 'react-native'` in `src/` becomes a
//    `require('react-native')` at runtime.
import Module from 'node:module'
import path from 'node:path'

;(globalThis as { __DEV__?: boolean }).__DEV__ = false

const STUBS: Record<string, string> = {
  'react-native': path.join(__dirname, 'stubs', 'react-native.cjs'),
  // Base of every `expo-*` package; its `EventEmitter.ts` reads
  // `globalThis.expo.EventEmitter` at load, which only Expo's native runtime
  // provides. Same universal stub — nothing here needs a real native module.
  'expo-modules-core': path.join(__dirname, 'stubs', 'react-native.cjs'),
  // `Constants.js` JSON-parses the native manifest string at load; the
  // universal stub hands it `''` and it throws. Stubbed at the package level
  // so no `Constants.expoConfig` read ever reaches that code.
  'expo-constants': path.join(__dirname, 'stubs', 'react-native.cjs'),
  // `PlatformUtils.js` builds `new URL(<manifest base>)` at load off the
  // (stubbed) constants; a non-URL Proxy there throws `Invalid URL`.
  'expo-asset': path.join(__dirname, 'stubs', 'react-native.cjs'),
}

// Metro treats fonts/images as assets (`require('./X.ttf')` -> asset id);
// Node would try to execute the bytes as JavaScript. Each becomes a stub
// module exporting its own path — enough for `useFonts({ Name: require(..) })`
// tables to build at load.
const ASSET_EXTENSIONS = ['.ttf', '.otf', '.png', '.jpg', '.jpeg', '.gif', '.svg']
const extensions = (
  Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, filename: string) => void> }
)._extensions
for (const ext of ASSET_EXTENSIONS) {
  extensions[ext] = (m, filename) => {
    m.exports = filename
  }
}

type ResolveFilename = (request: string, ...rest: unknown[]) => string
const cjs = Module as unknown as { _resolveFilename: ResolveFilename }
const original = cjs._resolveFilename
cjs._resolveFilename = function (request: string, ...rest: unknown[]) {
  const stub = STUBS[request]
  if (stub) return stub
  return original.call(this, request, ...rest)
}
