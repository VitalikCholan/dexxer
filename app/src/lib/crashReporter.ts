// app/src/lib/crashReporter.ts
//
// Closed beta: a JavaScript crash kills the app before anything could be
// sent, so the global error handler writes a pending crash report to
// AsyncStorage and the next launch sends it (`flushPendingCrash`), if the
// tester left "Send crash reports" on (Settings; on by default in beta
// builds, off switch stored in AsyncStorage). Non-fatal errors and unhandled
// promise rejections only go into the diagnostics log (`diagnostics.ts`).
//
// The crash report carries the error message and the top of the stack
// (scrubbed like every diagnostic), build/device info and the event log —
// the same privacy rules as a bug report (feedback.ts).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { appInfo } from './appInfo'
import { record, recentEvents, scrub } from './diagnostics'
import { buildReport, sendReport, type FeedbackBody } from './feedback'

const PENDING_KEY = 'dexxer.pendingCrash'
const CONSENT_KEY = 'dexxer.crashReports'
const MAX_STACK = 1500

export async function crashReportsEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(CONSENT_KEY)) !== 'off'
  } catch {
    return false
  }
}

export async function setCrashReportsEnabled(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(CONSENT_KEY, on ? 'on' : 'off')
  } catch {
    // Settings cannot persist: the toggle simply resets next launch.
  }
}

/** Pure: the report a crash turns into. */
export function crashReport(error: unknown, isFatal: boolean, screen: string | null): FeedbackBody {
  const e = error instanceof Error ? error : new Error(String(error))
  // V8/Hermes stacks repeat "Name: message" on their first line.
  const rawStack = (e.stack ?? '').split('\n')
  if (rawStack[0]?.startsWith(`${e.name}: `)) rawStack.shift()
  const stack = scrub(rawStack.join('\n').slice(0, MAX_STACK))
  const message = scrub(`${isFatal ? 'Fatal' : 'Non-fatal'} ${e.name}: ${e.message}\n\n${stack}`)
  return buildReport(
    { kind: 'crash', category: 'other', message, contact: '', includeDiagnostics: true, screen, market: null },
    appInfo(),
    recentEvents(),
  )
}

let lastScreen: string | null = null
/** The root layout keeps this current (the report screen itself excluded), so a report says where it happened. */
export function setCurrentScreen(screen: string): void {
  lastScreen = screen
}
export function currentScreen(): string | null {
  return lastScreen
}

let installed = false

interface ErrorUtilsLike {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void
}

export function installCrashReporter(): void {
  if (installed) return
  installed = true
  const eu = (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils
  if (eu) {
    const previous = eu.getGlobalHandler()
    eu.setGlobalHandler((error, isFatal) => {
      record(
        'error',
        'crash',
        `${isFatal ? 'fatal' : 'error'}: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (isFatal) {
        // Best effort: the process may die before this lands.
        void AsyncStorage.setItem(PENDING_KEY, JSON.stringify(crashReport(error, true, lastScreen))).catch(
          () => undefined,
        )
      }
      previous(error, isFatal)
    })
  }
  const hermes = (globalThis as unknown as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } })
    .HermesInternal
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id: number, rejection: unknown) => {
      record(
        'warn',
        'promise',
        `unhandled rejection: ${rejection instanceof Error ? rejection.message : String(rejection)}`,
      )
    },
  })
  record('info', 'app', 'start')
}

/** On launch: send a crash saved by the previous run, if the tester allows it. Kept for a later launch when the relayer is unreachable. */
export async function flushPendingCrash(
  send: (b: FeedbackBody) => Promise<number> = (b) => sendReport(b),
): Promise<number | null> {
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(PENDING_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  if (!(await crashReportsEnabled())) {
    await AsyncStorage.removeItem(PENDING_KEY).catch(() => undefined)
    return null
  }
  try {
    const id = await send(JSON.parse(raw) as FeedbackBody)
    await AsyncStorage.removeItem(PENDING_KEY).catch(() => undefined)
    record('info', 'crash', `previous crash sent as #${id}`)
    return id
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0
    // A 4xx means the relayer will never accept this body: drop it. Network/5xx: keep for next time.
    if (status >= 400 && status < 500 && status !== 429)
      await AsyncStorage.removeItem(PENDING_KEY).catch(() => undefined)
    return null
  }
}
