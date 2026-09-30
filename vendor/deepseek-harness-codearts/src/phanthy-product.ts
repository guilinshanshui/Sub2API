/**
 * PhanthyCode 产品配置与兜底模型目录。
 */

import { PHANTHY_API_BASE } from './phanthy.js'

/** 兜底模型条目。 */
export interface PhanthyFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** PhanthyCode 产品配置。 */
export interface PhanthyProduct {
  id: 'phanthy'
  displayName: string
  apiBase: string
  desktopVersion: string
  desktopPlatform: string
  defaultCredentialRef: string
  fallbackModels: readonly PhanthyFallbackModel[]
}

/**
 * 兜底模型目录，来源为 phanthycode2api 参考实现。
 * 不支持图片输入，故不声明 image modality。
 */
const PHANTHY_FALLBACK_MODELS: readonly PhanthyFallbackModel[] = [
  { id: 'phanthy-fast', name: 'Phanthy Fast', contextWindow: 1_050_000, maxTokens: 65_536 },
  { id: 'phanthy-pro', name: 'Phanthy Pro', contextWindow: 1_050_000, maxTokens: 65_536 },
  { id: 'phanthy-ultra', name: 'Phanthy Ultra', contextWindow: 1_050_000, maxTokens: 65_536 },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: 'glm-5.1', name: 'GLM 5.1', contextWindow: 200_000, maxTokens: 65_536 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144, maxTokens: 65_536 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
]

/** PhanthyCode 产品真值源。 */
export const PHANTHY: PhanthyProduct = {
  id: 'phanthy',
  displayName: 'PhanthyCode',
  apiBase: PHANTHY_API_BASE,
  desktopVersion: '2.33.2',
  desktopPlatform: process.platform === 'win32' ? 'windows' : process.platform,
  defaultCredentialRef: 'PHANTHY_ACCESS_TOKEN',
  fallbackModels: PHANTHY_FALLBACK_MODELS,
}
