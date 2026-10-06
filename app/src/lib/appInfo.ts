// app/src/lib/appInfo.ts
//
// What build a report comes from: app version (app.json), a build number and
// channel stamped at build time (`EXPO_PUBLIC_BUILD_NUMBER`,
// `EXPO_PUBLIC_BUILD_CHANNEL` — e.g. `beta`), platform, OS version and device
// model. Nothing here identifies the person.
import Constants from 'expo-constants'
import { Platform } from 'react-native'

export interface AppInfo {
  version: string
  build: string | null
  channel: string | null
  platform: string
  osVersion: string | null
  device: string | null
}

// Static reads: Metro inlines `process.env.EXPO_PUBLIC_*` only as member expressions.
const BUILD = process.env.EXPO_PUBLIC_BUILD_NUMBER
const CHANNEL = process.env.EXPO_PUBLIC_BUILD_CHANNEL

/** Pure: everything it needs is passed in, so it runs under `npm test`. */
export function appInfoFrom(src: {
  version: string | undefined
  build: string | undefined
  channel: string | undefined
  dev: boolean
  os: string
  osVersion: string | number | undefined
  brand?: string
  model?: string
}): AppInfo {
  const device = [src.brand, src.model]
    .filter((x) => x && x.trim())
    .join(' ')
    .trim()
  return {
    version: src.version || '0.0.0',
    build: src.build?.trim() || null,
    channel: src.channel?.trim() || (src.dev ? 'dev' : null),
    platform: src.os,
    osVersion: src.osVersion === undefined ? null : String(src.osVersion),
    device: device || null,
  }
}

export function appInfo(): AppInfo {
  const c = (Platform as unknown as { constants?: { Brand?: string; Model?: string; Manufacturer?: string } }).constants
  return appInfoFrom({
    version: Constants.expoConfig?.version,
    build: BUILD,
    channel: CHANNEL,
    dev: __DEV__,
    os: Platform.OS,
    osVersion: Platform.Version,
    brand: c?.Brand ?? c?.Manufacturer,
    model: c?.Model,
  })
}
