#!/usr/bin/env node
/**
 * Patch the Codex model catalog referenced by ~/.codex/config.toml with the
 * capability metadata exposed by sub2api /v1/models.
 *
 * Codex / Codex++ build their picker from model_catalog_json. Older catalogs
 * were generated without reasoning efforts, so reasoning models showed no
 * selectable level and were unusable. This script is idempotent and keeps a
 * timestamped backup next to the catalog.
 *
 * Usage:
 *   node scripts/sync-codex-catalog.mjs
 *   node scripts/sync-codex-catalog.mjs --catalog "C:\path\to\catalog.json"
 *   node scripts/sync-codex-catalog.mjs --gateway http://127.0.0.1:8787 --key sk-...
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')

function parseArgs(argv) {
  const args = { gateway: 'http://127.0.0.1:8787', key: '', catalog: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--gateway') args.gateway = argv[++i] ?? args.gateway
    else if (arg === '--key') args.key = argv[++i] ?? ''
    else if (arg === '--catalog') args.catalog = argv[++i] ?? ''
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

function parseCatalogPathFromConfig(text) {
  const match = /^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m.exec(text)
  return match?.[1]
}

async function resolveCatalogPath(explicit) {
  if (explicit.length > 0) return path.resolve(explicit)
  const configPath = path.join(CODEX_HOME, 'config.toml')
  try {
    const configured = parseCatalogPathFromConfig(await fs.readFile(configPath, 'utf8'))
    if (configured !== undefined) {
      return path.isAbsolute(configured)
        ? configured
        : path.resolve(CODEX_HOME, configured)
    }
  } catch {
    // Fall through to the conventional location.
  }
  return path.join(CODEX_HOME, 'model-catalogs', 'ccs-default.json')
}

function modelIdOf(entry) {
  if (typeof entry.slug === 'string' && entry.slug.length > 0) return entry.slug
  if (typeof entry.id === 'string' && entry.id.length > 0) return entry.id
  if (typeof entry.model === 'string' && entry.model.length > 0) return entry.model
  return ''
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const key = args.key || await readLocalApiKey()
  if (key.length === 0) {
    throw new Error('No API key found. Pass --key or make sure data/api-keys.json contains an enabled key.')
  }
  const response = await fetch(`${args.gateway.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`Gateway /v1/models returned HTTP ${response.status}`)
  const payload = await response.json()
  const remoteModels = Array.isArray(payload?.data) ? payload.data : []
  const byId = new Map()
  for (const model of remoteModels) {
    if (typeof model?.id !== 'string') continue
    byId.set(model.id, model)
    const slash = model.id.indexOf('/')
    if (slash > 0) {
      const provider = model.id.slice(0, slash)
      const upstream = model.id.slice(slash + 1)
      if (provider === 'buddy') byId.set(`cn:${upstream}`, model)
      if (provider === 'workbuddy') byId.set(`global:${upstream}`, model)
    }
  }

  const catalogPath = await resolveCatalogPath(args.catalog)
  const raw = await fs.readFile(catalogPath, 'utf8')
  const catalog = JSON.parse(raw)
  const entries = Array.isArray(catalog) ? catalog : catalog.models
  if (!Array.isArray(entries)) throw new Error(`Unsupported catalog shape: ${catalogPath}`)

  let patched = 0
  let withEfforts = 0
  for (const entry of entries) {
    const id = modelIdOf(entry)
    if (id.length === 0) continue
    const remote = byId.get(id)
    if (remote === undefined) continue
    const levels = Array.isArray(remote.supported_reasoning_levels)
      ? remote.supported_reasoning_levels
        .filter((item) => typeof item?.effort === 'string' && item.effort.length > 0)
        .map((item) => ({
          effort: item.effort,
          description: typeof item.description === 'string' && item.description.length > 0
            ? item.description
            : item.effort,
        }))
      : []
    if (levels.length > 0) {
      entry.supported_reasoning_levels = levels
      entry.supports_reasoning_summaries = true
      if (typeof remote.default_reasoning_level === 'string') {
        entry.default_reasoning_level = remote.default_reasoning_level
      }
      withEfforts += 1
    }
    const contextWindow = Number(remote.context_window ?? remote.contextWindow)
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      entry.context_window = contextWindow
      entry.max_context_window = contextWindow
      entry.contextWindow = contextWindow
      entry.maxContextWindow = contextWindow
      entry.auto_compact_token_limit = Math.floor(contextWindow * 0.9)
    }
    if (Array.isArray(remote.input_modalities)) {
      entry.input_modalities = remote.input_modalities
      entry.inputModalities = remote.input_modalities
    }
    patched += 1
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupPath = `${catalogPath}.bak-codex-sync-${stamp}`
  await fs.writeFile(backupPath, raw, 'utf8')
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

  console.log(`Catalog: ${catalogPath}`)
  console.log(`Models in catalog: ${entries.length}`)
  console.log(`Matched gateway models: ${patched}`)
  console.log(`Models with reasoning levels: ${withEfforts}`)
  console.log(`Backup: ${backupPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
