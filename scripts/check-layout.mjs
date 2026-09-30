import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js')

const pages = [
  ['overview', '概览'],
  ['accounts', '账号池'],
  ['automation', '积分自动化'],
  ['models', '模型'],
  ['keys', 'API 密钥'],
  ['usage', '用量'],
  ['logs', '日志'],
  ['settings', '设置'],
  ['backup', '备份'],
]

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.fill('input[type=password]', 'admin123')
  await page.click('button[type=submit]')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  for (const [slug, label] of pages) {
    await page.getByRole('button', { name: label }).click()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `desktop-${slug}.png`, fullPage: true })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  for (const [slug, label] of pages) {
    await page.getByRole('button', { name: label }).click()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `mobile-${slug}.png`, fullPage: true })
  }
} finally {
  await browser.close()
}
