// test/feedback.test.ts — closed beta: the diagnostics scrubber and ring
// buffer, build info, the report body (exactly what the preview shows), the
// POST to /feedback, and the crash report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_EVENTS, clearEvents, recentEvents, record, scrub, toastLogLine } from '../src/lib/diagnostics'
import { appInfoFrom } from '../src/lib/appInfo'
import { FeedbackError, buildReport, sendReport, validateDraft, type ReportDraft } from '../src/lib/feedback'
import { afterSave, crashReport } from '../src/lib/crashReporter'

test('scrub masks amounts, prices, raw integers, keys, tokens and queries; keeps error codes and statuses', () => {
  const key = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  assert.equal(scrub('Opened Long 0.1 SOL at $150.25'), 'Opened Long #.# SOL at $#')
  assert.equal(scrub('size 1500000000 margin 20000000'), 'size # margin #')
  assert.equal(scrub(`owner ${key} sig ${key}${key.slice(0, 20)}`), 'owner <7xKX…> sig <7xKX…>')
  assert.equal(scrub('slippage exceeded (6015)'), 'slippage exceeded (6015)')
  assert.equal(scrub('/mark: HTTP 429'), '/mark: HTTP 429')
  assert.equal(scrub('auth Bearer abc.def-123'), 'auth Bearer <redacted>')
  assert.equal(
    scrub('GET https://relayer.example/prices?market=BTC&tf=1m failed'),
    'GET https://relayer.example/prices?<query> failed',
  )
  assert.ok(scrub('x'.repeat(2000)).length <= 500)
})

test('scrub masks every number, small integers included; only "(NNNN)" codes and "HTTP NNN" survive', () => {
  assert.equal(scrub('need 250 dUSDC free margin'), 'need # dUSDC free margin')
  assert.equal(scrub('leverage 5x, size 3'), 'leverage #x, size #')
  assert.equal(scrub('250dUSDC at -12'), '#dUSDC at -#')
  assert.equal(scrub('amount (250) too small (6015)'), 'amount (#) too small (6015)')
  assert.equal(scrub('HTTP 4290 HTTP 503'), 'HTTP # HTTP 503')
  assert.equal(scrub('/screen2 /info/42'), '/screen2 /info/#')
})

test('toastLogLine keeps the error code and HTTP status of a toast, never its text', () => {
  assert.equal(toastLogLine('Position opened, but TakeProfit was not set: Slippage exceeded (6015)'), '(6015)')
  assert.equal(toastLogLine('Not enough free margin: need 250 dUSDC'), 'no code')
  assert.equal(toastLogLine('/prices: HTTP 429'), 'HTTP 429')
  assert.equal(toastLogLine('Opened Long 0.1 SOL'), 'no code')
})

test('record keeps the newest events, scrubbed, oldest first', () => {
  clearEvents()
  for (let i = 0; i < MAX_EVENTS + 5; i++) record('info', 'nav', `/screen${i % 3} 2.5`, 1000 + i)
  const ev = recentEvents()
  assert.equal(ev.length, MAX_EVENTS)
  assert.equal(ev[0].t, 1005)
  assert.equal(ev[ev.length - 1].msg, `/screen${(MAX_EVENTS + 4) % 3} #.#`)
  ev.pop()
  assert.equal(recentEvents().length, MAX_EVENTS, 'a copy is returned')
  clearEvents()
  assert.equal(recentEvents().length, 0)
})

test('appInfoFrom: version, build, channel (dev default), device', () => {
  assert.deepEqual(
    appInfoFrom({
      version: '1.2.0',
      build: ' 14 ',
      channel: 'beta',
      dev: false,
      os: 'android',
      osVersion: 34,
      brand: 'Solana',
      model: 'Seeker',
    }),
    { version: '1.2.0', build: '14', channel: 'beta', platform: 'android', osVersion: '34', device: 'Solana Seeker' },
  )
  const dev = appInfoFrom({
    version: undefined,
    build: undefined,
    channel: undefined,
    dev: true,
    os: 'android',
    osVersion: undefined,
  })
  assert.deepEqual(dev, {
    version: '0.0.0',
    build: null,
    channel: 'dev',
    platform: 'android',
    osVersion: null,
    device: null,
  })
  assert.equal(
    appInfoFrom({ version: '1', build: '', channel: '', dev: false, os: 'ios', osVersion: '17' }).channel,
    null,
  )
})

const APP = { version: '1.0.0', build: '7', channel: 'beta', platform: 'android', osVersion: '14', device: 'Pixel 7' }
const draft: ReportDraft = {
  kind: 'bug',
  category: 'trading',
  message: '  Close does nothing  ',
  contact: ' @me ',
  includeDiagnostics: true,
  screen: '/positions',
  market: 'BTC',
}

test('validateDraft', () => {
  assert.equal(validateDraft({ message: 'ok', contact: '' }), null)
  assert.ok(validateDraft({ message: '   ', contact: '' }))
  assert.ok(validateDraft({ message: 'x'.repeat(4001), contact: '' }))
  assert.ok(validateDraft({ message: 'ok', contact: 'x'.repeat(201) }))
})

test('buildReport: trims, and leaves out screen, market and events without diagnostics', () => {
  const events = [{ t: 1, level: 'error' as const, tag: 'toast', msg: 'boom' }]
  const full = buildReport(draft, APP, events)
  assert.equal(full.message, 'Close does nothing')
  assert.equal(full.contact, '@me')
  assert.deepEqual(full.context, { screen: '/positions', market: 'BTC' })
  assert.equal(full.events.length, 1)
  const bare = buildReport({ ...draft, includeDiagnostics: false, contact: '' }, APP, events)
  assert.deepEqual(bare.context, { screen: null, market: null })
  assert.deepEqual(bare.events, [])
  assert.equal(bare.contact, null)
  assert.deepEqual(bare.app, APP, 'build info is always sent')
  // Nothing about the trader's account is ever in the body.
  const keys = JSON.stringify(full)
  for (const k of ['owner', 'position', 'balance', 'margin', 'session']) assert.ok(!keys.includes(`"${k}`), k)
})

test('sendReport posts JSON with the given headers and returns the id; maps 429 and errors', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ id: 42 }), { status: 201 })
  }) as typeof fetch
  const body = buildReport(draft, APP, [])
  assert.equal(await sendReport(body, { authorization: 'Bearer t' }, ok), 42)
  assert.match(calls[0].url, /\/feedback$/)
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer t')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), body)

  const limited = (async () => new Response('{}', { status: 429 })) as typeof fetch
  await assert.rejects(
    () => sendReport(body, {}, limited),
    (e) => e instanceof FeedbackError && e.status === 429,
  )
  const bad = (async () =>
    new Response(JSON.stringify({ error: 'message is required' }), { status: 400 })) as typeof fetch
  await assert.rejects(() => sendReport(body, {}, bad), /message is required/)
  const down = (async () => {
    throw new Error('Network request failed')
  }) as typeof fetch
  await assert.rejects(
    () => sendReport(body, {}, down),
    (e) => e instanceof FeedbackError && e.status === 0,
  )
})

test('afterSave: hands over after the save settles, or on a timeout, exactly once', async () => {
  const run = (save: () => Promise<unknown>, timeoutMs: number) =>
    new Promise<string[]>((done) => {
      const calls: string[] = []
      afterSave(
        () => save().then(() => calls.push('saved')),
        () => {
          calls.push('then')
          done(calls)
        },
        timeoutMs,
      )
    })
  assert.deepEqual(await run(async () => undefined, 1000), ['saved', 'then'], 'waits for the write')
  assert.deepEqual(
    await run(() => Promise.reject(new Error('disk full')), 1000),
    ['then'],
    'a failed write still hands over',
  )
  assert.deepEqual(
    await run(() => {
      throw new Error('cannot serialize')
    }, 1000),
    ['then'],
    'so does a save that throws',
  )
  const t0 = Date.now()
  assert.deepEqual(await run(() => new Promise(() => undefined), 30), ['then'], 'a hung write is cut off')
  assert.ok(Date.now() - t0 >= 25)

  let handed = 0
  afterSave(
    () => new Promise((r) => setTimeout(r, 40)),
    () => handed++,
    10,
  )
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(handed, 1, 'a write that lands after the timeout does not hand over again')
})

test('crashReport: a scrubbed crash report with the screen and the event log', () => {
  clearEvents()
  record('error', 'toast', 'slippage exceeded (6015)')
  const r = crashReport(new TypeError('cannot read size of 1.25 undefined'), true, '/trade')
  assert.equal(r.kind, 'crash')
  assert.match(r.message, /^Fatal TypeError: cannot read size of #\.# undefined\n\n/)
  assert.equal(
    r.message.split('\n').filter((l) => l.startsWith('TypeError:')).length,
    0,
    'the stack does not repeat the message',
  )
  assert.equal(r.context.screen, '/trade')
  assert.deepEqual(
    r.events.map((e) => e.msg),
    ['slippage exceeded (6015)'],
  )
  clearEvents()
})
