import { z } from 'zod';

export const productTypes = ['web', 'miniapp', 'app'] as const;
export const providers = ['vercel', 'docker', 'wechat', 'android', 'ios'] as const;
export type ProductType = (typeof productTypes)[number];
export type Provider = (typeof providers)[number];
export type Role = 'Owner' | 'Maintainer' | 'Viewer';
export type Status =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_EXTERNAL'
  | 'WAITING_MANUAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'UNKNOWN';
export type Stage = 'PREFLIGHT' | 'FETCH' | 'BUILD' | 'SIGN' | 'UPLOAD' | 'VERIFY' | 'DISTRIBUTE';
export const activeStatuses: Status[] = [
  'QUEUED',
  'RUNNING',
  'WAITING_EXTERNAL',
  'WAITING_MANUAL',
  'CANCEL_REQUESTED',
  'UNKNOWN',
];
export const statusLabels: Record<Status, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING_EXTERNAL: '等待平台处理',
  WAITING_MANUAL: '等待人工确认',
  SUCCEEDED: '已完成',
  FAILED: '未完成',
  CANCEL_REQUESTED: '正在取消',
  CANCELLED: '已取消',
  UNKNOWN: '结果待核实',
};
export const stageLabels: Record<Stage, string> = {
  PREFLIGHT: '预检查',
  FETCH: '获取源码',
  BUILD: '构建',
  SIGN: '签名',
  UPLOAD: '上传',
  VERIFY: '验证',
  DISTRIBUTE: '分发',
};
export const templates = [
  {
    id: 'web-vite',
    name: 'React + Vite',
    type: 'web',
    description: '轻量前端、静态站点',
    providers: ['vercel', 'docker'],
  },
  {
    id: 'web-next',
    name: 'Next.js',
    type: 'web',
    description: '全栈应用、服务端渲染',
    providers: ['vercel', 'docker'],
  },
  {
    id: 'miniapp-taro',
    name: 'Taro React',
    type: 'miniapp',
    description: '微信小程序标准模板',
    providers: ['wechat'],
  },
  {
    id: 'app-flutter',
    name: 'Flutter',
    type: 'app',
    description: 'Android 与 iOS 双端应用',
    providers: ['android', 'ios'],
  },
] as const;
export type TemplateId = (typeof templates)[number]['id'];
export const providerLabels: Record<Provider, string> = {
  vercel: 'Vercel',
  docker: '自有服务器',
  wechat: '微信小程序',
  android: 'Android',
  ios: 'iOS · TestFlight',
};
export const productLabels: Record<ProductType, string> = {
  web: 'Web 网页',
  miniapp: '小程序',
  app: '移动 App',
};
export const rootDirSchema = z
  .string()
  .max(160)
  .default('.')
  .refine(
    (value) =>
      value === '.' ||
      (/^[a-zA-Z0-9_./-]+$/.test(value) &&
        !value.startsWith('/') &&
        value.split('/').every((p) => p !== '..' && p !== '.' && p !== '')),
    '子目录必须是仓库内的相对路径，不能包含 ..',
  );
export const repositorySchema = z
  .string()
  .trim()
  .max(240)
  .transform((value) => {
    const match =
      /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9_.-]{1,100})\/?$/.exec(
        value,
      );
    if (!match || match[2] === '.' || match[2] === '..') return '';
    return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  })
  .refine(Boolean, '请输入 GitHub 仓库地址或 owner/repo，不支持其他主机');
export const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_./-]+$/)
  .refine(
    (v) =>
      !v.includes('..') &&
      !v.startsWith('-') &&
      !v.startsWith('/') &&
      !v.endsWith('/') &&
      !v.endsWith('.') &&
      !v.includes('//') &&
      v.split('/').every((p) => !p.startsWith('.') && !p.endsWith('.lock')),
    '分支名称无效',
  );
export const projectEditSchema = z
  .object({
    name: z.string().trim().min(1, '请输入项目名称').max(60),
    repository: repositorySchema,
    branch: branchSchema,
    rootDir: rootDirSchema,
    revision: z.number().int().min(0),
  })
  .strict();
export const automationSchema = z
  .object({
    enabled: z.boolean(),
    targetIds: z.array(z.string().uuid()).max(2),
    version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    confirmProduction: z.boolean().default(false),
    revision: z.number().int().min(0),
  })
  .strict()
  .refine((v) => !v.enabled || v.targetIds.length > 0, '请至少选择一个自动部署目标');
export const webhookStatusLabels = {
  ACCEPTED: '已接收',
  PROCESSING: '预检查中',
  DEFERRED: '等待前次部署',
  CREATED: '已创建部署',
  SKIPPED: '已跳过',
  FAILED: '触发失败',
} as const;
export interface Automation {
  enabled: boolean;
  targetIds: string[];
  version: string;
  confirmProduction: boolean;
  repositoryId: number;
  baselineSha: string;
  enabledAt: string;
  configuredBy: string;
}
export interface WebhookRun {
  id: string;
  deliveryId: string;
  projectId: string;
  projectName: string;
  repositoryId: number;
  sha: string;
  ref: string;
  revision: number;
  status: keyof typeof webhookStatusLabels;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  message: string;
  deploymentIds?: string[];
}
export const projectSchema = z
  .object({
    name: z.string().trim().min(1, '请输入项目名称').max(60),
    repository: repositorySchema,
    branch: branchSchema,
    rootDir: rootDirSchema,
    type: z.enum(productTypes),
    template: z.enum(['web-vite', 'web-next', 'miniapp-taro', 'app-flutter']),
  })
  .strict()
  .refine(
    (p) => templates.some((t) => t.id === p.template && t.type === p.type),
    '产品类型与模板不匹配',
  );
export const detectSchema = z
  .object({
    repository: repositorySchema,
    branch: branchSchema.default('main'),
    rootDir: rootDirSchema,
  })
  .strict();
export const targetSchema = z
  .object({
    provider: z.enum(providers),
    environment: z.enum(['preview', 'production', 'testing']).default('testing'),
    credentialId: z.string().uuid().optional(),
    config: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), z.string().max(500)).default({}),
  })
  .strict();
export const releaseSchema = z
  .object({
    projectId: z.string().uuid(),
    targetIds: z.array(z.string().uuid()).min(1).max(2),
    version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, '版本号格式应为 1.0.0'),
    confirmProduction: z.boolean().default(false),
  })
  .strict();
export const credentialKinds = ['github', ...providers] as const;
export type CredentialKind = (typeof credentialKinds)[number];
export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(credentialKinds),
    values: z.record(z.string().max(40), z.string().min(1).max(128000)),
  })
  .strict();
export type FieldSpec = {
  key: string;
  label: string;
  placeholder: string;
  help?: string;
  multiline?: boolean;
};
export const credentialFields: Record<CredentialKind, FieldSpec[]> = {
  github: [
    {
      key: 'token',
      label: '只读 GitHub Token',
      placeholder: '仅用于本地私有仓库联调',
      help: '生产环境使用服务端配置的 GitHub App。令牌至少需要对应仓库的 Contents 读取权限。',
    },
  ],
  vercel: [{ key: 'token', label: 'Vercel Access Token', placeholder: '输入目标团队的访问令牌' }],
  docker: [
    {
      key: 'privateKey',
      label: 'SSH 私钥',
      placeholder: '专用 deployer 身份的私钥',
      multiline: true,
    },
  ],
  wechat: [
    {
      key: 'privateKey',
      label: '代码上传私钥',
      placeholder: '从微信公众平台下载的上传密钥',
      multiline: true,
    },
  ],
  android: [
    {
      key: 'keystore',
      label: 'Keystore（Base64）',
      placeholder: '发布签名文件的 Base64 内容',
      multiline: true,
    },
    { key: 'storePassword', label: 'Keystore 密码', placeholder: '输入密码' },
    { key: 'keyAlias', label: 'Key Alias', placeholder: '发布密钥别名' },
    { key: 'keyPassword', label: 'Key 密码', placeholder: '输入密码' },
  ],
  ios: [
    {
      key: 'apiKey',
      label: 'App Store Connect .p8',
      placeholder: 'API Key 文件内容',
      multiline: true,
    },
    { key: 'keyId', label: 'Key ID', placeholder: 'API Key 标识' },
    { key: 'issuerId', label: 'Issuer ID', placeholder: '发行者标识' },
    {
      key: 'certificate',
      label: '发行证书 .p12（Base64）',
      placeholder: '需包含私钥',
      multiline: true,
    },
    { key: 'password', label: '证书密码', placeholder: '输入密码' },
    {
      key: 'profile',
      label: '描述文件（Base64）',
      placeholder: '匹配 Bundle ID 的描述文件',
      multiline: true,
    },
  ],
};
export const targetFields: Record<Provider, FieldSpec[]> = {
  vercel: [
    {
      key: 'projectId',
      label: 'Vercel Project ID',
      placeholder: 'prj_…',
      help: '使用专用项目，不同时开启 Git 自动部署。',
    },
    { key: 'teamId', label: 'Team ID（可选）', placeholder: 'team_…' },
  ],
  docker: [
    { key: 'host', label: '服务器地址', placeholder: 'deploy.example.com' },
    { key: 'hostKey', label: 'SSH 主机密钥指纹', placeholder: 'SHA256:…' },
    { key: 'domain', label: '站点域名', placeholder: 'app.example.com' },
  ],
  wechat: [
    { key: 'appId', label: '小程序 AppID', placeholder: 'wx…' },
    { key: 'robot', label: 'CI 机器人编号', placeholder: '1' },
  ],
  android: [{ key: 'applicationId', label: 'Application ID', placeholder: 'com.example.app' }],
  ios: [
    { key: 'bundleId', label: 'Bundle ID', placeholder: 'com.example.app' },
    { key: 'teamId', label: 'Apple Team ID', placeholder: '开发者团队 ID' },
    { key: 'appId', label: 'App Store Connect App ID', placeholder: '数字应用 ID' },
    { key: 'groupId', label: 'TestFlight 内部测试组 ID', placeholder: '已有测试组标识' },
  ],
};
export const prerequisites: Record<Provider, string[]> = {
  vercel: ['Vercel 目标项目与有效 Token', '已授权的 GitHub 仓库', '兼容的 Web 模板及依赖锁文件'],
  docker: [
    '已初始化 Docker / Caddy 的 Linux 主机',
    '受限 deployer 与固定 SSH 主机密钥',
    '隔离发布 Worker 和域名 HTTPS',
  ],
  wechat: ['AppID 与代码上传私钥', '固定出口 IP 已加入微信白名单', '人工设置体验版与测试成员'],
  android: ['Flutter Linux 构建节点', '独立可信签名任务与发布 Keystore', '受控产物存储与测试设备'],
  ios: [
    'Apple Developer Program 与 macOS 构建资源',
    '发行证书、描述文件与 API Key',
    'TestFlight 应用和内部测试组',
  ],
};
export interface Project extends z.infer<typeof projectSchema> {
  id: string;
  createdAt: string;
  targets: Target[];
  revision?: number;
  updatedAt?: string;
  automation?: Automation;
}
export interface Target extends z.infer<typeof targetSchema> {
  id: string;
  projectId: string;
}
export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  fingerprint: string;
  createdAt: string;
  verifiedAt?: string;
}
export interface Check {
  key: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}
export interface Preflight {
  projectId: string;
  targetId: string;
  sha?: string;
  checks: Check[];
  ready: boolean;
}
export interface Deployment {
  id: string;
  batchId: string;
  projectId: string;
  projectName: string;
  target: Target;
  project: Project;
  sha: string;
  version: string;
  status: Status;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  externalId?: string;
  url?: string;
  error?: string;
  credentialVersion?: string;
  previousDeploymentId?: string;
  trigger?: { kind: 'manual' | 'github'; deliveryId?: string; webhookRunId?: string };
}
export interface DeploymentEvent {
  sequence: number;
  deploymentId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  action: string;
  subject: string;
  actor: string;
  createdAt: string;
}
export interface Capability {
  provider: Provider;
  executable: boolean;
  label: string;
  detail: string;
}
export const capabilities: Capability[] = [
  {
    provider: 'vercel',
    executable: true,
    label: '可接入',
    detail: '真实 API 适配器：固定源码、部署、状态同步与取消。需完成账号配置。',
  },
  {
    provider: 'docker',
    executable: false,
    label: '待接入执行器',
    detail: '配置与预检查已实现；隔离发布 Worker、受限主机 helper 和切流链路尚未接入。',
  },
  {
    provider: 'wechat',
    executable: false,
    label: '待接入执行器',
    detail: '配置与预检查已实现；固定 IP 上传节点与体验状态联调尚未接入。',
  },
  {
    provider: 'android',
    executable: false,
    label: '待接入执行器',
    detail: '配置与预检查已实现；Flutter 构建、独立签名和产物分发执行器尚未接入。',
  },
  {
    provider: 'ios',
    executable: false,
    label: '待接入执行器',
    detail: '配置与预检查已实现；macOS archive 独立签名和 TestFlight 账号联调尚未接入。',
  },
];
export function canUseProvider(template: TemplateId, provider: Provider) {
  return (
    (
      templates.find((t) => t.id === template)?.providers as readonly string[] | undefined
    )?.includes(provider) ?? false
  );
}
export function aggregateStatus(items: Pick<Deployment, 'status'>[]): string {
  if (!items.length) return 'EMPTY';
  if (items.every((d) => d.status === 'SUCCEEDED')) return 'SUCCEEDED';
  if (items.some((d) => activeStatuses.includes(d.status))) return 'IN_PROGRESS';
  if (items.some((d) => d.status === 'SUCCEEDED')) return 'PARTIAL_SUCCESS';
  return items.every((d) => d.status === 'CANCELLED') ? 'CANCELLED' : 'FAILED';
}
export function assertTransition(from: Status, to: Status) {
  if (from === to) return;
  const next: Record<Status, Status[]> = {
    QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
    RUNNING: [
      'WAITING_EXTERNAL',
      'WAITING_MANUAL',
      'SUCCEEDED',
      'FAILED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'UNKNOWN',
    ],
    WAITING_EXTERNAL: [
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'UNKNOWN',
    ],
    WAITING_MANUAL: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    CANCEL_REQUESTED: ['CANCELLED', 'SUCCEEDED', 'FAILED', 'UNKNOWN'],
    UNKNOWN: ['WAITING_EXTERNAL', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED'],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
  };
  if (!next[from].includes(to)) throw new Error(`不能从 ${from} 转换到 ${to}`);
}
