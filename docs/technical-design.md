# 多端产品自动化部署平台技术设计 v0.1

> 文档状态：设计已确认，并已开始实现 v0.1 开发版本。本文第 1～12 节描述完整目标设计，第 13 节记录实际实现与运行方式；不要将目标设计等同于已经完成的功能。

## 1. 产品目标与已确认范围

建设一个面向个人和小团队的网页控制台，让用户把已完成的产品从 GitHub 导入，选择产品类型和发布目标，通过引导式配置完成构建、部署或测试分发。

核心流程：**导入源码 → 选择产品类型 → 配置目标与账号 → 预检查 → 执行部署 → 查看访问地址、二维码或测试入口。**

| 维度 | 本期决定 |
| --- | --- |
| 使用对象 | 个人或小团队；邀请制，不开放公众注册 |
| 产品来源 | GitHub 公有/私有仓库；不支持源码 ZIP 上传 |
| Web 目的地 | 同时支持 Vercel 和自有 Linux 服务器 |
| 小程序 | 首期限定微信小程序，采用 Taro 标准模板 |
| App | Flutter 标准模板，同时支持 Android 和 iOS |
| 自动化目标 | Web 上线、小程序预览及体验流程、Android APK 分发、iOS TestFlight |
| 当前阶段 | 已从文档阶段进入开发；交付本地可运行版本，不自动申请外部资源或执行真实发布 |

设计时工作区未发现已有项目文件，本方案按新项目设计。

### 1.1 必须明确的能力边界

- 这是部署平台，不是跨端代码转换器。选择 App 不会把任意网页自动转换成 App。
- 同一仓库可以包含多个产品，通过不同子目录分别建立项目；Flutter 项目可以同时选择 Android、iOS 两个目标。
- “其他类型”入口展示未支持状态和接入说明，不能进入模拟成功的部署流程。
- 小程序正式提审、正式发布，以及 App Store、Google Play 等商店正式上架不在本期范围内。
- 不自动创建业务数据库、执行数据库迁移、开通云资源、购买域名或代替用户完成实名、协议确认。
- 账号申请、首次授权、DNS 配置、部分测试渠道设置和平台审核仍需要人工处理。

## 2. 首期支持矩阵

| 产品模板 | 发布适配器 | 自动化结果 | 必要前提 |
| --- | --- | --- | --- |
| React + Vite | Vercel | 可访问的部署 URL | Vercel 账号、目标项目与有效授权 |
| Next.js | Vercel | 兼容 Vercel 运行环境的站点 | 不依赖其不支持的常驻进程、本地持久化等能力 |
| React + Vite | Docker 主机 | 容器化静态站点 | 已初始化的 Linux 主机、域名和 HTTPS |
| Next.js standalone | Docker 主机 | 单服务容器化站点 | 同上；业务数据库等外部依赖已准备好 |
| Taro React 微信模板 | 微信 CI | 开发版本上传、预览码及体验流程衔接 | AppID、代码上传私钥、发布节点 IP 白名单 |
| Flutter Android | Android 分发 | 正式签名 APK、受控下载入口 | applicationId、发布 keystore 及签名配置 |
| Flutter iOS | TestFlight | 可供测试人员使用的构建 | Apple Developer Program、macOS 构建资源、签名材料及 App Store Connect 配置 |

Taro 首期仅构建微信目标；Flutter 首期限定标准单应用结构，不包含自定义扩展、复杂原生多 Target 工程。Vue、uni-app、React Native、原生工程等通过后续适配器扩展，不声称已兼容。

### 2.1 标准模板契约

每个受支持产品提供 `deploy.config.json`，声明 `schemaVersion`、`templateId`、`templateVersion`、`rootDir` 和非敏感构建参数。

- 模板固定依赖锁文件、工具链版本、构建入口、产物目录和健康检查约定。
- 首期不提供任意 Shell 发布脚本、自定义特权容器参数或任意 Docker Compose 上传入口。
- 仓库配置仅声明构建需求；平台目的地、密钥引用和授权策略由控制台管理。
- 没有声明文件时，只读取清单进行辅助识别；用户确认类型并通过模板兼容检查后才能部署。
- 自动识别与用户选择不一致时阻止执行，明确说明不兼容项。
- 不在控制服务中加载仓库的 JavaScript 配置或执行依赖安装脚本。

## 3. 网页功能与用户流程

### 3.1 页面组成

| 页面 | 主要内容 |
| --- | --- |
| 总览 | 项目、最近部署、失败任务、等待人工处理事项、构建额度 |
| 新建部署向导 | GitHub 仓库/分支/子目录 → 产品类型 → 目标选择 → 配置 → 预检查 → 确认 |
| 项目详情 | 技术栈、部署目标、配置版本、触发规则、历史版本 |
| 部署详情 | 阶段进度、实时日志、明确的错误原因、重试/取消入口 |
| 分发结果 | Web URL、微信预览码与体验说明、Android 下载页、TestFlight 入口 |
| 集成与凭据 | GitHub、Vercel、主机、微信、Android、Apple 的连接与有效性检查 |
| 团队设置 | 成员角色、项目权限、资源限额、审计记录 |

App 类型允许同时勾选 Android 和 iOS。两端分别执行、分别显示状态，任一端失败不覆盖另一端已经成功的结果。

### 3.2 配置体验

- 根据类型动态展示必填项，缺少账号、证书或服务器条件时显示操作指引，不先发起必然失败的构建。
- 密钥保存后仅显示名称、用途、指纹和有效期，不再返回原文。
- 将环境变量区分为公开构建参数、应用运行时机密、部署/签名凭据。
- 明确提示：前端变量、`--dart-define` 和小程序包内数据不能承载秘密。
- 首期支持手动一键部署；可由 Owner 启用指定可信分支的 push 自动部署。
- 生产 Web 自动部署默认关闭；开启前确认分支、环境、目标域名和授权范围。未开启时需用户确认生产部署。
- 不自动构建来自 fork 的 PR，也不执行仓库自带的 CI 工作流。

## 4. 总体架构与技术选型

采用模块化单体控制面，加异步编排、托管构建和独立发布执行节点。不引入 Kubernetes 或企业级多租户调度系统。

```text
浏览器控制台
    │ HTTPS / REST / SSE
控制 API ───── PostgreSQL：项目、任务、状态、审计
    │
    ├──── Redis + BullMQ：短时任务队列
    ├──── S3 兼容存储：源码快照、产物、归档日志
    │
异步编排器
    ├──── Vercel API → Vercel 托管构建与部署
    ├──── GitHub Actions Linux → Web / Taro / Android 构建
    ├──── GitHub Actions macOS → iOS 构建
    ├──── 独立可信签名任务 → Android / iOS 签名
    └──── 固定出口 IP 发布 Worker
              ├──── 微信 CI 上传与预览
              └──── 受限 SSH → 用户 Linux 主机
```

| 层次 | 选型 |
| --- | --- |
| 控制台 | Next.js、React、TypeScript、Tailwind CSS、shadcn/ui |
| 控制 API | NestJS、REST API、OpenAPI |
| 数据库 | PostgreSQL、Prisma |
| 异步编排 | BullMQ、Redis；数据库为任务状态事实来源 |
| 实时进度 | SSE；历史日志使用分页接口 |
| 对象存储 | S3 协议；开发环境使用 MinIO，生产使用独立托管 bucket |
| 构建执行 | GitHub 托管 Linux/macOS Runner，任务使用全新环境 |
| 微信发布 | 固定出口 IP 的独立 Linux Worker，固定版本 miniprogram-ci |
| 自有主机 | Docker、受限部署 helper、Caddy 反向代理与 HTTPS |
| 控制平台部署 | Linux + Docker Compose；不把长任务放进 Web 请求或 Serverless 请求生命周期 |

### 4.1 三类信任边界

1. **控制面**：负责鉴权、配置、版本快照、编排，不执行产品源码。
2. **构建面**：允许执行产品依赖和编译脚本，但不能读取部署、签名或其他项目凭据。
3. **签名/发布面**：只执行平台维护的可信程序，处理校验过的产物，不执行仓库脚本。

CI 工作流放在平台管理的独立私有 automation 仓库。产品仓库的写权限不能修改签名工作流。第三方 Action 固定到完整 commit SHA，工具版本由模板锁定，可信签名任务不复用源码构建缓存。

### 4.2 GitHub 授权与任务凭据

- 登录采用 GitHub OAuth；源码访问采用仅授权所选仓库的 GitHub App。
- automation 仓库使用独立执行身份，避免把 Actions 写权限授予所有产品仓库。
- CI 仅接收任务 ID，通过 OIDC 向控制面换取任务级权限。
- 控制面校验 issuer、audience、仓库 ID、受控 workflow 引用与 SHA、run ID、任务状态和用途。
- 构建身份只能读取本次源码快照、上传本次产物；不能兑换签名凭据。
- 签名身份只能访问已绑定的产物摘要与指定凭据版本，签名结束后销毁临时工作环境。

## 5. 各平台执行流程

### 5.1 公共流程

1. 校验成员权限、模板兼容性、目标配置和额度。
2. 将仓库分支解析为不可变 commit SHA，冻结配置和凭据版本引用。
3. 创建部署批次及各目标子任务，记录幂等键。
4. 获取源码快照，检查路径、大小、文件数量与模板结构。
5. 执行构建，登记产物摘要；进入独立签名或发布阶段。
6. 查询第三方真实状态，验证结果是否达到用户选择的分发目标。
7. 保存结果地址、产物、外部任务 ID、审计和必要的人工操作清单。

所有阶段使用同一 SHA；构建期间分支更新不得改变当前任务的源码。

### 5.2 Web → Vercel

- 首期通过服务端保存的 Vercel Token 连接账号，并绑定目标 team/project；凭据不进入产品构建脚本。
- 从固定 GitHub 快照获取文件，通过 Vercel 文件接口和创建部署接口提交，交由 Vercel 构建，不重复启动平台构建任务。
- 使用专用目标项目，不另接 Git 自动部署，避免同一次提交被重复发布。
- Preview 与 Production 的配置隔离。生产部署按生产环境构建，不把预览产物直接视为相同的生产产物。
- 保存 deployment ID，查询到 READY 后验证目标 URL；正式部署由 Vercel 处理生产域名切换。
- READY 但站点检查失败不显示成功；有符合条件的历史生产部署时执行回滚并核验，否则显示需要人工处理。
- 默认可使用 Vercel 分配的域名，自定义域名通过向导完成绑定与 DNS 验证。

### 5.3 Web → 自有 Linux 服务器

首期支持公网可达的 Linux x86_64 主机，单个无状态 Web 服务；不自动管理业务数据库和持久卷。

- Owner 先按初始化说明安装 Docker、Caddy 和平台受限部署 helper，配置域名。
- 主机登记时固定 SSH host key；使用专用 deployer 身份和受限命令，禁止任意远程 Shell、转发或广泛 sudo 权限。
- 在托管 Linux Runner 使用平台模板构建镜像，产出镜像归档、文件 SHA-256 和镜像 ID，上传对象存储。
- 目标 helper 校验清单与摘要后加载镜像，通过两个发布槽位启动新版本。
- 健康检查通过后切换 Caddy 路由；失败则保持旧版本流量。旧实例保留短暂观察窗口再停止。
- 对外只暴露代理端口；应用按模板使用非 root、资源限制和最小容器权限。
- 首期通过对象存储传输镜像归档，暂不增加独立镜像仓库。

### 5.4 微信小程序 → 预览与体验

- Taro 在无发布密钥的 Linux 构建任务中完成编译和依赖打包。
- 固定 IP 发布 Worker 校验 AppID、包结构和产物摘要，然后使用 `miniprogram-ci` 上传并生成预览二维码。
- 上传密钥只进入可信发布阶段，开启微信侧 IP 白名单；同一项目固定 CI robot 配置。
- 官方 CI 文档明确覆盖上传与预览，不把上传成功直接标成体验版发布成功。
- 首次设置体验版本、配置体验成员等步骤由用户在微信公众平台完成；控制台提供待办并记录确认人、时间和关联版本。
- 若后续固定 robot 的版本更新行为经实际账号验证可以沿用，仍分别记录“自动上传状态”和“体验状态”；无法自动核实的状态标注为用户确认，不伪造平台回执。
- 预览码不等于对所有微信用户公开可用，访问资格及有效期受微信平台规则约束。

### 5.5 Android → 签名 APK 分发

- Flutter 模板生成 release 未签名 APK，不允许以 debug keystore 充当正式分发签名。
- 独立可信签名任务执行对齐、签名及验签，验证 applicationId、versionCode 和证书指纹。
- versionCode 由数据库按应用标识原子分配，避免并发重复；已发布应用更新必须使用相同发布证书。
- APK 存入私有 bucket，通过登录后的测试分发页下载；可由 Owner 创建有期限、可撤销的分享入口。
- 每次下载临时换取短有效期签名 URL；撤销分享不能撤回已经下载或安装的 APK。
- 页面明确提示 Android 安装未知来源应用所需的用户操作。本期不提交应用商店。

### 5.6 iOS → TestFlight

- 前置条件包括 Apple Developer Program、已注册 Bundle ID、App Store Connect 应用记录和测试分组。
- 用户提供匹配的发行证书及私钥、描述文件，以及具有所需权限的 App Store Connect API Key。API Key 不能替代代码签名材料。
- 在托管 macOS Runner 使用固定 Flutter/Xcode 组合生成未签名 archive。
- 在全新可信 macOS 签名任务中，仅对产物导出签名 IPA，不重新执行仓库构建脚本；证书导入临时 keychain，任务结束即销毁。
- 上传 App Store Connect，记录版本号、唯一 build number、上传关联信息和后续查询到的 build ID。
- 默认分发到用户选定的已有内部测试组；外部测试需用户显式启用并满足测试信息、合规材料及可能的 Beta App Review。
- 上传完成、Apple 处理中、等待审核、可测试分别显示；只有目标测试组实际可用时才视为完成。
- TestFlight 构建通常可测试 90 天；平台记录实际可用性与到期状态，不承诺永久安装链接。
- 不提供“任意 iPhone 扫码直接安装 IPA”的承诺，也不自动邀请或添加未经用户选择的测试人员。

## 6. 任务状态、幂等和恢复

### 6.1 状态模型

运行状态与执行阶段分开存储：

- `status`：QUEUED、RUNNING、WAITING_EXTERNAL、WAITING_MANUAL、SUCCEEDED、FAILED、CANCEL_REQUESTED、CANCELLED、UNKNOWN。
- `stage`：PREFLIGHT、FETCH、BUILD、SIGN、UPLOAD、VERIFY、DISTRIBUTE。
- 另存 `providerStatus`、`distributionStatus` 和是否经人工确认。

上传阶段成功不代表整体成功。微信体验流程未完成时等待人工处理，TestFlight 尚不可测试时等待外部处理。批次状态由各目标子任务推导，可以显示部分成功。

### 6.2 重试与一致性

- API 使用幂等键；数据库事务同时写任务和 outbox，避免任务已入库但漏投队列。
- 队列按至少一次投递处理，阶段转换通过版本条件更新防止重复推进。
- 每次外部写操作记录 operation ID 和 provider job ID；请求超时先对账，不能盲目重新上传、重复签名或再次发布。
- 编译错误不自动重试；网络和限流错误使用有限次数退避重试，并遵守 Retry-After。
- 同一目标环境的发布写操作串行化；使用代际标识阻止迟到任务覆盖更新的当前版本。
- 等待 Apple 等外部平台时释放 Runner 与队列执行槽位，通过延迟检查继续推进。
- 取消是请求而非保证。已发生的外部发布不能标成“从未执行”；无法确定结果时进入 UNKNOWN 并对账。
- 编排器重启后从数据库恢复；Redis 丢失不能导致发布记录丢失。

### 6.3 默认执行限制

- Linux 构建并发 2、macOS 构建并发 1；单次 Linux 构建 30 分钟、macOS 构建 60 分钟上限。
- 外部状态采用 15～60 秒退避查询；长时间等待显示提醒，不以本地构建超时替代外部审核结论。
- 默认保存日志和普通产物 30 天；当前部署和最近 5 个可回滚 Web 版本不自动清理。
- 额度、保存期限和并发由 Owner 配置；构建前展示可能的付费资源消耗。

## 7. 数据模型与关键接口

### 7.1 数据实体

| 实体 | 核心信息 |
| --- | --- |
| Workspace / Member | 团队、GitHub 用户 ID、角色、邀请状态 |
| Project | 仓库 ID、子目录、产品类型、模板及版本 |
| DeploymentTarget | provider、环境、外部项目/应用标识、非敏感配置 |
| Integration / CredentialVersion | 授权关联、加密凭据、用途、版本、有效期与指纹 |
| SourceSnapshot / ConfigRevision | commit SHA、源码摘要、冻结配置及凭据版本引用 |
| ReleaseBatch / Deployment | 批次、目标子任务、版本号、状态、外部任务 ID、幂等键 |
| JobStep / ExternalOperation | 阶段执行、重试次数、操作标识、对账结果 |
| Artifact | 类型、对象 key、摘要、大小、签名指纹、保留策略 |
| DeploymentEvent | 递增事件序号、脱敏日志、状态变更 |
| ShareLink / AuditLog | 有效期与撤销状态；敏感操作的操作者、目标和结果 |

所有业务对象带 workspace ID，并在服务端进行对象级鉴权。应用标识与 build number、幂等键、外部事件 ID 等建立唯一约束。

### 7.2 API 轮廓

| 接口 | 作用 |
| --- | --- |
| `POST /api/projects/import` | 选择已授权仓库，检测模板与子目录 |
| `POST /api/projects/:id/targets` | 保存发布目标与凭据引用 |
| `POST /api/preflights` | 校验配置、权限、证书及资源条件，不执行发布 |
| `POST /api/releases` | 以幂等键创建多目标部署批次 |
| `GET /api/deployments/:id` | 返回真实阶段、目标状态和分发结果 |
| `GET /api/deployments/:id/events` | SSE，支持 Last-Event-ID 断线续传 |
| `POST /api/deployments/:id/cancel` | 请求取消并返回实际处理状态 |
| `POST /api/deployments/:id/retry` | 基于固定源码和明确配置版本创建新尝试 |
| `POST /api/deployments/:id/manual-confirmations` | 记录人工确认及适用范围，不伪装为平台验证 |
| `POST /api/targets/:id/rollback` | 仅对支持且满足条件的 Web 目标回滚 |
| `GET /api/artifacts/:id/download` | 鉴权后签发临时下载地址 |
| `POST /api/hooks/github` | 验证签名并去重处理推送/任务事件 |
| `POST /api/runners/exchange` | 校验 OIDC，兑换阶段限定的临时权限 |

发布适配器统一提供能力声明、配置校验、构建计划、发布、状态查询、取消及可选回滚；不支持的能力必须显式返回，不能做空实现后报告成功。

## 8. 安全设计

- 角色采用 Owner、Maintainer、Viewer；Owner 管理成员、凭据绑定、主机与自动生产策略，Maintainer 在授权项目执行部署，Viewer 只读。
- 登录会话使用 Secure、HttpOnly Cookie；写接口做 CSRF 防护、限流和对象级权限校验。
- 凭据使用 AES-256-GCM 加密并保存 key version；主密钥由独立运行时 secret 文件挂载，不进入数据库、源码仓库或普通备份。
- 支持凭据轮换、撤销和过期提醒；备份恢复流程必须包含单独保管的加密主密钥。
- 源码、产物、日志桶默认私有；对象路径、归档解包和下载大小实施白名单及限额，拒绝越界路径、危险链接和解压膨胀。
- 构建不挂载控制面目录、宿主 Docker socket 或发布凭据；可信发布节点不执行源码脚本。
- 外部请求限制 provider 域名和已登记的目标；阻止云元数据、环回、保留地址、非预期重定向及 DNS 重绑定绕过。
- SSH 固定 host key，远程 helper 只接受经过 Schema 校验的发布清单，不拼接用户输入执行 Shell。
- 环境变量值、Token、私钥、证书密码及签名 URL 不进入日志；脱敏是辅助措施，不能替代密钥隔离。
- GitHub Webhook 校验原始请求签名、事件 ID 和重放；Runner 回传不能凭任务 ID 自报成功。
- 源码权限并不等同于发布权限；自动部署只面向明确授权的可信分支，保护生产凭据和签名链路。

## 9. 回滚、运维与成本

### 9.1 分平台恢复语义

| 类型 | 恢复方式 |
| --- | --- |
| Vercel | 回到平台允许且仍保留的历史生产部署；遵守套餐、权限与回滚后域名自动分配规则 |
| Docker 主机 | 切换到保留的旧镜像和匹配运行配置，重新检查健康 |
| 微信小程序 | 重新上传历史源码构建并处理体验版本设置，不承诺与 Web 相同的流量回滚 |
| Android / iOS | 历史源码使用新的递增构建号重新发布；不强制降级或撤回已安装应用 |

Web 回滚不回滚数据库、外部 API 和业务数据。凭据已撤销、环境不兼容或历史产物不存在时，阻止自动回滚并明确说明原因。

### 9.2 最小运行资源

- 一台 Linux 控制节点运行控制台、API、编排器、PostgreSQL 和 Redis，初始按 2 vCPU / 4 GB 规划。
- 一个与控制节点隔离、具备固定出口 IP 的 Linux 发布节点，负责微信上传与受限主机发布。
- GitHub 托管构建额度，包含 macOS；S3 兼容对象存储；用户自己的目标 Linux 主机。
- 控制台提供公网 HTTPS 回调地址；网络需能够访问 GitHub、Vercel、Apple、微信及相关依赖源。
- iOS 还涉及 Apple 开发者计划费用。Vercel、CI、主机、存储和流量均按实际套餐核算，不承诺免费。

监控覆盖队列积压、构建耗时、失败原因、外部等待时间、证书到期和存储用量。PostgreSQL 定期备份并进行恢复演练；运行日志关联 deployment ID 与外部 job ID。

## 10. 建议代码组织

以下为完整目标目录，实际已经实现的模块及合并方式见第 13 节：

```text
apps/console/                 网页控制台
apps/api/                     鉴权、项目、目标、任务 API
apps/orchestrator/            队列、状态机、外部任务对账
apps/publisher/               固定 IP 发布 Worker
packages/domain/              类型、状态机、权限和适配器契约
packages/adapters/            Vercel、Docker、微信、Android、iOS
packages/ui/                  共享界面组件
packages/security/            凭据封装、OIDC、归档与输入校验
release-automation/           工作流与可信签名脚本源，发布到独立 automation 仓库
templates/web-vite/            React + Vite 模板
templates/web-next/            Next.js 模板
templates/miniapp-taro/        微信小程序模板
templates/app-flutter/         Flutter 双端模板
infra/                        控制平台 Compose 与主机初始化配置
tests/                        单元、集成、安全及端到端测试
docs/technical-design.md      当前技术设计文档
```

## 11. 验证计划与交付顺序

### 11.1 先做关键可行性验证

使用专门的测试账号和标准示例，验证 Vercel 固定快照部署、主机切流回滚、微信 CI 上传、Android 独立签名、iOS 未签名 archive 到独立签名及 TestFlight 的完整链路。

尤其验证 iOS 标准模板能否在不重新执行源码脚本的签名任务中完成导出；这是安全架构的前置验收项。若验证不通过，需更新设计，不允许临时把生产凭据注入不可信构建来绕过。

### 11.2 完整首期的实施顺序

1. **基础平台**：仓库导入、模板协议、登录权限、密钥管理、状态机、CI 任务关联与日志。
2. **Web 双通道**：Vercel、自有主机部署、健康检查、域名引导、回滚。
3. **微信与 Android**：小程序预览/体验待办、APK 签名、受控测试下载。
4. **iOS 与统一分发**：macOS 构建、签名、TestFlight 状态、双端部分成功处理。
5. **发布前加固**：任务恢复、取消与对账、安全测试、成本限制、备份恢复和操作文档。

上述是实施顺序，不是把 iOS 或自有服务器排除出已确认的首期范围。

### 11.3 验收标准

- 受支持模板的七条基准链路真实跑通：两类 Web 模板 × 两种目的地，加微信、Android、iOS。
- 产品类型不兼容、缺失凭据、证书过期、包标识不匹配等问题在合适阶段被明确阻止。
- 部署日志实时更新且可断线恢复；刷新页面或编排器重启不会丢失任务。
- 重复提交、重复回调、队列重复投递和乱序状态不能造成重复发布或旧任务覆盖新版本。
- 微信上传完成但体验流程未完成、Apple 上传完成但测试不可用时，页面不能显示整体成功。
- Web 新版本不健康时保留或恢复旧版本；不支持回滚时不给出虚假的回滚成功。
- Android 验签通过且可在测试设备安装；iOS 在选定 TestFlight 组中实际可测试。
- 恶意构建脚本无法读取签名密钥、部署凭据或其他项目产物；错误 OIDC 身份、越权下载、路径穿越和注入测试被拒绝。
- 多目标部分失败时，用户能单独重试失败目标，不重复发布已成功目标。

以上是完整首期的最终验收要求。当前已实现部分功能与本地自动化测试，尚未完成真实账号联调和七条部署链路的全部验收。

## 12. 官方依据

- [Vercel 创建部署 API](https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment)：文件部署、Git 来源及部署状态。
- [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)：可回滚版本、套餐与环境限制。
- [微信 miniprogram-ci](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)：代码上传、预览、私钥和 IP 白名单。
- [Flutter iOS 发布说明](https://docs.flutter.dev/deployment/ios)：macOS/Xcode、签名、构建编号及 App Store Connect。
- [Apple TestFlight 概述](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)：内部/外部测试、审核与有效期。
- [GitHub Actions 安全加固](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)：最小权限、受控工作流和不可变 Action 引用。

外部平台的套餐、配额和接口会变化，接入时以账号实际权限与官方现行约束进行预检查，不将本设计中的支持目标描述为平台无条件保证。

## 13. v0.1 开发版本实现记录

### 13.1 已实现

- 中文响应式控制台：工作台、项目、部署记录、集成与凭据、操作审计、工作区设置及文档弹窗。
- 四步项目向导：源码登记/联网识别、产品模板选择、动态目标配置、服务端预检查；Flutter 支持同时保存 Android/iOS 目标。
- NestJS API、单工作区的 Owner/Maintainer/Viewer 校验、来源验证和 CSRF 防护。
- GitHub OAuth 登录及服务端受邀账号名单；生产源码访问使用 GitHub App，本地私有仓库可保存只读 Token。
- AES-256-GCM 凭据加密、作用域绑定、元数据返回、账号验证和本地撤销。撤销本地记录不会撤销平台上的原始令牌。
- 固定 commit SHA 的 GitHub 源码读取、模板识别、文件数量/大小检查、不安全路径、符号链接和子模块拒绝。
- Vercel 适配器：文件快照部署、目标权限检查、真实状态轮询、取消、失联对账、站点检查及条件回滚。没有真实账号联调，不将此项描述为已通过真实发布验收。
- PostgreSQL 事务、任务与 outbox 同时入库、幂等键、外部目标互斥、租约与重启恢复、SSE 编排事件、失败目标重试。
- 单元与 API 测试，覆盖凭据不回显、跨工作区读取拦截、恶意输入、重复任务、失联不重复上传、平台取消和生产指向变化。
- 项目设置：修改名称、仓库、分支、子目录；配置版本校验拒绝过期窗口覆盖。历史部署保持原始快照。
- GitHub 自动触发：仓库 ID 绑定、受保护分支校验、HMAC-SHA256 验签、delivery 与提交双重去重、延迟事件恢复和可见的触发记录。

### 13.2 开发版本与目标设计的差异

| 项目 | 当前实现与限制 |
| --- | --- |
| 数据库 | 本地默认 PGlite 内嵌 PostgreSQL，数据在 `.data/postgres`；配置 `DATABASE_URL` 后使用独立 PostgreSQL。当前使用参数化 SQL，尚未接入 Prisma 与版本化迁移工具。 |
| 编排器 | 当前与 API 同进程运行；数据库为事实来源，可配置 Redis/BullMQ。尚未拆成独立 orchestrator/publisher 服务。 |
| 源码快照 | 当前通过受限 GitHub blob API 在内存收集，最多 300 个文件、5 MB 总量、1 MB 单文件；尚未接入 S3 和大仓库分块上传。 |
| 自有主机、微信、Android、iOS | 已实现选择、配置、凭据保存和预检查拦截；实际构建、签名、上传与分发执行器仍待实现，不是仅填入账号就能运行。 |
| 多目标展示 | 目标可以分别配置；App 执行器未实现，因此尚无真实双端构建、测试下载和部分成功的端到端验收。 |
| 自动触发 | 已支持 Vercel 的受保护分支 push 自动部署、原始请求验签、持久化接收与去重；需配置 Webhook Secret、GitHub 回调和项目授权。Runner OIDC 仍未实现。 |
| 测试分发 | 尚无 APK 对象存储、签名下载链接、微信体验确认或 TestFlight 测试分组实际操作。 |
| 版本模板 | 当前完成模板检测规则；尚未生成全部可供产品开发复用的模板工程。 |
| 运维 | 当前没有自动计费、配额控制、产物清理、主密钥轮换、备份恢复工具或完整生产部署清单。 |
| 权限范围 | 当前一个工作区共用项目访问范围；成员名单由管理员环境配置提供，尚未提供 UI 邀请及细分项目授权。 |

### 13.3 本地运行

需要 Node.js 22 或更高版本及 npm。在项目根目录执行：

```bash
npm install
npm run dev
```

- 控制台：`http://localhost:3000`；API：`http://127.0.0.1:4310`。
- 浏览器必须使用与 `CONSOLE_ORIGIN` 一致的来源，默认是 `http://localhost:3000`。
- 默认本地模式只监听回环地址，自动进入本地 Owner 工作区；不需要 Docker。
- 本地第一次启动自动生成 `.data/master.key`，权限限制为当前用户。数据库与主密钥均被 Git 忽略；不要将它们上传或作为公开静态文件分发。
- `.env.example` 提供配置说明。需要自定义时创建本地 `.env`，不要提交真实秘密。
- PostgreSQL 与 Redis 是可选开发外部依赖；生产启动必须显式配置独立数据库、加密主密钥、HTTPS 来源、GitHub OAuth 和账号邀请名单。
- `ALLOWED_GITHUB_IDS` 支持 `数字ID:Owner,数字ID:Maintainer,数字ID:Viewer`。不写角色时，第一项为 Owner，其余为 Maintainer。
- 当前版本适合本地开发及账号联调，不应将本地免登录模式直接暴露公网。

### 13.4 验证命令

```bash
npm run typecheck
npm test
npm run build
```

网页端到端测试要求先运行 `npm run dev`，再安装浏览器并执行：

```bash
PLAYWRIGHT_BROWSERS_PATH=.data/browsers npm exec -- playwright install chromium --no-shell
PLAYWRIGHT_BROWSERS_PATH=.data/browsers npm exec -- playwright test
```

端到端测试只创建并删除其自身的临时项目，不添加真实凭据、不请求外部部署；截图与失败诊断存放在被忽略的 `.data` 目录。测试使用 Chromium 新版 headless 模式，无需额外下载 headless-shell。Vercel 和其他平台的真实发布测试必须在用户明确配置测试账号和目标后进行。

生产依赖通过 `npm run audit:production` 检查。当前对 NestJS 的间接依赖 `multer` 显式覆盖为 2.3.0，以修复其上游暂未更新的已知漏洞；后续升级 NestJS 时应重新核实并移除不再需要的覆盖。

### 13.5 GitHub 自动部署配置与安全边界

1. 先完成 Vercel 目标与凭据配置，确保源码及目标预检查通过。
2. 管理员配置 `GITHUB_WEBHOOK_SECRET`（至少 32 字符的安全随机值），重启 API。密钥不在 UI 输入、日志或 API 响应中展示。
3. 在 GitHub 仓库的 Settings → Webhooks 中添加 `CONSOLE_ORIGIN/api/hooks/github`，Content type 使用 `application/json`，事件仅选择 push，Secret 与服务端一致，保持 SSL verification 开启。
4. 给部署分支设置保护规则；当前实现要求 GitHub branch API 返回 `protected: true`。平台不代用户修改 GitHub 规则。
5. 在项目卡片的“项目设置 → 自动部署”选择目标并开启。生产目标必须再次勾选持续自动发布授权；开启操作本身不会发起一次部署。
6. 新提交触发后，在“部署记录 → GitHub 自动触发”查看事件处理结果，并进入关联部署查看最终发布状态。

新增接口：

| 接口 | 行为 |
| --- | --- |
| `PATCH /api/projects/:id` | Owner 更新源码配置；请求必须带读取时的 `revision`，冲突返回 409。 |
| `POST /api/projects/:id/automation` | Owner 开启/关闭自动规则；开启前验证分支保护及目标权限。 |
| `POST /api/hooks/github` | 原始 JSON 请求体 HMAC-SHA256 验签，限制 512 KB，持久化接收后返回 202。该接口用 Webhook 签名鉴权，不依赖浏览器 Cookie 或 CSRF Token。 |
| `GET /api/dashboard` | 增加不含秘密的 Webhook 配置状态和最近 100 条触发记录。 |

- 只处理匹配仓库 ID、仓库名及精确分支的普通 push。PR、Tag、分支删除和强推不触发自动发布。
- 启用时记录基准 SHA，不因重投启用前的当前提交立刻上线；处理事件及上传前再次检查是否仍为受保护分支的最新提交。
- 原始请求签名验证后才解析业务数据。相同 delivery ID 对应不同内容会被拒绝；同一项目配置版本、同一提交即使更换 delivery ID，也只创建一次部署批次。
- 事件与发布任务分开保存。接收成功、触发成功、最终部署成功是三个不同结果；未通过预检查不能创建任务。
- 目标忙碌时 30 秒后再检查；超过 120 次处理或 24 小时后停止。失败事件不盲目重复发布，需修正配置并重新授权，或由用户手动部署。
- 编辑源码或实际修改目标时暂停自动规则；无修改的目标重复保存不会暂停规则。关闭操作允许在发布运行期间执行，阻止尚未开始上传的自动任务；已开始的外部发布不能保证撤回，需另行取消或对账。
- `.data` 中已有本地数据库会自动增加事件表；旧项目没有 `revision` 时按 r0 读取，无需清空已有数据。当前仍没有完整数据库迁移管理器。
- Webhook 云端必须可访问 HTTPS 服务。本地地址只适合开发与测试，不能为接收回调而公开免登录模式。

### 13.6 使用独立预览端口

如果 3000 已由其他项目占用，可以不停止该项目，另起本控制台：

```bash
CONSOLE_PORT=3100 CONSOLE_ORIGIN=http://localhost:3100 npm run dev
PLAYWRIGHT_BASE_URL=http://localhost:3100 npm run test:e2e
```

如 API 端口也被占用，额外设置 `API_PORT`。端到端测试只清理其本次创建的项目 ID，不按项目名称批量删除已有项目。自动部署单元测试使用隔离数据库和模拟平台响应，不会触发真实 GitHub/Vercel 发布；真实回调与发布仍需账号联调。
