// app/scripts/gen-tokens.ts
//
// Reads docs/design/tokens.json (source of truth for the Claude Design
// palette/type/spacing scale) and writes app/src/theme/tokens.ts — typed TS
// constants consumed by app/src/theme/index.ts and app/src/ui/*. Deterministic:
// same input JSON always produces the same output bytes (plain JSON.stringify,
// no timestamps/randomness), so the generated file's diff only moves when
// tokens.json actually changes.
//
// Run: npm run gen:tokens (from app/), or `tsx scripts/gen-tokens.ts`.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import prettier from 'prettier'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const sourcePath = path.join(repoRoot, 'docs/design/tokens.json')
const outPath = path.join(here, '../src/theme/tokens.ts')

interface TokensJson {
  color: Record<string, string>
  font: {
    sans: string
    mono: string
    numeric: { fontFamily: string; fontVariantNumeric: string }
  }
  type: Record<string, Record<string, number | string>>
  space: Record<string, number>
  radius: Record<string, number>
  border: Record<string, number>
  elevation: Record<string, string>
  layout: {
    frame: { width: number; height: number }
    safeTop: number
    safeBottom: number
    tabBar: number
    gutter: number
  }
  control: Record<string, number>
}

async function main() {
  const raw = readFileSync(sourcePath, 'utf8')
  const json = JSON.parse(raw) as TokensJson

  const body = `// app/src/theme/tokens.ts
//
// GENERATED — do not edit by hand. Source: docs/design/tokens.json.
// Regenerate with \`npm run gen:tokens\` (app/scripts/gen-tokens.ts) after
// changing the source JSON.

export const colors = ${stringify(json.color)} as const

export const fonts = ${stringify(json.font)} as const

export const type = ${stringify(json.type)} as const

export const space = ${stringify(json.space)} as const

export const radius = ${stringify(json.radius)} as const

export const border = ${stringify(json.border)} as const

export const elevation = ${stringify(json.elevation)} as const

export const layout = ${stringify(json.layout)} as const

export const control = ${stringify(json.control)} as const

export type ColorToken = keyof typeof colors
export type SpaceToken = keyof typeof space
export type RadiusToken = keyof typeof radius
export type TypeToken = keyof typeof type
`

  // Run through the repo's own Prettier config (app/.prettierrc*) so the
  // generated file matches `npm run format:check` byte-for-byte — otherwise
  // every regen would fight the formatter (JSON.stringify's double-quoted,
  // semicolon-less-but-not-quite output isn't this project's style).
  const prettierConfig = await prettier.resolveConfig(outPath)
  const formatted = await prettier.format(body, { ...prettierConfig, filepath: outPath })

  writeFileSync(outPath, formatted)
  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(repoRoot, outPath)} from ${path.relative(repoRoot, sourcePath)}`)
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

main()
