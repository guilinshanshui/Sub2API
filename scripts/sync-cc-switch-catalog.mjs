#!/usr/bin/env node
/**
 * Rebuild the CC Switch Codex model catalog from a sub2api gateway.
 *
 * The file at ~/.codex/cc-switch-model-catalog.json is the catalog referenced
 * by CC Switch provider entries, so it must use the provider/model slugs that
 * entry selects (for example buddy/deepseek-v4.1-flash).
 *
 * Usage:
 *   node scripts/sync-cc-switch-catalog.mjs
 *   node scripts/sync-cc-switch-catalog.mjs --out "C:\path\cc-switch-model-catalog.json"
 *   node scripts/sync-cc-switch-catalog.mjs --gateway http://127.0.0.1:8787 --key sk-...
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { gateway: 'http://127.0.0.1:8787', key: '', out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--gateway') args.gateway = argv[++i] ?? args.gateway
    else if (arg === '--key') args.key = argv[++i] ?? ''
    else if (arg === '--out') args.out = argv[++i] ?? ''
  }
  return args
}

async function readLocalApiKey() {
  for (const candidate of [
    path.join(ROOT, 'data', 'api-keys.json'),
    path.join(process.cwd(), 'data', 'api-keys.json'),
  ]) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'))
      const key = parsed.keys?.find((item) => item.enabled !== false && typeof item.value === 'string')
      if (key !== undefined) return key.value
    } catch {
      // Try the next candidate.
    }
  }
  return ''
}

function effortLabel(id) {
  if (typeof id !== 'string' || id.length === 0) return id
  return id.charAt(0).toUpperCase() + id.slice(1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const key = args.key || await readLocalApiKey()
  if (!key) throw new Error('No API key found; pass --key or ensure data/api-keys.json exists.')

  const response = await fetch(`${args.gateway.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`Gateway /v1/models returned HTTP ${response.status}`)
  const payload = await response.json()
  const remote = Array.isArray(payload?.data) ? payload.data : []

  const entries = remote.map((model) => {
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
        .filter((item) => typeof item?.effort === 'string' && item.effort.length > 0)
        .map((item) => ({
          effort: item.effort,
          description: typeof item.description === 'string' && item.description.length > 0 ? item.description : effortLabel(item.effort),
        }))
      : []
    const context = Number(model.context_window ?? model.contextWindow)
    const contextWindow = Number.isFinite(context) && context > 0 ? context : undefined
    const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : ['text']
    return {
      slug: model.id,
      display_name: model.name || model.id,
      description: model.description ?? '',
      default_reasoning_level: model.default_reasoning_level ?? levels[0]?.effort,
      supported_reasoning_levels: levels,
      supports_reasoning_summaries: levels.length > 0,
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: contextWindow ? 100 : undefined,
      auto_compact_token_limit: contextWindow ? Math.floor(contextWindow * 0.9) : undefined,
      input_modalities: modalities,
      supports_parallel_tool_calls: false,
      supported_in_api: true,
      visibility: 'list',
      shell_type: 'streamable',
      priority: 1,
    }
  })

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'cc-switch-model-catalog.json')

  let previous
  try {
    previous = await fs.readFile(outPath, 'utf8')
  } catch {
    previous = undefined
  }
  if (previous !== undefined) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    await fs.writeFile(`${outPath}.bak-ccs-sync-${stamp}`, previous, 'utf8')
  }
  await fs.writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  console.log(`Catalog: ${outPath}`)
  console.log(`Models written: ${entries.length}`)
  console.log(`Models with reasoning levels: ${entries.filter((entry) => entry.supported_reasoning_levels.length > 0).length}`)
  if (previous !== undefined) {
    const backup = `${outPath}.bak-ccs-sync-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
    console.log(`Backup: ${backup}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
