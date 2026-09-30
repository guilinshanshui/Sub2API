import { spawn } from 'node:child_process'

const children = [
  spawn('corepack', ['pnpm', '--filter', '@sub2api/gateway', 'dev'], { stdio: 'inherit', shell: true }),
  spawn('corepack', ['pnpm', '--filter', '@sub2api/web', 'dev'], { stdio: 'inherit', shell: true }),
]

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill(signal)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
