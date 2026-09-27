// test/config.test.ts — `resolveConfig` (`src/lib/config.ts`): the app's one
// network profile, devnet by default, each entry overridable through an
// `EXPO_PUBLIC_*` variable. Pure over an env object: Metro inlines only
// STATIC `process.env.EXPO_PUBLIC_X` reads, so the module captures those
// once and `resolveConfig` is a function of that captured object — which is
// what lets a test pass its own without touching module caches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEVNET, resolveConfig } from '../src/lib/config'

test('no overrides -> the devnet profile, with derived ws/identity fields', () => {
  const c = resolveConfig({})
  assert.equal(c.baseRpc, DEVNET.baseRpc)
  assert.equal(c.walletRpc, 'https://api.devnet.solana.com')
  assert.equal(c.teeRpc, 'https://devnet-tee.magicblock.app')
  assert.equal(c.teeWs, 'wss://devnet-tee.magicblock.app')
  assert.equal(c.erValidator, 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')
  assert.equal(c.lazerFeedId, '6')
  assert.equal(c.identityUri, new URL(c.relayerUrl).origin)
})

test('every entry is overridable; relayer trailing slash is trimmed and identity derives from it', () => {
  const c = resolveConfig({
    EXPO_PUBLIC_BASE_RPC: 'http://10.0.2.2:8899',
    EXPO_PUBLIC_WALLET_RPC: 'http://10.0.2.2:8899',
    EXPO_PUBLIC_TEE_RPC: 'https://tee.example',
    EXPO_PUBLIC_ER_VALIDATOR: '11111111111111111111111111111111',
    EXPO_PUBLIC_RELAYER_URL: 'http://localhost:8080/',
    EXPO_PUBLIC_LAZER_FEED_ID: '12',
  })
  assert.equal(c.baseRpc, 'http://10.0.2.2:8899')
  assert.equal(c.walletRpc, 'http://10.0.2.2:8899')
  assert.equal(c.teeRpc, 'https://tee.example')
  assert.equal(c.teeWs, 'wss://tee.example')
  assert.equal(c.erValidator, '11111111111111111111111111111111')
  assert.equal(c.relayerUrl, 'http://localhost:8080')
  assert.equal(c.identityUri, 'http://localhost:8080')
  assert.equal(c.lazerFeedId, '12')
})

test('an explicit identity URI wins over the relayer-derived one and loses its trailing slash', () => {
  const c = resolveConfig({ EXPO_PUBLIC_IDENTITY_URI: 'https://app.dexxer.example/' })
  assert.equal(c.identityUri, 'https://app.dexxer.example')
  assert.equal(c.identityDomain, 'app.dexxer.example')
})
