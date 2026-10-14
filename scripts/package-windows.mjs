#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const skipBuild = args.has('--skip-build')
const version = (process.env.RELEASE_VERSION?.trim() || '1.0.12').replace(/[^0-9A-Za-z._-]/g, '')
const releaseRoot = join(root, 'release')
const packageDir = join(releaseRoot, `pkg-v${version.replace(/\./g, '')}`)
const zipPath = join(releaseRoot, `Sub2API-v${version}-windows-x64.zip`)
const vendorDir = join(root, 'vendor', 'deepseek-harness-codearts')

// Dependencies ship plenty of files that are irrelevant at runtime and, worse,
// fixtures whose names use characters Windows forbids in a path. Dropping them
// keeps the ZIP extractable by Explorer's built-in unzip.
const PRUNED_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'docs',
  'doc',
  'examples',
  'example',
  'coverage',
  '.github',
  '.circleci',
  'benchmark',
  'benchmarks',
])

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
}

function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  return result.stdout.trim()
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`)
}

// Windows rejects these characters in a path segment, and also rejects names
// that end with a space or a dot.
function isIllegalWindowsName(name) {
  // eslint-disable-next-line no-control-regex
  return /[<>:"|?*\u0000-\u001f]/.test(name) || /[ .]$/.test(name)
}

function* walk(directory) {
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      yield { entry, entryPath }
      if (entry.isDirectory()) pending.push(entryPath)
    }
  }
}

function pruneDependencies(nodeModules) {
  if (!existsSync(nodeModules)) return
  const stack = [nodeModules]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const entryPath = join(current, entry.name)
      if (PRUNED_DIRECTORIES.has(entry.name) || isIllegalWindowsName(entry.name)) {
        rmSync(entryPath, { recursive: true, force: true })
        continue
      }
      stack.push(entryPath)
    }
  }
}

function assertNoSymlinks(directory) {
  for (const { entryPath } of walk(directory)) {
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`portable package still contains a symbolic link: ${entryPath}`)
    }
  }
}

function assertNoIllegalWindowsPaths(directory) {
  for (const { entryPath } of walk(directory)) {
    const name = entryPath.slice(directory.length).split(/[\\/]/).pop()
    if (isIllegalWindowsName(name)) {
      throw new Error(`portable package contains a path Windows cannot extract: ${entryPath}`)
    }
  }
}

if (!skipBuild) {
  console.log('Building gateway and web...')
  run('corepack', ['pnpm', 'build'])
}

for (const required of [
  join(root, 'apps', 'gateway', 'dist', 'index.js'),
  join(root, 'apps', 'web', 'dist', 'index.html'),
  join(root, 'Start.bat'),
  join(root, 'scripts', 'open-when-ready.ps1'),
]) {
  assertFile(required, 'build output')
}

rmSync(packageDir, { recursive: true, force: true })
mkdirSync(packageDir, { recursive: true })

const listed = JSON.parse(
  capture('corepack', ['pnpm', '--filter', '@sub2api/gateway', 'list', '--prod', '--depth', '0', '--json']),
)
const gateway = Array.isArray(listed) ? listed[0] : listed
if (!gateway?.dependencies) throw new Error('Could not read gateway production dependencies')

const dependencies = {}
for (const [name, info] of Object.entries(gateway.dependencies)) {
  if (name === '@sub2api/dsh-codearts') {
    dependencies[name] = `file:${relative(packageDir, vendorDir).replaceAll('\\', '/')}`
    continue
  }
  if (!info?.version) throw new Error(`Could not resolve production dependency ${name}`)
  dependencies[name] = info.version
}

writeFileSync(
  join(packageDir, 'package.json'),
  `${JSON.stringify({ name: 'sub2api-windows', version, private: true, type: 'module', dependencies }, null, 2)}\n`,
)

console.log('Installing a flat, portable dependency tree...')
run('npm', ['install', '--omit=dev', '--install-links', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: packageDir,
})
rmSync(join(packageDir, 'package-lock.json'), { force: true })

console.log('Pruning non-runtime dependency files...')
pruneDependencies(join(packageDir, 'node_modules'))

cpSync(join(root, 'apps', 'gateway', 'dist'), join(packageDir, 'dist'), { recursive: true })
cpSync(join(root, 'apps', 'web', 'dist'), join(packageDir, 'web', 'dist'), { recursive: true })
cpSync(join(root, 'Start.bat'), join(packageDir, 'Start.bat'))
cpSync(join(root, 'README.md'), join(packageDir, 'README.md'))
mkdirSync(join(packageDir, 'scripts'), { recursive: true })
cpSync(join(root, 'scripts', 'open-when-ready.ps1'), join(packageDir, 'scripts', 'open-when-ready.ps1'))

for (const required of [
  join(packageDir, 'dist', 'index.js'),
  join(packageDir, 'web', 'dist', 'index.html'),
  join(packageDir, 'node_modules', '@sub2api', 'dsh-codearts', 'lib', 'index.js'),
  join(packageDir, 'node_modules', '@sub2api', 'dsh-codearts', 'lib', 'qoder-auth-wasm.wasm'),
  join(packageDir, 'scripts', 'open-when-ready.ps1'),
]) {
  assertFile(required, 'portable package')
}
assertNoSymlinks(packageDir)
assertNoIllegalWindowsPaths(packageDir)

rmSync(zipPath, { force: true })
console.log('Creating zip...')
run('tar', ['-a', '-c', '-f', zipPath, '.'], { cwd: packageDir })
console.log(`Portable package: ${packageDir}`)
console.log(`Release asset: ${zipPath}`)