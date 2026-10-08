import { createSign } from 'node:crypto';
import { providerRequest, ProviderError } from '../security/http';
import { branchSchema, rootDirSchema, repositorySchema, type TemplateId } from '../domain';

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}
export interface SourceTree {
  sha: string;
  files: TreeEntry[];
  repository: string;
  rootDir: string;
}
export interface Detection {
  sha: string;
  template: TemplateId | null;
  lockfile: boolean;
  files: number;
  manifest: boolean;
}
export class GitHubAdapter {
  private cached?: { token: string; until: number };
  constructor(private readonly localToken: () => Promise<string | undefined>) {}
  async token() {
    const {
      GITHUB_APP_ID: appId,
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_INSTALLATION_ID: installation,
    } = process.env;
    if (appId && privateKey && installation) {
      if (!/^\d+$/.test(appId) || !/^\d+$/.test(installation))
        throw new ProviderError('GitHub App 配置无效');
      if (this.cached && this.cached.until > Date.now()) return this.cached.token;
      const now = Math.floor(Date.now() / 1000);
      const payload = [
        Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 480, iss: appId })).toString(
          'base64url',
        ),
      ].join('.');
      const signature = createSign('RSA-SHA256')
        .update(payload)
        .sign(privateKey.replace(/\\n/g, '\n'), 'base64url');
      const response = await providerRequest<{ token: string }>(
        `https://api.github.com/app/installations/${installation}/access_tokens`,
        {
          method: 'POST',
          token: `${payload}.${signature}`,
          body: { permissions: { contents: 'read', metadata: 'read' } },
        },
      );
      this.cached = { token: response.token, until: Date.now() + 45 * 60 * 1000 };
      return response.token;
    }
    return this.localToken();
  }
  async get<T>(path: string): Promise<T> {
    return providerRequest<T>(`https://api.github.com${path}`, { token: await this.token() });
  }
  async branch(repository: string, branch: string) {
    const repo = repositorySchema.parse(repository);
    const [metadata, head] = await Promise.all([
      this.get<{ id: number; full_name: string }>(`/repos/${repo}`),
      this.get<{ protected: boolean; commit: { sha: string } }>(
        `/repos/${repo}/branches/${encodeURIComponent(branchSchema.parse(branch))}`,
      ),
    ]);
    if (
      !Number.isSafeInteger(metadata.id) ||
      metadata.id <= 0 ||
      metadata.full_name.toLowerCase() !== repo.toLowerCase() ||
      !/^[a-f0-9]{40}$/.test(head.commit.sha)
    )
      throw new ProviderError('仓库身份或分支信息不符合预期');
    return { repositoryId: metadata.id, sha: head.commit.sha, protected: head.protected === true };
  }
  async tree(repository: string, ref: string, rootDir: string): Promise<SourceTree> {
    const repo = repositorySchema.parse(repository);
    rootDirSchema.parse(rootDir);
    const commit = await this.get<{ sha: string }>(
      `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new ProviderError('GitHub 未返回有效 commit SHA');
    const tree = await this.get<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${repo}/git/trees/${commit.sha}?recursive=1`,
    );
    if (tree.truncated) throw new ProviderError('仓库目录过大，当前版本无法完整获取源码');
    const prefix = rootDir === '.' ? '' : `${rootDir}/`;
    const files: TreeEntry[] = [];
    for (const entry of tree.tree) {
      if (!entry.path.startsWith(prefix) || entry.type === 'tree') continue;
      const path = entry.path.slice(prefix.length);
      if (
        !path ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((p) => !p || p === '.' || p === '..')
      )
        throw new ProviderError('仓库包含不安全的文件路径');
      if (entry.mode === '120000' || entry.mode === '160000' || entry.type !== 'blob')
        throw new ProviderError('当前标准模板不支持符号链接或 Git 子模块');
      if (
        path
          .split('/')
          .some((part) => ['node_modules', '.git', '.vercel', '.next', 'build'].includes(part))
      )
        continue;
      if (/(^|\/)\.env($|\.)/.test(path) && !/\.example$/.test(path))
        throw new ProviderError('源码中存在环境机密文件，请移出仓库后再部署');
      files.push({ ...entry, path });
    }
    if (!files.length) throw new ProviderError('所选子目录没有可构建的源码');
    if (
      files.length > 300 ||
      files.reduce((total, f) => total + (f.size || 0), 0) > 5 * 1024 * 1024 ||
      files.some((f) => (f.size || 0) > 1024 * 1024)
    )
      throw new ProviderError(
        '当前源码快照限额：300 个文件、总计 5 MB、单文件 1 MB；请精简构建目录',
      );
    return { sha: commit.sha, files, repository: repo, rootDir };
  }
  async blob(repository: string, sha: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new ProviderError('文件摘要无效');
    const response = await this.get<{ content: string; encoding: string; size: number }>(
      `/repos/${repositorySchema.parse(repository)}/git/blobs/${sha}`,
    );
    if (response.encoding !== 'base64' || response.size > 1024 * 1024)
      throw new ProviderError('源码文件格式或大小不符合限制');
    const data = Buffer.from(response.content, 'base64');
    if (data.length !== response.size) throw new ProviderError('源码文件长度校验失败');
    return data;
  }
  async detectTree(tree: SourceTree): Promise<Detection> {
    const read = async (name: string) => {
      const item = tree.files.find((f) => f.path === name);
      return item ? (await this.blob(tree.repository, item.sha)).toString('utf8') : undefined;
    };
    let template: TemplateId | null = null;
    const packageText = await read('package.json');
    if (packageText) {
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(packageText);
      } catch {
        throw new ProviderError('package.json 不是合法 JSON');
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['@tarojs/taro'] && deps.react) template = 'miniapp-taro';
      else if (deps.next && deps.react) template = 'web-next';
      else if (deps.vite && deps.react) template = 'web-vite';
    }
    if (!template) {
      const pubspec = await read('pubspec.yaml');
      if (pubspec && /sdk:\s*flutter\b/.test(pubspec)) template = 'app-flutter';
    }
    const manifest = await read('deploy.config.json');
    if (manifest) {
      let config: { schemaVersion?: number; templateId?: string; templateVersion?: string };
      try {
        config = JSON.parse(manifest);
      } catch {
        throw new ProviderError('deploy.config.json 不是合法 JSON');
      }
      if (
        config.schemaVersion !== 1 ||
        config.templateVersion !== '1.0.0' ||
        config.templateId !== template
      )
        throw new ProviderError('部署声明与识别模板不一致，或声明版本不受支持');
    }
    return {
      sha: tree.sha,
      template,
      lockfile: tree.files.some((f) =>
        ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pubspec.lock'].includes(f.path),
      ),
      files: tree.files.length,
      manifest: Boolean(manifest),
    };
  }
  async detect(repository: string, ref: string, rootDir: string) {
    return this.detectTree(await this.tree(repository, ref, rootDir));
  }
  async snapshot(tree: SourceTree) {
    const files: { file: string; data: string; encoding: 'base64' }[] = [];
    for (const item of tree.files)
      files.push({
        file: item.path,
        data: (await this.blob(tree.repository, item.sha)).toString('base64'),
        encoding: 'base64',
      });
    return files;
  }
}
