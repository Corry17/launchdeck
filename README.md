# Launchdeck · 多端产品自动化部署平台

从 GitHub 源码到可访问的产品：面向个人与小团队的统一部署控制台，支持 Web 网页、微信小程序与移动 App 三类产品的构建、发布与测试分发。

> 当前状态：v0.1 开发版本。Web + Vercel 已完成真实 API 适配器与自动化触发链路；自有服务器、微信小程序、Android、iOS 的配置、凭据与预检查已实现，但构建/签名/上传执行器尚未接入。**页面不会用假日志或动画冒充真实发布**，未接通的能力会在预检查阶段被明确拦截。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 项目导入 | 从 GitHub 公有/私有仓库导入，按子目录区分同仓库内的多个产品 |
| 模板识别 | 自动识别 React + Vite、Next.js、Taro 微信小程序、Flutter 四类标准模板，并与 `deploy.config.json` 声明交叉校验 |
| 发布目标 | 每个项目独立配置目标平台、环境、凭据与参数，Flutter 项目可同时保存 Android 与 iOS 目标 |
| 服务端预检查 | 校验模板兼容性、依赖锁文件、目标必填项、凭据、执行器能力与平台授权，通过后才允许创建任务 |
| 异步部署编排 | 固定 commit SHA、幂等键、目标互斥、租约与重启恢复、SSE 实时事件、单目标重试与取消 |
| GitHub 自动部署 | 受保护分支 push 事件验签、去重、旧提交拦截，Owner 逐项目授权；生产目标需单独持续授权 |
| 凭据保险箱 | AES-256-GCM 加密，密文与工作区/平台/凭据 ID 绑定；保存后仅返回指纹，界面不回显原文 |
| 结果可解释 | 上传成功、平台构建成功、站点验证通过、测试渠道可用分别记录，不把“已上传”当作“已上线” |

## 架构

```text
浏览器控制台（Next.js）
    │ HTTPS / REST / SSE
控制 API（NestJS）── PostgreSQL：项目、任务、状态、审计、Webhook 收件箱
    │
    ├──── 任务队列：BullMQ（可选 Redis）+ 数据库 outbox
    ├──── GitHub Webhook：原始请求体 HMAC 验签 → 持久化 → 异步触发
    ├──── GitHub 适配器：App JWT / 只读令牌，固定 SHA 读取源码
    └──── Vercel 适配器：文件快照部署、状态同步、取消、失联对账、条件回滚
```

三层信任边界：控制面不执行产品源码；构建面（规划中）可执行依赖但读不到发布凭据；签名/发布面只处理校验过的产物。

## 目录结构

```text
apps/console/         Next.js 控制台：工作台、项目、部署记录、集成与凭据、操作审计、工作区设置
apps/api/             NestJS 控制面：鉴权、项目、凭据、预检查、发布、部署事件、GitHub Webhook
packages/domain/      领域模型：类型、Zod 校验、状态机、模板与平台能力声明
packages/database/    PostgreSQL / PGlite 持久化：事务、幂等、outbox、租约、Webhook 收件箱
packages/security/    凭据加密（AES-256-GCM）、路径校验、SSRF 防护的 HTTPS 客户端
packages/adapters/    GitHub 与 Vercel 平台适配器
packages/ui/          共享界面组件
tests/                单元 / API / Webhook 测试（node:test）与 Playwright 端到端测试
docs/                 技术设计文档与实现记录
```

## 快速开始

需要 Node.js 22+ 与 npm，默认不需要 Docker：本地会使用内嵌 PostgreSQL（PGlite）。

```bash
npm install
npm run dev
```

- 控制台：`http://localhost:3000`，API：`http://127.0.0.1:4310`
- 浏览器访问地址必须与 `CONSOLE_ORIGIN` 一致，否则请求会被来源校验拒绝
- 端口冲突时可换端口：`CONSOLE_PORT=3100 CONSOLE_ORIGIN=http://localhost:3100 npm run dev`
- 本地模式仅监听回环地址，并自动进入 Owner 工作区；该免登录模式**不可**暴露到公网
- 首次启动会在 `.data/master.key` 生成加密主密钥（权限 0600），`.data/` 已被 Git 忽略，请勿分发或提交

## 配置

复制 `.env.example` 为 `.env` 后按需填写，不要提交真实密钥。

| 变量 | 作用 |
| --- | --- |
| `APP_MODE` / `CONSOLE_ORIGIN` | 运行模式与允许的控制台来源（生产必须 HTTPS 且与访问地址完全一致） |
| `API_PORT` / `CONSOLE_PORT` | API 与控制台端口 |
| `DATABASE_URL` | 留空使用内嵌 PGlite；填写后连接独立 PostgreSQL |
| `REDIS_URL` | 留空使用数据库 outbox 调度；填写后同时投递 BullMQ |
| `MASTER_KEY_BASE64` | 生产必须显式提供的 32 字节 Base64 主密钥 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth 登录 |
| `ALLOWED_GITHUB_IDS` | 邀请名单，格式 `数字ID:Owner,数字ID:Maintainer,数字ID:Viewer` |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID` | 生产读取私有仓库的 GitHub App |
| `GITHUB_WEBHOOK_SECRET` | 至少 32 字符，与 GitHub 仓库 Webhook Secret 完全一致 |

## 配置 GitHub 自动部署

1. 在控制台完成项目的 Vercel 目标与凭据配置，确保预检查通过
2. 管理员配置 `GITHUB_WEBHOOK_SECRET` 并重启 API（密钥只在服务端，界面与日志均不回显）
3. 在 GitHub 仓库 **Settings → Webhooks** 添加 `CONSOLE_ORIGIN/api/hooks/github`，Content type 选 `application/json`，事件仅选 push，Secret 与服务端一致，保持 SSL verification 开启
4. 为部署分支启用分支保护（平台读取 `protected` 状态，但不会替你修改仓库规则）
5. 在项目卡片的 **项目设置 → 自动部署** 选择目标并开启；生产目标需再次勾选持续自动发布授权，开启本身不会立即触发一次部署
6. 新提交落地后，在 **部署记录 → GitHub 自动触发** 查看事件结果，并进入关联部署查看最终发布状态

自动触发的安全边界：只处理匹配仓库 ID、仓库名与精确分支的普通 push；PR、Tag、删除与强推一律忽略；启用时记录基准 SHA，不因事件重投立即上线；同一提交即使更换 delivery ID 也只创建一次部署；处理事件与上传前都会复核分支保护与开关状态，排队期间关闭规则会在上传前阻止任务，但已发生的外部发布不保证撤回。

## 验证

```bash
npm run typecheck        # 全仓类型检查
npm test                 # 单元 / API / Webhook 测试（36 项）
npm run build            # 类型检查 + 控制台生产构建
npm run format:check     # Prettier 一致性
npm run audit:production # 生产依赖高危漏洞检查

# 端到端测试（需先启动 npm run dev）
PLAYWRIGHT_BROWSERS_PATH=.data/browsers npm exec -- playwright install chromium --no-shell
PLAYWRIGHT_BASE_URL=http://localhost:3100 npm run test:e2e
```

端到端测试只创建并删除本次运行的项目，不添加真实凭据、不请求外部发布；自动部署测试使用隔离数据库与模拟平台响应。真实发布链路仍需自备账号联调。

## 安全设计要点

- 凭据使用 AES-256-GCM 加密，密文与工作区、平台、凭据 ID 绑定（AAD），保存后不可回读原文
- 所有出站请求走白名单客户端：仅允许 `api.github.com`、`api.vercel.com` 与 `*.vercel.app`，校验 DNS 解析结果必须为单播地址，拒绝回环、私网与云元数据地址，不跟随重定向
- GitHub Webhook 使用原始请求体 HMAC-SHA256 验签并做常量时间比较，随后按 delivery ID 去重
- 写接口要求同源校验 + CSRF Token + 对象级权限校验，按成员角色区分 Owner / Maintainer / Viewer
- 源码快照限制为 300 个文件、总量 5 MB、单文件 1 MB；拒绝符号链接、Git 子模块、可疑路径与仓库内的环境机密文件
- 错误响应统一脱敏，界面与日志不回显密钥、令牌与签名 URL

## 当前边界

- 已完成真实执行链路的只有 **Vercel**；自有服务器（Docker）、微信小程序、Android、iOS 目前仅支持配置、凭据与预检查
- 源码快照在内存中通过受限 GitHub Blob API 收集，尚未接入对象存储与大仓库分块上传
- 编排器与 API 同进程运行，尚未拆分为独立 orchestrator / publisher 服务
- 数据库使用参数化 SQL，尚未引入 Prisma 与版本化迁移工具
- 未包含：小程序提审与发布、应用商店上架、自动计费与配额、产物清理、主密钥轮换工具

详细设计与实现记录见 [docs/technical-design.md](docs/technical-design.md)。

## 技术栈

TypeScript · Node.js 22+ · Next.js 16 + React 19 · NestJS 11 · PostgreSQL / PGlite · Redis + BullMQ（可选）· Zod · Tailwind CSS 4 · Playwright
