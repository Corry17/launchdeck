import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreConflict } from '../../../packages/database';
import { Vault, hash, publicError, type Envelope } from '../../../packages/security';
import { GitHubAdapter } from '../../../packages/adapters/github';
import { VercelAdapter } from '../../../packages/adapters/vercel';
import { providerRequest } from '../../../packages/security/http';
import {
  capabilities,
  canUseProvider,
  credentialFields,
  credentialSchema,
  projectSchema,
  projectEditSchema,
  automationSchema,
  targetSchema,
  targetFields,
  releaseSchema,
  activeStatuses,
  type Credential,
  type CredentialKind,
  type Project,
  type Target,
  type Preflight,
  type Deployment,
} from '../../../packages/domain';

export interface StoredCredential extends Credential {
  envelope: Envelope;
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
    );
  return result.data;
}
export class AppService {
  readonly github: GitHubAdapter;
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly local: boolean,
  ) {
    this.github = new GitHubAdapter(async () => {
      if (!this.local) return undefined;
      const credential = (await this.store.list<StoredCredential>('credential')).find(
        (c) => c.kind === 'github',
      );
      return credential
        ? this.vault.open(credential.envelope, this.context(credential)).token
        : undefined;
    });
  }
  context(c: { id: string; kind: string }) {
    return `${this.store.workspace}:${c.kind}:${c.id}`;
  }
  async project(id: string) {
    const project = await this.store.get<Project>('project', id);
    if (!project) throw new NotFoundException('项目不存在');
    return project;
  }
  async createProject(body: unknown, actor: string) {
    const input = parse(projectSchema, body);
    if ((await this.store.list('project')).length >= 100)
      throw new BadRequestException('当前工作区最多保存 100 个项目');
    const project: Project = {
      ...input,
      id: randomUUID(),
      targets: [],
      revision: 0,
      createdAt: new Date().toISOString(),
    };
    await this.store.put('project', project);
    await this.store.audit('创建项目', project.name, actor);
    return project;
  }
  async deleteProject(id: string, actor: string) {
    await this.project(id);
    return this.store.deleteProject(id, actor);
  }
  webhookConfigured() {
    return (process.env.GITHUB_WEBHOOK_SECRET?.length ?? 0) >= 32;
  }
  async editProject(id: string, body: unknown, actor: string) {
    const input = parse(projectEditSchema, body);
    return this.store.changeProject(
      id,
      input.revision,
      async (current) => ({
        ...current,
        name: input.name,
        repository: input.repository,
        branch: input.branch,
        rootDir: input.rootDir,
        automation: current.automation ? { ...current.automation, enabled: false } : undefined,
      }),
      actor,
      '更新源码配置（自动部署已暂停）',
    );
  }
  async configureAutomation(id: string, body: unknown, actor: string) {
    const input = parse(automationSchema, body);
    const project = await this.project(id);
    if ((project.revision ?? 0) !== input.revision)
      throw new StoreConflict('CONFIG_CHANGED', '项目配置已变化，请刷新后重试');
    if (!input.enabled)
      return this.store.changeProject(
        id,
        input.revision,
        async (current) => ({
          ...current,
          automation: current.automation ? { ...current.automation, enabled: false } : undefined,
        }),
        actor,
        '关闭自动部署',
        true,
      );
    if (!this.webhookConfigured())
      throw new BadRequestException('服务端尚未配置至少 32 字符的 GitHub Webhook Secret');
    const targets = project.targets.filter((t) => input.targetIds.includes(t.id));
    if (
      project.type !== 'web' ||
      !targets.length ||
      targets.length !== input.targetIds.length ||
      targets.some((t) => t.provider !== 'vercel')
    )
      throw new BadRequestException('当前自动部署仅支持已配置的 Vercel 目标');
    if (targets.some((t) => t.environment === 'production') && !input.confirmProduction)
      throw new BadRequestException('生产自动部署需要 Owner 明确授权');
    const branch = await this.github.branch(project.repository, project.branch);
    if (!branch.protected)
      throw new BadRequestException('请先在 GitHub 为该分支启用保护规则，再开启自动部署');
    const checks = await this.preflightProject(project, input.targetIds, branch.sha);
    if (checks.some((c) => !c.ready))
      throw new BadRequestException({ message: '预检查未通过，不能开启自动部署', checks });
    return this.store.changeProject(
      id,
      input.revision,
      async (current) => ({
        ...current,
        automation: {
          enabled: true,
          targetIds: input.targetIds,
          version: input.version,
          confirmProduction: input.confirmProduction,
          repositoryId: branch.repositoryId,
          baselineSha: branch.sha,
          enabledAt: new Date().toISOString(),
          configuredBy: actor,
        },
      }),
      actor,
      '开启受保护分支自动部署',
    );
  }
  async saveTargets(id: string, body: unknown, actor: string) {
    const input = parse(
      z.union([
        z.array(targetSchema).min(1).max(2),
        z
          .object({
            targets: z.array(targetSchema).min(1).max(2),
            revision: z.number().int().min(0),
          })
          .strict(),
      ]),
      body,
    );
    const inputs = Array.isArray(input) ? input : input.targets;
    const project = await this.project(id);
    if (!Array.isArray(input) && input.revision !== (project.revision ?? 0))
      throw new StoreConflict('CONFIG_CHANGED', '项目配置已变化，请关闭向导并重新打开');
    if (
      inputs.some((t) => !canUseProvider(project.template, t.provider)) ||
      new Set(inputs.map((t) => t.provider)).size !== inputs.length
    )
      throw new BadRequestException('目标重复或与产品模板不兼容');
    if (project.type !== 'app' && inputs.length > 1)
      throw new BadRequestException('每次配置只选择一个 Web 或微信目标');
    if (await this.store.hasActiveProject(id))
      throw new ConflictException('项目有未结束的部署，暂不能修改目标');
    const targets: Target[] = [];
    for (const target of inputs) {
      const allowed = new Set(targetFields[target.provider].map((f) => f.key));
      if (Object.keys(target.config).some((key) => !allowed.has(key)))
        throw new BadRequestException('目标包含不允许的配置字段');
      if (target.credentialId) {
        const credential = await this.store.get<StoredCredential>(
          'credential',
          target.credentialId,
        );
        if (!credential || credential.kind !== target.provider)
          throw new BadRequestException('凭据不存在或类型不匹配');
      }
      if (['vercel', 'docker'].includes(target.provider) === (target.environment === 'testing'))
        throw new BadRequestException('Web 使用预览/生产环境，移动端使用测试环境');
      targets.push({
        ...target,
        id: project.targets.find((t) => t.provider === target.provider)?.id || randomUUID(),
        projectId: project.id,
      });
    }
    const unchanged =
      project.targets.length === targets.length &&
      project.targets.every((old) => {
        const next = targets.find((t) => t.id === old.id);
        return (
          next &&
          next.provider === old.provider &&
          next.environment === old.environment &&
          next.credentialId === old.credentialId &&
          Object.keys(next.config).length === Object.keys(old.config).length &&
          Object.entries(old.config).every(([key, value]) => next.config[key] === value)
        );
      });
    if (unchanged) return project;
    return this.store.changeProject(
      id,
      project.revision ?? 0,
      async (current, q) => {
        for (const target of targets) {
          if (target.credentialId && !(await this.store.get('credential', target.credentialId, q)))
            throw new StoreConflict('CONFIG_CHANGED', '凭据已撤销，请重新选择');
        }
        return {
          ...current,
          targets,
          automation: current.automation ? { ...current.automation, enabled: false } : undefined,
        };
      },
      actor,
      '更新发布目标（自动部署已暂停）',
    );
  }
  async credentials() {
    return (await this.store.list<StoredCredential>('credential')).map(
      ({ envelope: _, ...metadata }) => metadata,
    );
  }
  async saveCredential(body: unknown, actor: string) {
    const input = parse(credentialSchema, body);
    if (input.kind === 'github' && !this.local)
      throw new ForbiddenException('生产环境使用 GitHub App，不保存个人访问令牌');
    const fields = credentialFields[input.kind];
    if (
      fields.some((f) => !input.values[f.key]?.trim()) ||
      Object.keys(input.values).some((k) => !fields.some((f) => f.key === k))
    )
      throw new BadRequestException('凭据字段缺失或包含不支持的字段');
    if (JSON.stringify(input.values).length > 300000) throw new BadRequestException('凭据内容过大');
    const credential: StoredCredential = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      fingerprint: hash(JSON.stringify(input.values)).slice(0, 12),
      createdAt: new Date().toISOString(),
      envelope: {} as Envelope,
    };
    credential.envelope = this.vault.seal(input.values, this.context(credential));
    await this.store.put('credential', credential);
    await this.store.audit('保存凭据', input.name, actor);
    const { envelope: _, ...metadata } = credential;
    return metadata;
  }
  async secret(id: string, kind: CredentialKind) {
    const credential = await this.store.get<StoredCredential>('credential', id);
    if (!credential || credential.kind !== kind)
      throw new BadRequestException('指定凭据不存在或已撤销');
    return this.vault.open(credential.envelope, this.context(credential));
  }
  async verifyCredential(id: string, actor: string) {
    const credential = await this.store.get<StoredCredential>('credential', id);
    if (!credential) throw new NotFoundException('凭据不存在');
    const values = await this.secret(id, credential.kind);
    if (credential.kind === 'vercel')
      await providerRequest('https://api.vercel.com/v2/user', { token: values.token });
    else if (credential.kind === 'github')
      await providerRequest('https://api.github.com/user', { token: values.token });
    else throw new BadRequestException('该通道需在隔离签名/发布节点联调，当前不能声称验证成功');
    credential.verifiedAt = new Date().toISOString();
    await this.store.put('credential', credential);
    await this.store.audit('验证凭据', credential.name, actor);
    return { verifiedAt: credential.verifiedAt };
  }
  async revokeCredential(id: string, actor: string) {
    return this.store.db.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const credential = await this.store.get<StoredCredential>('credential', id, q);
      if (!credential) throw new NotFoundException('凭据不存在');
      const active = await q.query(
        "SELECT id FROM jobs WHERE workspace=$1 AND data->'target'->>'credentialId'=$2 AND status=ANY($3) LIMIT 1",
        [this.store.workspace, id, activeStatuses],
      );
      if (active.rows.length)
        throw new ConflictException('凭据正被未结束的任务使用；请先处理该任务');
      await q.query('DELETE FROM entities WHERE workspace=$1 AND kind=$2 AND id=$3', [
        this.store.workspace,
        'credential',
        id,
      ]);
      await this.store.audit('撤销本地凭据', credential.name, actor, q);
      return { ok: true };
    });
  }
  async preflight(projectId: string, selectedIds?: string[], ref?: string): Promise<Preflight[]> {
    return this.preflightProject(await this.project(projectId), selectedIds, ref);
  }
  async preflightProject(
    project: Project,
    selectedIds?: string[],
    ref?: string,
  ): Promise<Preflight[]> {
    const projectId = project.id;
    const targets = selectedIds
      ? project.targets.filter((t) => selectedIds.includes(t.id))
      : project.targets;
    if (!targets.length || (selectedIds && targets.length !== selectedIds.length))
      throw new BadRequestException('请先保存有效的发布目标');
    const results: Preflight[] = [];
    let detected: Awaited<ReturnType<GitHubAdapter['detect']>> | undefined;
    let sourceError: string | undefined;
    const needsSource = targets.some(
      (t) => capabilities.find((c) => c.provider === t.provider)?.executable && t.credentialId,
    );
    if (needsSource) {
      try {
        detected = await this.github.detect(
          project.repository,
          ref || project.branch,
          project.rootDir,
        );
      } catch (error) {
        sourceError = publicError(error);
      }
    }
    for (const target of targets) {
      const capability = capabilities.find((c) => c.provider === target.provider)!;
      const checks: Preflight['checks'] = [
        {
          key: 'type',
          label: '产品与模板',
          status: canUseProvider(project.template, target.provider) ? 'pass' : 'fail',
          detail: project.template,
        },
      ];
      const missing = targetFields[target.provider].filter(
        (f) => !f.label.includes('可选') && !target.config[f.key]?.trim(),
      );
      checks.push({
        key: 'configuration',
        label: '目标配置',
        status: missing.length ? 'fail' : 'pass',
        detail: missing.length
          ? `缺少：${missing.map((f) => f.label).join('、')}`
          : '必填字段已保存',
      });
      let credential: StoredCredential | undefined;
      if (target.credentialId)
        credential = await this.store.get<StoredCredential>('credential', target.credentialId);
      checks.push({
        key: 'credential',
        label: '发布凭据',
        status: credential?.kind === target.provider ? 'pass' : 'fail',
        detail:
          credential?.kind === target.provider
            ? '已加密保存，目标权限在发布前验证'
            : '请绑定该平台的有效凭据',
      });
      checks.push({
        key: 'executor',
        label: '发布执行器',
        status: capability.executable ? 'pass' : 'fail',
        detail: capability.detail,
      });
      if (detected) {
        checks.push({
          key: 'source',
          label: '源码与版本',
          status: 'pass',
          detail: `${detected.sha.slice(0, 12)} · ${detected.files} 个文件`,
        });
        checks.push({
          key: 'template',
          label: '仓库兼容性',
          status: detected.template === project.template ? 'pass' : 'fail',
          detail:
            detected.template === project.template
              ? `识别为 ${detected.template}`
              : `实际模板：${detected.template || '未支持'}，与所选模板不一致`,
        });
        checks.push({
          key: 'lockfile',
          label: '依赖锁文件',
          status: detected.lockfile ? 'pass' : 'fail',
          detail: detected.lockfile ? '已找到依赖锁文件' : '请提交模板所需的依赖锁文件',
        });
      } else
        checks.push({
          key: 'source',
          label: '源码验证',
          status: sourceError ? 'fail' : 'warn',
          detail: sourceError || '先配置可用执行器及发布凭据，再联网验证仓库',
        });
      if (target.provider === 'vercel' && credential?.kind === 'vercel' && !missing.length) {
        try {
          const values = await this.secret(credential.id, 'vercel');
          await new VercelAdapter(values.token, target).validate();
          checks.push({
            key: 'authorization',
            label: 'Vercel 目标权限',
            status: 'pass',
            detail: '已验证专用目标项目，无重复 Git 自动部署',
          });
        } catch (error) {
          checks.push({
            key: 'authorization',
            label: 'Vercel 目标权限',
            status: 'fail',
            detail: publicError(error),
          });
        }
      }
      if (target.provider === 'wechat')
        checks.push({
          key: 'manual',
          label: '微信体验版本',
          status: 'warn',
          detail: '上传不等于体验版生效；首次设置和测试成员仍需人工处理',
        });
      if (target.provider === 'ios')
        checks.push({
          key: 'apple',
          label: 'Apple 处理时间',
          status: 'warn',
          detail: '上传后还需平台处理；外部测试可能需要审核',
        });
      results.push({
        projectId,
        targetId: target.id,
        sha: detected?.sha,
        checks,
        ready: Boolean(detected) && checks.every((c) => c.status !== 'fail'),
      });
    }
    return results;
  }
  async createRelease(
    body: unknown,
    key: string,
    actor: string,
    fixedRef?: string,
    options?: { revision: number; trigger: Deployment['trigger'] },
  ) {
    const input = parse(releaseSchema, body);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new BadRequestException('需要有效的 Idempotency-Key');
    if (new Set(input.targetIds).size !== input.targetIds.length)
      throw new BadRequestException('发布目标重复');
    const fingerprint = hash(JSON.stringify({ ...input, fixedRef, revision: options?.revision }));
    const existing = await this.store.idempotent(key, fingerprint);
    if (existing) return existing;
    const project = await this.project(input.projectId);
    if (options && ((project.revision ?? 0) !== options.revision || !project.automation?.enabled))
      throw new StoreConflict('CONFIG_CHANGED', '自动部署配置已变化，事件不再适用');
    const targets = project.targets.filter((t) => input.targetIds.includes(t.id));
    if (targets.some((t) => t.environment === 'production') && !input.confirmProduction)
      throw new BadRequestException('生产发布需要显式确认');
    const checks = await this.preflightProject(project, input.targetIds, fixedRef);
    if (checks.some((check) => !check.ready))
      throw new BadRequestException({ message: '预检查未通过，尚未创建部署任务', checks });
    const now = new Date().toISOString();
    const batchId = randomUUID();
    const jobs: Deployment[] = targets.map((target) => ({
      id: randomUUID(),
      batchId,
      projectId: project.id,
      projectName: project.name,
      project,
      target,
      sha: checks.find((c) => c.targetId === target.id)!.sha!,
      version: input.version,
      status: 'QUEUED',
      stage: 'PREFLIGHT',
      createdAt: now,
      updatedAt: now,
      credentialVersion: target.credentialId,
      trigger: options?.trigger ?? { kind: 'manual' },
    }));
    try {
      return await this.store.createRelease(key, fingerprint, jobs, actor, project.revision ?? 0);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new StoreConflict('TARGET_BUSY', '同一发布目标已有未结束的部署');
      throw error;
    }
  }
  async cancel(id: string, actor: string) {
    const job = await this.store.deployment(id);
    if (!job) throw new NotFoundException('部署不存在');
    if (!activeStatuses.includes(job.status)) throw new ConflictException('任务已经结束');
    const queued = job.status === 'QUEUED';
    const result = await this.store.updateDeployment(
      id,
      { status: queued ? 'CANCELLED' : 'CANCEL_REQUESTED' },
      queued ? '任务在执行前已取消。' : '已提交取消请求，等待第三方真实状态。',
    );
    await this.store.audit('请求取消部署', job.projectName, actor);
    return result;
  }
  async retry(id: string, body: unknown, key: string, actor: string) {
    const job = await this.store.deployment(id);
    if (!job) throw new NotFoundException('部署不存在');
    if (!['FAILED', 'CANCELLED'].includes(job.status))
      throw new ConflictException('只可重试已明确失败或已取消的任务，待核实任务请先对账');
    const approval = parse(
      z.object({ confirmProduction: z.boolean().default(false) }).strict(),
      body,
    );
    return this.createRelease(
      { projectId: job.projectId, targetIds: [job.target.id], version: job.version, ...approval },
      key,
      actor,
      job.sha,
    );
  }
}
