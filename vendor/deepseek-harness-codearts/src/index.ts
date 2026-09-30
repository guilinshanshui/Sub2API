import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { dueAutomationJobIds, dueDailySigninProviders } from './buddy-automation.js'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { registerTraeLlm } from './trae-adapter.js'
import { registerClineLlm } from './cline-adapter.js'
import { registerLoomyLlm, parseLoomyRemoteModels } from './loomy-adapter.js'
import { registerRaccoonLlm } from './raccoon-adapter.js'
import { registerPhanthyLlm } from './phanthy-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { TraeAuth } from './trae-auth.js'
import { ClineAuth } from './cline-auth.js'
import { LoomyAuth } from './loomy-auth.js'
import { RaccoonAuth } from './raccoon-auth.js'
import { PhanthyAuth } from './phanthy-auth.js'
import { LOOMY } from './loomy-product.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import { RACCOON } from './raccoon-product.js'
import { PHANTHY } from './phanthy-product.js'
import { AccountPool } from './account-pool.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import type { ImageRequestTarget } from './image-budget.js'
import { buildRaccoonNickname, registerJetHubRpc } from './jet-hub-rpc.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { LoomyCredential } from './loomy.js'
import type { RaccoonCredential } from './raccoon.js'
import type { PhanthyCredential } from './phanthy.js'

export const name = 'codearts-auth'
export { dueAutomationJobIds, dueDailySigninProviders as dueDailySigninProviders }
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Jet Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - 它是六个 provider 各自 `registerConfigurableProviders({ settingsNs })` 的
 *   落地位置（0.1.7 下 `settingsNs` = 本条目 id），模型设置页据此把 provider
 *   判定为「已配置」（判据见 `dsh-client-ui-settings-models` 的 `configured`）；
 * - 本插件的凭据与账号管理**不**走这里（那是 Jet Hub 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册；各 provider 的
 *   `settingsNs` 由 `settingsNamespaceFor()` 指向本插件条目 id，模型设置页照常
 *   工作。这里刻意**静默跳过**：旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx: Context) {
  return async (
    attachment: unknown,
    target: ImageRequestTarget,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as {
      readImageRequest?: (
        ref: never,
        requestTarget: never,
      ) => Promise<{ data: Uint8Array; mediaType?: string; attachment?: { mediaType?: string } }>
    } | undefined
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment as never, target as never)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
      ctx.logger?.warn?.(
        '[jet-hub] 图片请求版本派生失败，回退原图：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx: Context): void {
  // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下需要**：
  // 那时 `settings.register` 可用，六个 namespace 分别对应 codearts 路由、
  // CodeBuddy（buddy）、WorkBuddy（workbuddy）、LobsterAI（lobsterai）、
  // Qoder（qoder）、TRAE（trae）—— 后五者由 registerBuddyLlm /
  // registerLobsteraiLlm / registerQoderLlm / registerTraeLlm 以
  // `llm-${product.id}` 派生。
  //
  // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
  // profile 条目 id，故这里不做任何注册；各 provider 的 settingsNs 由
  // `settingsNamespaceFor()` 解析为本插件条目 id。
  registerProviderSettings(
    ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai',
    'llm-qoder', 'llm-qodercn', 'llm-trae', 'llm-cline', 'llm-loomy', 'llm-raccoon', 'llm-phanthy',
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
    if (removed.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  // ⚠️ **CodeArts 不注册任何斜杠命令**（`codearts-login` / `codearts-status` /
  // `codearts-refresh` 三个已删除）：登录、状态与续期统一在 Jet Hub 设置页完成，
  // 与 buddy / workbuddy / lobsterai / qoder / trae 的既有做法一致。
  const codearts = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // CodeArts **只认账号池**，与其余五个 provider 一致。
      //
      // ⚠️ 早期它额外支持「单凭据模式」（`CODEARTS_ACCESS_TOKEN`）：登录后把凭据
      // 写到那个固定 ref，适配器在账号池取不到时回退去读它。该模式**已移除** ——
      // 登录入口只有 Jet Hub 设置页，凭据一律写入 `CODEARTS_ACCOUNT_XXX`，
      // 固定的 `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取。
      //
      // 这里仍保留 `credentialRef` 选项，仅为满足适配器契约与报错文案
      // （其余 provider 同样传各自的默认 ref，但都不再作为回退来源）。
      const available = await pool.getAvailableAccount('codearts', '')
      return available?.credential as CodeArtsCredential | undefined
    },
    // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
    // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
    // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
    refresh: async () => {
      const available = await pool.getAvailableAccount('codearts', '')
      if (available) await service.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
    },
    fetchRemoteModels: () => service.refreshModels(pool),
    accountPool: pool,
  })

  // ===== Buddy (腾讯 CodeBuddy) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Jet Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。
  const buddy = new BuddyAuth(ctx)
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: async (modelId?: string) => {
      // 优先使用账号池获取可用账号，回退到单凭据解析
      if (pool) {
        // ⚠️ `modelId` 必须透传：限流按**模型**记（`modelRateLimits[model]`），
        // 传空串会让 `getAvailableAccount` 的限流过滤整体短路
        //（`if (modelId.length === 0) return true`）→ 被标记限流的账号仍被选中。
        const available = await pool.getAvailableAccount('buddy', modelId ?? '')
        if (available && pool.acquireInFlight(available.entry.id)) {
          return available.credential as BuddyCredential
        }
      }
      const resolved = await ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
    // 后者在 Jet Hub 登录路径下根本不存在，会把 401 报成「未配置凭据」
    // 并自锁。详见 createPoolRefresh 的注释。
    refresh: createPoolRefresh(pool, 'buddy', buddy),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。不可用时适配器自动回退原图。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Jet Hub 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
      // 保证不会串用 CodeBuddy 的凭据。
      // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      const available = await pool.getAvailableAccount('workbuddy', modelId ?? '')
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as BuddyCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    // 同上：必须刷池内账号（`WORKBUDDY_ACCESS_TOKEN` 从未被写入过）。
    // 这条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refresh: createPoolRefresh(pool, 'workbuddy', workbuddy),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Jet Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
      // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, modelId ?? '')
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as LobsteraiCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(LOBSTERAI.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as LobsteraiCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 13 张原图（≈50 MiB）
    // 就回 `SERVER code=500`，撞的是请求体体积。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== Qoder (阿里系 AI IDE) 服务 =====
  // 第五个产品线，协议与四者**都不同源**：PKCE 设备码轮询登录
  // （不起本地回调服务器，见 src/qoder-oauth.ts）。
  // 服务名由产品 id 派生，注册为 ctx.qoderAuth。
  // 与其它 provider 一样不注册斜杠命令：入口在 Jet Hub 的 Qoder 面板。
  const qoder = new QoderAuth(ctx)
  /**
   * 「本次实际使用的账号 id」跟踪表（provider id → 账号 id）。
   *
   * ## 为什么需要它
   *
   * 额度受限时要标记**当前账号**（见 `QoderAdapter.switchAccountOnQuota`）。
   * 但「当前账号」不能靠「再问一次账号池的默认账号」得到 —— 池的选号是
   * `getAvailableAccount()` 的即时决策，与适配器**本次实际拿到**的那份凭据
   * 可能是两个账号（例如池已因限流切走，而适配器手上仍是旧凭据）。
   * 标记落错账号的后果：真正受限的账号没被标记 → 下次又被选中 → 反复撞墙；
   * 无辜账号被标记 → 它当天用不了（虽不致命，但属无谓损失）。
   *
   * 故在 `resolveCredential` 里**记录实际返回的那个账号**，供适配器查询。
   * 用 `Map` 按 provider 分开，国际版与中国版互不影响。
   */
  const activeQoderAccountId = new Map<string, string | undefined>()
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 QODER.id 而非字面量 'qoder'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠️ `modelId` 透传：Qoder 的额度是「模型 + 账号」维度（见
      // `qoder-adapter.ts` 的 `switchAccountOnQuota`），传空串会让它刚写下的
      // 当日额度标记在下次选号时被忽略。
      const available = await pool.getAvailableAccount(QODER.id, modelId ?? '')
      if (available) {
        if (pool.acquireInFlight(available.entry.id)) {
          activeQoderAccountId.set(QODER.id, available.entry.id)
          return available.credential as QoderCredential
        }
        activeQoderAccountId.set(QODER.id, undefined)
      }
      // 回退到单凭据路径：没有账号条目可标记，清空以免标记到过期的 id。
      activeQoderAccountId.set(QODER.id, undefined)
      const resolved = await ctx.credentials.resolve(credentialRef(QODER.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as QoderCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `QODER_ACCOUNT_XXX` 的凭据，而 `qoder.refresh()` 读写的是
      // `QODER_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(QODER.id, '')
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoder.refresh()
    },
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 15 张原图（≈57 MiB）
    // 直接 `TRANSPORT: fetch failed`，撞的是请求体体积。
    // ⚠️ qoder 与 qodercn **共用同一个 QoderAdapter 类**，故两站同时受益
    //（与「差异收敛到产品配置」这个模式一致 —— 别以为只改了一站）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER,
    // 额度受限时标记「本次实际使用的账号」（理由见 `activeQoderAccountId` 注释）。
    currentAccountId: () => activeQoderAccountId.get(QODER.id),
  })

  // ===== Qoder 中国版（qodercn）=====
  // 与上面的国际版是**同一套协议实现**的第二个实例（差异全在 QODER_CN 配置里：
  // 域名 qoder.cn / openapi.qoder.com.cn / gateway.qoder.com.cn、client_id
  // 732aef47-…、以及一张自己的 14 条模型表）。刻意**不复制**任何 qoder*.ts
  // 实现文件 —— 协议同源，复制会让同类缺陷（tools 不下发、工具历史丢
  // tool_calls、错误帧不抛错）修两遍。
  // 服务名由 `${product.id}Auth` 派生，注册为 ctx.qoderCnAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的「Qoder (中国版)」面板。
  const qoderCn = new QoderAuth(ctx, { product: QODER_CN })
  const qoderCnAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只取中国版自己账号池的账号，回退到 QODERCN_ACCESS_TOKEN。
      // ⚠️ provider 实参必须是 QODER_CN.id：写死 'qoder' 会让中国版
      // 永远查不到自己的账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠️ `modelId` 透传：与 QODER.id 同因（当日额度是「模型 + 账号」维度）。
      const available = await pool.getAvailableAccount(QODER_CN.id, modelId ?? '')
      if (available) {
        if (pool.acquireInFlight(available.entry.id)) {
          activeQoderAccountId.set(QODER_CN.id, available.entry.id)
          return available.credential as QoderCredential
        }
        activeQoderAccountId.set(QODER_CN.id, undefined)
      }
      activeQoderAccountId.set(QODER_CN.id, undefined)
      const resolved = await ctx.credentials.resolve(credentialRef(QODER_CN.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as QoderCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      // 理由与国际版那条真实缺陷完全同因：resolveCredential 优先取池内凭据，
      // 而 refresh() 读写 QODERCN_ACCESS_TOKEN，两者错配会让日志里续期全成功、
      // 用户却「刚登录却一直认证失败」。
      const available = await pool.getAvailableAccount(QODER_CN.id, '')
      if (available) await qoderCn.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoderCn.refresh()
    },
    readImage: makeReadImage(ctx),
    // 同 QODER：两站共用同一个适配器类，缩放桥接也必须两边都接
    //（只接一边会让中国版的截图照样撞 57 MiB）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER_CN,
    // 额度受限时用它标记「当前账号」（见 `QoderAdapter.switchAccountOnQuota`）。
    // ⚠️ 取「**本次实际使用**的账号」而非池里默认那一个：池的默认账号可能与之
    // 不同（例如本账号被限流、池已切到别的账号），标错就会让标记落在无辜账号上。
    currentAccountId: () => activeQoderAccountId.get(QODER_CN.id),
  })

  // ===== TRAE（字节 TRAE IDE）服务 =====
  // 第六个产品线，协议与前面几者**完全不同**：认证用 ExchangeToken（轮换 refreshToken），
  // 对话用 Cloud-IDE-JWT 鉴权，载荷需从 OpenAI 格式转换为 SOLO 格式，
  // SSE 为自定义格式（非 OpenAI 标准），需独立解析。
  // 服务名由 TraeAuth 依 product.id 派生，注册为 ctx.traeAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 TRAE 面板。
  const trae = new TraeAuth(ctx)
  const traeAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // ⚠️ `modelId` 必须透传：限流是**按模型**记的（`modelRateLimits[model]`），
      // 传空串会让 `getAvailableAccount` 的限流过滤整体短路
      //（`if (modelId.length === 0) return true`）→ 被标记限流的账号仍被选中，
      // 换号形同虚设（用户报障「没有切换」的根因之一）。
      const available = await pool.getAvailableAccount(TRAE.id, modelId ?? '')
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as TraeCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(TRAE.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as TraeCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, '')
      if (available) await trae.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await trae.refresh()
    },
    fetchRemoteModels: () => trae.fetchModels(pool),
    // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
    // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE,
  })

  // ===== Cline（Cline 桌面端 / Cline API）服务 =====
  // 第七个产品线，协议与前面六者**都不同源**：登录是 **WorkOS 设备码轮询**
  // （api.workos.com，不起本地回调端口），鉴权头是 `Bearer workos:<jwt>`
  // （前缀**不可剥**），推理是**标准 OpenAI 兼容**端点。
  // 服务名由 ClineAuth 依 product.id 派生，注册为 ctx.clineAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Cline 面板。
  const cline = new ClineAuth(ctx)
  const clineAdapter = registerClineLlm(ctx, {
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 Cline 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 CLINE.id 而非字面量 'cline'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      const available = await pool.getAvailableAccount(CLINE.id, modelId ?? '')
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as ClineCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(CLINE.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as ClineCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `CLINE_ACCOUNT_XXX` 的凭据，而 `cline.refresh()` 读写的是
      // `CLINE_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(CLINE.id, '')
      if (available) await cline.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await cline.refresh()
    },
    // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
    // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 24 张原图全过、
    // 32 张（≈122 MiB）才 `TRANSPORT` —— 余量比其他家大，但仍需兜住长会话。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: CLINE,
  })

  // ===== Loomy（讯飞办公助手）服务 =====
  // 第八个产品线，与前面七者**都不同源**：登录是**短信验证码**
  // （讯飞 CAccount，HMAC-SHA1 签名，没有 loginUrl 可打开），
  // 推理是标准 OpenAI 兼容（复用 openai-compat.ts）。
  // 服务名由 LoomyAuth 依 product.id 派生，注册为 ctx.loomyAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Loomy 面板。
  const loomy = new LoomyAuth(ctx)

  /**
   * 按凭据 ref 解析 Loomy 凭据（供选号器与兜底路径共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处。
   */
  const resolveLoomyCredentialByRef = async (refName: string): Promise<LoomyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as LoomyCredential
    } catch {
      return undefined
    }
  }

  /**
   * Loomy 的**按余额优先选号器**（负载均衡）。
   *
   * ⚠️ **为什么需要它**（真实缺陷）：实测 Loomy 的今日赠送额度（每天 5000）
   * 耗尽后，服务端**继续扣永久积分且不报错** —— 「耗尽」是**静默降级**而非错误。
   * 而本插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
   * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
   *
   * 策略：优先有今日额度的号 → 其次有永久积分的号 → 都无/查不到排最后。
   * 档内保持手动拖拽顺序（详见 `loomy-balance-rank.ts`）。
   */
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef,
  })

  const loomyAdapter = registerLoomyLlm(ctx, {
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    /**
     * 解析本轮该用哪个账号的凭据。
     *
     * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
     * 的签名说明）—— **必须透传给 `getAvailableAccount`**，否则模型级限流
     * 过滤失效（早期实现传空串 `''`，等于「不按模型过滤」）。
     */
    resolveCredential: async (modelId?: string) => {
      // 只从 Loomy 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 LOOMY.id 而非字面量 'loomy'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      //
      // ⚠️ 先按「模型未受限 + 未停用」筛出候选，**再**按余额分档选号。
      // 余额排序只在这批候选内部进行 —— 即你的要求：
      // 「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
      const candidates = pool
        .listAccountsByProvider(LOOMY.id)
        .filter(a => a.enabled)
        .filter((a) => {
          // 与 `getAvailableAccount` 的限流判据保持一致（空 modelId = 不过滤）。
          const key = modelId ?? ''
          if (key.length === 0) return true
          if (!a.modelRateLimits) return true
          const resetAt = a.modelRateLimits[key]
          return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
        })
        .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

      // 「锁定永久积分」：只允许消耗今日赠送额度（用户要求，且持久化）。
      const allowPermanent = !pool.loomyPermanentLocked()

      if (candidates.length > 0) {
        const picked = await loomyBalanceSelector.select(candidates, { allowPermanent })
        if (picked !== undefined) {
          const credential = await resolveLoomyCredentialByRef(picked.account.credentialRef)
          if (credential !== undefined) return credential
        } else if (!allowPermanent) {
          // ⚠️ **锁定时绝不可落到下面的单凭据兜底** —— 那会绕过锁定、
          // 照样消耗永久积分，锁定形同虚设。这里直接抛明确错误（用户要求）。
          throw new Error(
            'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽'
            + '（或余额查询失败）。请在 Jet Hub 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
          )
        }
      }

      // 兜底：账号池为空/全部不可解析时，退回单凭据 ref。
      const resolved = await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // ⚠️ Loomy **没有 refresh 端点**，这里的 `refresh` 语义是
      // 「探测凭据是否仍有效」，失效时抛错提示重新登录。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则探测的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      if (available) await loomy.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await loomy.refresh()
    },
    // 远端模型目录：GET /api/v1/models。
    // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
    // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      const resolved = available !== null && available !== undefined
        ? { value: JSON.stringify(available.credential) }
        : await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (resolved === undefined) return []
      let credential: LoomyCredential
      try {
        credential = JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return []
      }
      const response = await fetch(`${LOOMY.apiBase}/models`, {
        headers: { Accept: 'application/json', token: credential.access_token },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return []
      return parseLoomyRemoteModels(await response.json())
    },
    // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOOMY,
  })

  // ===== Raccoon Work（商汤小浣熊）服务 =====
  // 第九个产品线。登录与 Loomy 同型（**本地页承载**的微信扫码 + 短信双路径），
  // 但**有** refresh 端点（凭据可静默续期），且客户端可能未安装。
  //
  // ⚠️ **不依赖客户端**：官方桌面端靠 `office-raccoon://auth/callback` 自定义协议
  // 回调，本插件（宿主侧 Node 进程）收不到；故改为「宿主本地生成 code + 自行轮询」，
  // 完全绕开该回调。凭据存插件自有的 ctx.credentials，不读客户端任何文件。
  // 见 tests/unit/raccoon-client-independence.spec.ts 的回归防线。
  //
  // 服务名由 RaccoonAuth 依 product.id 派生，注册为 ctx.raccoonAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Raccoon 面板。
  const raccoon = new RaccoonAuth(ctx)
  const raccoonAdapter = registerRaccoonLlm(ctx, {
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 raccoon 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 RACCOON.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      const available = await pool.getAvailableAccount(RACCOON.id, modelId ?? '')
      // `getAvailableAccount` 的凭据类型是 `CodeArtsCredential | BuddyCredential`
      // 联合（历史遗留），与 `RaccoonCredential` 无充分重叠，故经 `unknown` 转换。
      // 运行时安全性由 provider 过滤保证：查询用 `RACCOON.id`，取到的必是 raccoon 凭据。
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as unknown as RaccoonCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(RACCOON.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as RaccoonCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // ⚠️ raccoon **有** refresh 端点（与 Loomy 恒 false 不同），这里是真续期。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(RACCOON.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        // 这条路径正是「发消息时按需续期」，故它是最常触发回写的地方。
        await raccoon.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await raccoon.refresh()
      }
    },
    // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
    // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: () => raccoon.fetchModels(pool),
    // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
    readImage: makeReadImage(ctx),
    // ⚠️ raccoon 尤其需要请求版本：该网关按**请求体字节**设限
    // （实测 `HTTP_413: request body exceeds 10MB`，两张大截图就占掉大半配额）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: RACCOON,
  })

  // 一次性修复**老账号**的昵称与凭据字段（与上面 WorkBuddy 的启动清理同类）。
  //
  // 早期实现把服务端的 `name` 直接当昵称用，而实测它是**自动生成的默认名**
  //（本机账号是 `RaccoonAva`），注册第二个账号时会重名、无法区分；
  // 且凭据里没存 `phone`（后来才发现 `user_info.phone` 可用于消歧）。
  // 光改代码只影响新登录的账号，故这里主动补一次：
  // 拉 `user_info` 补 `phone`，并用 `buildRaccoonNickname` 重算昵称。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void raccoon.repairAccountNicknames(pool, buildRaccoonNickname).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Raccoon 账号的显示名（追加手机号尾号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Raccoon 账号显示名失败：${String(error)}`)
  })

  // ===== PhanthyCode 服务 =====
  // 第十个产品线。登录用 PKCE 授权码两步式（浏览器授权 + 粘贴 code），
  // 凭据可续期；每日登录奖励走桌面端 Ed25519 签名协议。
  const phanthy = new PhanthyAuth(ctx)
  const phanthyAdapter = registerPhanthyLlm(ctx, {
    credentialRef: credentialRef(PHANTHY.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount(PHANTHY.id, modelId ?? '')
      if (available && pool.acquireInFlight(available.entry.id)) {
        return available.credential as unknown as PhanthyCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(PHANTHY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as PhanthyCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(PHANTHY.id, '')
      if (available) {
        await phanthy.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      } else {
        await phanthy.refresh()
      }
    },
    accountPool: pool,
    product: PHANTHY,
  })

  // 一次性修复**老 TRAE 账号**的展示名（与上面 Raccoon 同类，同因）：
  // 服务端 ScreenName 是**按 uid 自动生成的默认名**（`用户26815487395`），
  // 多账号无法区分；`GetUserInfo` 的 `NonPlainTextMobile`（脱敏手机号）可区分。
  // 光改代码只影响新登录的账号，故这里主动补一次。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void trae.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 TRAE 账号的显示名（改用脱敏手机号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 TRAE 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 LobsterAI 账号**的展示名（同类，但成因不同）：
  // 服务端把**手机号本身**当 `user.nickname` 下发，且只脱敏到「露末 4 位」
  // （`130****1100`）—— 按用户要求收敛为只露末 2 位（`130******00`）。
  // 纯本地归一化（幂等），无需重新登录。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void lobsterai.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 LobsterAI 账号的显示名（手机号改为只露末 2 位）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 LobsterAI 账号显示名失败：${String(error)}`)
  })

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  /**
   * 十个 provider 实例的续期入口（`buddy` 与 `workbuddy` 是两个实例、同一个类）。
   *
   * 收成一张表是为了让「失败必须留日志」这条规则**只写一遍** —— 原先这里是
   * 十个空 catch（注释写着「静默」），把 provider 内部的告警与异常一起吞掉，
   * 「凭据一直刷不动」在日志里完全无痕（issue !IKIRTT 的可观测性条目）。
   */
  const refreshTargets: ReadonlyArray<readonly [string, (pool: AccountPool) => Promise<void>]> = [
    ['codearts', (p) => service.refreshAll(p)],
    ['buddy', (p) => buddy.refreshAll(p)],
    ['workbuddy', (p) => workbuddy.refreshAll(p)],
    ['lobsterai', (p) => lobsterai.refreshAll(p)],
    ['qoder', (p) => qoder.refreshAll(p)],
    ['qodercn', (p) => qoderCn.refreshAll(p)],
    ['trae', (p) => trae.refreshAll(p)],
    ['cline', (p) => cline.refreshAll(p)],
    // ⚠️ Loomy 不可续期：这里只探测**已过期**的账号（见 LoomyAuth.refreshAll）。
    ['loomy', (p) => loomy.refreshAll(p)],
    // raccoon **可续期**：只按 refreshable 过滤，且只续进入 lead 窗口的账号。
    ['raccoon', (p) => raccoon.refreshAll(p)],
    ['phanthy', (p) => phanthy.refreshAll(p)],
  ]

  async function refreshAllCredentials(): Promise<void> {
    for (const [tag, refreshAll] of refreshTargets) {
      try {
        await refreshAll(pool)
      } catch (error) {
        // 单个 provider 抛错不得中断其余九个（各 refreshAll 内部本就逐账号
        // try，能冒到这里的已是「整批失败」级别的异常）。
        ctx.logger?.warn?.(
          `[jet-hub] ${tag} 批量续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // 启动时如果有任何可续期账号，安排定期续期。
  //
  // ⚠️ 判据只看 `refreshable`，**不看 `enabled`**：停用只影响账号池的自动
  // 选号，不该让凭据停止续期。早期这里写成 `a.refreshable && a.enabled`，
  // 于是「所有账号都被停用」时续期定时器**根本不启动**，凭据一路过期到
  // refresh_token 失效，用户重新启用后只能重新登录（真实缺陷）。
  //
  // ⚠️ **必须立刻先跑一轮**（issue !IKIRTT 的主缺陷）：早先这里只有
  // `setInterval`，第一次处理要等满一个周期。短寿命 provider（cline 1 小时、
  // codearts 约 2 小时、raccoon 3 小时）的凭据在宿主关闭期间早就到期了，
  // 于是重启后**最长 30 分钟**一直显示「已过期」、积分行一直 401。
  // 现在这一轮与 lead-time 过滤配合（`src/expiry-sync.ts` 的 `shouldRefreshNow`），
  // 只对「距过期不足 1 小时」的账号发续期请求，其余只做一次本地对账 ——
  // 既补上了首轮，又不会在启动时打出几十个无谓请求。
  pool.listAllAccounts().then(accounts => {
    const hasRefreshable = accounts.some(a => a.refreshable)
    if (!hasRefreshable) return
    void refreshAllCredentials()
    const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
    ctx.effect(() => () => {
      clearInterval(refreshTimer)
      service.stop()
      buddy.stop()
      workbuddy.stop()
      lobsterai.stop()
      qoder.stop()
      qoderCn.stop()
      trae.stop()
      cline.stop()
      loomy.stop()
    }, 'jet-hub: multi-account refresh scheduler')
  }).catch((error: unknown) => {
    // ⚠️ 原来这个 `.then()` **没有** `.catch()`：`listAllAccounts()` 一旦 reject
    // （存储层异常），续期定时器就**永远不武装**，且日志里一个字都没有 ——
    // 那时上面的「最长 30 分钟」会恶化成「永不自愈」。
    ctx.logger?.warn?.(
      `[jet-hub] 多账号续期调度器启动失败（本次会话不会自动续期）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    cline.stop()
    loomy.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== Jet Hub RPC 注册 =====
  // provider → 适配器实例：Jet Hub「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts,
    buddy: buddyAdapter,
    workbuddy: workbuddyAdapter,
    lobsterai: lobsteraiAdapter,
    qoder: qoderAdapter,
    qodercn: qoderCnAdapter,
    trae: traeAdapter,
    cline: clineAdapter,
    loomy: loomyAdapter,
    raccoon: raccoonAdapter,
    phanthy: phanthyAdapter,
  }

  // 治理的在途名额跟随整个插件生命周期。适配器在拿到凭据前已占用名额，
  // 插件停止时无论调用方是否正确消费流，都统一归还，避免退出后泄漏。
  ctx.effect(() => () => {
    pool.releaseAllInFlight()
  }, 'jet-hub: governance in-flight')

  registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline, loomy, raccoon, phanthy, modelAdapters)
  ctx.provide('accountPool', pool)
}
