import { install } from 'react-native-quick-crypto'
import { Buffer } from 'buffer'

install()

// react-native-quick-crypto's `install()` replaces `global.Buffer` with its
// own native/JSI-backed shim (`@craftzdog/react-native-buffer`), which
// doesn't implement the full Node Buffer API. Re-assigning `global.Buffer`
// to the full `buffer` package (already a transitive dependency, pinned
// explicitly in package.json) after `install()` restores that everywhere
// code reads `global.Buffer` — quick-crypto's own crypto APIs don't depend
// on which Buffer implementation is global, so this doesn't affect them.
//
// Found via task-7 emulator verification (fakewallet + real devnet): without
// this, `Connection.getAccountInfo(...).data` lacked `readUIntLE`/etc.
// Note this does NOT fix everything — `@coral-xyz/anchor`'s prebuilt
// `dist/browser/index.js` closes over its own internal buffer reference at
// bundle-build time, independent of `global.Buffer`, so
// `Program.account.<x>.fetch()` still throws inside `buffer-layout`'s
// `UInt#decode` even with this fix in place. `app/src/lib/program.ts`
// works around that separately (manual fixed-offset reads off the raw
// buffer, which *is* fixed by this file) — see its header comment.
global.Buffer = Buffer
