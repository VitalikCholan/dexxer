import { IDENTITY_URI } from '@/src/lib/solana'

export class AppConfig {
  /** Week 6: the template's placeholder `'app'` — shown by wallets on authorize and as the SIWS statement's dApp name. */
  static name = 'Dexxer'
  // Fix round 2 (24.09.2026 live Phantom retest): this was still the
  // template placeholder `https://example.com` (visible in logcat's
  // `sign_in_payload: {"uri":"https://example.com"}`), mismatched against
  // the actual MWA identity uri (`components/app-providers.tsx`'s
  // `identity.uri`). SIWS's `uri`/`domain` should describe the same dApp
  // identity `authorize`/`reauthorize` already does.
  static uri = IDENTITY_URI
}
