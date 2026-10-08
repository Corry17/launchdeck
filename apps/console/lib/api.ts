import type {
  Project,
  Deployment,
  Credential,
  AuditEntry,
  Capability,
  Role,
  WebhookRun,
} from '../../../packages/domain';
let csrf = '';
export interface User {
  name: string;
  role: Role;
  csrf: string;
}
export interface Session {
  user: User | null;
  mode: 'local' | 'production';
  oauthConfigured: boolean;
}
export interface DashboardData {
  projects: Project[];
  deployments: Deployment[];
  credentials: Credential[];
  audit: AuditEntry[];
  capabilities: Capability[];
  webhookRuns: WebhookRun[];
  system: {
    mode: string;
    database: string;
    queue: string;
    githubApp: boolean;
    webhookConfigured: boolean;
    webhookUrl: string;
  };
}
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-Token': csrf,
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  let data: T & { message?: string | string[] };
  try {
    data = await response.json();
  } catch {
    throw new Error('服务暂时不可用，请检查 API 是否已启动');
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined')
      window.dispatchEvent(new Event('session-expired'));
    throw new Error(
      Array.isArray(data.message)
        ? data.message.join('；')
        : data.message || '操作未完成，请稍后重试',
    );
  }
  return data;
}
export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
