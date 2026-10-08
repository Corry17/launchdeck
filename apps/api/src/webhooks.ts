import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StoreConflict } from '../../../packages/database';
import { hash, equalSecret, publicError } from '../../../packages/security';
import { repositorySchema, type WebhookRun } from '../../../packages/domain';
import { AppService } from './service';

const pushSchema = z.object({
  ref: z.string().max(256),
  after: z.string().regex(/^[a-f0-9]{40}$/),
  deleted: z.boolean(),
  forced: z.boolean(),
  repository: z.object({ id: z.number().int().positive().safe(), full_name: repositorySchema }),
});

export function verifyWebhook(body: Buffer, signature: string, secret: string) {
  if (secret.length < 32) throw new ServiceUnavailableException('GitHub Webhook 尚未配置');
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new ForbiddenException('Webhook 签名无效');
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  if (!equalSecret(expected, signature)) throw new ForbiddenException('Webhook 签名无效');
}

export class GitHubWebhooks {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  constructor(private readonly service: AppService) {}
  async receive(body: unknown, signature: string, event: string, deliveryId: string) {
    if (!Buffer.isBuffer(body))
      throw new BadRequestException('Webhook 必须使用原始 application/json 请求体');
    verifyWebhook(body, signature, process.env.GITHUB_WEBHOOK_SECRET || '');
    if (!z.string().uuid().safeParse(deliveryId).success)
      throw new BadRequestException('GitHub Delivery ID 格式无效');
    if (!/^[a-z_]{1,60}$/.test(event)) throw new BadRequestException('GitHub 事件类型无效');
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadRequestException('Webhook JSON 无效');
    }
    const fingerprint = hash(Buffer.concat([Buffer.from(`${event}:`), body]));
    if (event !== 'push')
      return this.service.store.acceptWebhook(deliveryId, fingerprint, () => []);
    const parsed = pushSchema.safeParse(payload);
    if (!parsed.success) throw new BadRequestException('GitHub push 数据格式无效');
    const push = parsed.data;
    return this.service.store.acceptWebhook(deliveryId, fingerprint, (projects) => {
      if (
        push.deleted ||
        push.forced ||
        !push.ref.startsWith('refs/heads/') ||
        /^0+$/.test(push.after)
      )
        return [];
      const now = new Date().toISOString();
      return projects
        .filter(
          (project) =>
            project.automation?.enabled &&
            project.automation.repositoryId === push.repository.id &&
            project.repository.toLowerCase() === push.repository.full_name.toLowerCase() &&
            `refs/heads/${project.branch}` === push.ref &&
            project.automation.baselineSha !== push.after,
        )
        .map((project) => ({
          id: randomUUID(),
          deliveryId,
          projectId: project.id,
          projectName: project.name,
          repositoryId: push.repository.id,
          sha: push.after,
          ref: push.ref,
          revision: project.revision ?? 0,
          status: 'ACCEPTED',
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          message: '签名已验证，等待预检查；尚未发布。',
        }));
    });
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        console.warn('Webhook 调度暂未完成，持久化事件将在后续扫描中恢复。'),
      );
    }, 2000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
  async tick() {
    if (this.pending) return this.pending;
    this.pending = this.processOne();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async processOne() {
    const store = this.service.store;
    const claim = await store.claimWebhook();
    if (!claim) return;
    const { run, token } = claim;
    const finish = (status: WebhookRun['status'], message: string, ids?: string[]) =>
      store.finishWebhook(run, token, status, message, ids);
    try {
      // 优先确认任务是否已在前次处理落库，避免崩溃恢复或重投时重复创建。
      const existing = await store.webhookDeployments(run.projectId, run.revision, run.sha);
      if (existing.length) {
        await finish(
          'CREATED',
          '已关联此前创建的部署，没有重复提交。',
          existing.map((d) => d.id),
        );
        return;
      }
      if (Date.now() - Date.parse(run.createdAt) > 24 * 60 * 60 * 1000 || run.attempts > 120) {
        await finish('FAILED', '事件等待超过处理上限，请检查目标状态后手动部署。');
        return;
      }
      const project = await store.get<import('../../../packages/domain').Project>(
        'project',
        run.projectId,
      );
      if (
        !project?.automation?.enabled ||
        (project.revision ?? 0) !== run.revision ||
        project.automation.repositoryId !== run.repositoryId
      ) {
        await finish('SKIPPED', '项目配置已更改或自动部署已关闭。');
        return;
      }
      const branch = await this.service.github.branch(project.repository, project.branch);
      if (!branch.protected || branch.repositoryId !== run.repositoryId || branch.sha !== run.sha) {
        await finish('SKIPPED', '分支保护或仓库身份已变化，或该提交不再是分支最新版本。');
        return;
      }
      const config = project.automation;
      const jobs = await this.service.createRelease(
        {
          projectId: project.id,
          targetIds: config.targetIds,
          version: config.version,
          confirmProduction: config.confirmProduction,
        },
        `gh-${hash(`${project.id}:${run.revision}:${run.sha}`)}`,
        'GitHub 自动触发',
        run.sha,
        {
          revision: run.revision,
          trigger: { kind: 'github', deliveryId: run.deliveryId, webhookRunId: run.id },
        },
      );
      await finish(
        'CREATED',
        '预检查通过，已创建部署任务；最终结果以部署记录为准。',
        jobs.map((d) => d.id),
      );
    } catch (error) {
      if (error instanceof StoreConflict && error.code === 'TARGET_BUSY')
        await finish('DEFERRED', '同一目标有未结束部署，30 秒后重新检查最新提交。');
      else if (error instanceof StoreConflict && error.code === 'CONFIG_CHANGED')
        await finish('SKIPPED', error.message);
      else {
        const reason = error instanceof HttpException ? error.message : publicError(error);
        await finish('FAILED', `${reason} 未绕过预检查，也未重复提交发布。`);
      }
    }
  }
}
