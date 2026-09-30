import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = ['qoder-auth-wasm.wasm']

for (const asset of assets) {
  const source = resolve(packageRoot, 'src', asset)
  const target = resolve(packageRoot, 'lib', asset)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}
