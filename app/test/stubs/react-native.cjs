// test/stubs/react-native.cjs
//
// Stand-in for the `react-native` package under `node --test`. The real
// package's `index.js` is Flow-typed and cannot be parsed outside Metro, and
// nothing this suite exercises renders — the self-checks are pure functions
// that merely happen to live in files which also import <View>/<Text>.
//
// `universal` is a Proxy that answers every property access, call and
// construction with itself, so any RN reference evaluated at module load
// (`StyleSheet.create({...})`, `Platform.OS`, `Dimensions.get('window')`)
// resolves to a harmless value instead of throwing. It is NOT a mock of RN
// behaviour: a test that needs a real component or a real platform value
// must not rely on this file.
const universal = new Proxy(function universal() {}, {
  get(_target, key) {
    if (key === '__esModule') return false
    if (key === Symbol.toPrimitive) return () => ''
    if (key === 'then') return undefined // never look like a thenable
    return universal
  },
  apply() {
    return universal
  },
  construct() {
    return universal
  },
})
module.exports = universal
