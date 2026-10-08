import { providerRequest, ProviderError } from '../security/http';
import type { Deployment, Target } from '../domain';
export interface VercelDeployment {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  state?: string;
  meta?: Record<string, string>;
}
export interface VercelProject {
  id: string;
  name: string;
  link?: unknown;
  rootDirectory?: string | null;
  targets?: { production?: VercelDeployment };
}
export class VercelAdapter {
  constructor(
    private token: string,
    readonly target: Target,
  ) {}
  private url(path: string, query: Record<string, string> = {}) {
    const url = new URL(path, 'https://api.vercel.com');
    if (this.target.config.teamId) url.searchParams.set('teamId', this.target.config.teamId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.href;
  }
  project() {
    return providerRequest<VercelProject>(
      this.url(`/v9/projects/${encodeURIComponent(this.target.config.projectId)}`),
      { token: this.token },
    );
  }
  async validate() {
    const project = await this.project();
    if (project.link)
      throw new ProviderError('请使用未连接 Git 自动部署的专用 Vercel 项目，避免重复发布');
    if (project.rootDirectory)
      throw new ProviderError('Vercel 项目的 Root Directory 必须留空；源码子目录由本平台截取');
    return project;
  }
  create(job: Deployment, files: { file: string; data: string; encoding: 'base64' }[]) {
    return providerRequest<VercelDeployment>(this.url('/v13/deployments'), {
      token: this.token,
      method: 'POST',
      body: {
        name: `launchdeck-${job.project.id.slice(0, 8)}`,
        project: this.target.config.projectId,
        files,
        ...(this.target.environment === 'production' ? { target: 'production' } : {}),
        projectSettings: { framework: job.project.template === 'web-next' ? 'nextjs' : 'vite' },
        meta: { launchdeckId: job.id, launchdeckCommit: job.sha, launchdeckVersion: job.version },
      },
    });
  }
  get(id: string) {
    return providerRequest<VercelDeployment>(
      this.url(`/v13/deployments/${encodeURIComponent(id)}`),
      { token: this.token },
    );
  }
  async find(jobId: string) {
    const result = await providerRequest<{ deployments: VercelDeployment[] }>(
      this.url('/v6/deployments', { projectId: this.target.config.projectId, limit: '100' }),
      { token: this.token },
    );
    return result.deployments.find((d) => d.meta?.launchdeckId === jobId);
  }
  cancel(id: string) {
    return providerRequest<VercelDeployment>(
      this.url(`/v12/deployments/${encodeURIComponent(id)}/cancel`),
      { token: this.token, method: 'PATCH' },
    );
  }
  async rollback(id: string) {
    await providerRequest(
      this.url(
        `/v1/projects/${encodeURIComponent(this.target.config.projectId)}/rollback/${encodeURIComponent(id)}`,
      ),
      { token: this.token, method: 'POST' },
    );
    const project = await this.project();
    if ((project.targets?.production?.id || project.targets?.production?.uid) !== id)
      throw new ProviderError('回滚请求已提交，但生产目标尚未得到确认');
  }
  async verify(url: string) {
    if (!/^[a-z0-9-]+\.vercel\.app$/.test(url))
      throw new ProviderError('Vercel 返回的访问地址不符合预期');
    await providerRequest(`https://${url}/`, { siteCheck: true });
    return `https://${url}`;
  }
}
