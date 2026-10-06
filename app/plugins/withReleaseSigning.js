// app/plugins/withReleaseSigning.js
//
// Closed beta: sign `assembleRelease` with the Dexxer release keystore instead
// of the template's debug key. `app/android` is prebuild output (gitignored),
// so the change lives here and is re-applied on every `expo prebuild`.
//
// The keystore and its passwords never enter the repo: Gradle reads them from
// the environment at build time (`scripts/build-release.sh` loads
// `keys/android/release-signing.env`). Without `DEXXER_RELEASE_STORE_FILE`
// the release build falls back to the debug key, exactly as before.
const { withAppBuildGradle } = require('@expo/config-plugins')

const MARKER = '// dexxer: release signing'

function apply(gradle) {
  if (gradle.includes(MARKER)) return gradle
  const withConfig = gradle.replace(
    /signingConfigs\s*\{\s*\n(\s*)debug\s*\{/,
    (m, indent) =>
      `signingConfigs {\n${indent}${MARKER}\n${indent}release {\n` +
      `${indent}    def f = System.getenv('DEXXER_RELEASE_STORE_FILE')\n` +
      `${indent}    if (f) {\n` +
      `${indent}        storeFile file(f)\n` +
      `${indent}        storePassword System.getenv('DEXXER_RELEASE_STORE_PASSWORD')\n` +
      `${indent}        keyAlias System.getenv('DEXXER_RELEASE_KEY_ALIAS')\n` +
      `${indent}        keyPassword System.getenv('DEXXER_RELEASE_KEY_PASSWORD')\n` +
      `${indent}    }\n` +
      `${indent}}\n${indent}debug {`,
  )
  const withRelease = withConfig.replace(
    /(release\s*\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/,
    `$1signingConfig System.getenv('DEXXER_RELEASE_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
  )
  if (withConfig === gradle || withRelease === withConfig) {
    throw new Error('withReleaseSigning: app/build.gradle no longer matches the expected template — update the plugin')
  }
  return withRelease
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = apply(c.modResults.contents)
    return c
  })
}
module.exports.apply = apply
