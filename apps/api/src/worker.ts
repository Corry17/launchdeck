import { Queue, Worker } from 'bullmq';
import { AppService } from './service';
import { VercelAdapter, type VercelDeployment } from '../../../packages/adapters/vercel';
import { publicError } from '../../../packages/security';
import type { Deployment } from '../../../packages/domain';

export class DeploymentWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private queue?: Queue;
  private worker?: Worker;
  constructor(readonly service: AppService) {}
  async start() {
    if (process.env.REDIS_URL) {
      const url = new URL(process.env.REDIS_URL);
      if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL 协议无效');
      const connection = {
        host: url.hostname,
        port: Number(url.port || 6379),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      };
      this.queue = new Queue('launchdeck', {
        connection: { ...connection, maxRetriesPerRequest: 1 },
      });
      this.queue.on('error', () => console.warn('Redis 不可用，保留 outbox 等待重投。'));
      this.worker = new Worker(
        'launchdeck',
        async (job) => {
          await this.runClaim(job.data.id);
        },
        { connection, concurrency: 1 },
      );
      this.worker.on('error', () => console.warn('队列暂不可用，数据库调度将继续尝试恢复。'));
    }
    this.timer = setInterval(() => void this.tick(), 2000);
    await this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const item of await this.service.store.pendingOutbox()) {
        try {
          if (this.queue)
            await this.queue.add(
              'deploy',
              { id: item.id },
              { jobId: item.id, removeOnComplete: 100, removeOnFail: 100 },
            );
          await this.service.store.markSent(item.id);
        } catch {
          break;
        }
      }
      // 数据库是事实来源，定时扫描同时恢复过期租约及延迟的外部状态检查。
      await this.runClaim();
    } catch {
      console.warn('任务调度暂未完成，将在下次扫描时恢复。');
    } finally {
      this.busy = false;
    }
  }
  async runClaim(id?: string) {
    const job = await this.service.store.claim(id);
    if (!job) return;
    const heartbeat = setInterval(
      () => void this.service.store.heartbeat(job.id).catch(() => {}),
      20000,
    );
    try {
      await this.execute(job);
    } catch (error) {
      const current = await this.service.store.deployment(job.id);
      if (!current || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(current.status))
        return;
      const uncertain = current.stage === 'UPLOAD' && !current.externalId;
      if (current.externalId && ['WAITING_EXTERNAL', 'CANCEL_REQUESTED'].includes(current.status)) {
        await this.service.store.event(
          job.id,
          `${publicError(error)} 外部任务仍在对账中。`,
          'warn',
        );
      } else
        await this.service.store.updateDeployment(
          job.id,
          { status: uncertain ? 'UNKNOWN' : 'FAILED', error: publicError(error) },
          uncertain ? '上传结果尚未确定，已停止自动重试；请对账后再操作。' : publicError(error),
        );
    } finally {
      clearInterval(heartbeat);
      await this.service.store.releaseLease(job.id);
    }
  }
  async execute(job: Deployment) {
    const store = this.service.store;
    if (job.target.provider !== 'vercel') throw new Error('执行器未接入');
    const secret = await this.service.secret(job.target.credentialId!, 'vercel');
    const adapter = new VercelAdapter(secret.token, job.target);
    if (job.externalId) {
      await this.poll(job, adapter);
      return;
    }
    if (job.stage === 'UPLOAD') {
      const found = await adapter.find(job.id);
      if (!found) {
        await store.updateDeployment(
          job.id,
          { status: 'UNKNOWN', error: '没有找到可确认的外部任务，禁止自动重复发布。' },
          '未能确认上次上传结果，请在平台核查。',
        );
        return;
      }
      const externalId = found.id || found.uid;
      if (!externalId) throw new Error('外部任务缺少标识');
      job = await store.updateDeployment(
        job.id,
        {
          externalId,
          status: job.status === 'CANCEL_REQUESTED' ? 'CANCEL_REQUESTED' : 'WAITING_EXTERNAL',
        },
        '已找回外部部署记录。',
      );
      await this.poll(job, adapter);
      return;
    }
    if (job.status === 'CANCEL_REQUESTED') {
      await store.updateDeployment(
        job.id,
        { status: 'CANCELLED' },
        '尚未向发布平台提交，任务已取消。',
      );
      return;
    }
    job = await store.updateDeployment(
      job.id,
      { status: 'RUNNING', stage: 'FETCH' },
      '正在获取固定版本源码；控制面不执行仓库脚本。',
    );
    const tree = await this.service.github.tree(
      job.project.repository,
      job.sha,
      job.project.rootDir,
    );
    if (tree.sha !== job.sha) throw new Error('源码版本不一致');
    const files = await this.service.github.snapshot(tree);
    const current = await store.deployment(job.id);
    if (current?.status === 'CANCEL_REQUESTED') {
      await store.updateDeployment(job.id, { status: 'CANCELLED' }, '上传前已取消。');
      return;
    }
    const remoteProject = await adapter.validate();
    if (job.trigger?.kind === 'github') {
      const branch = await this.service.github.branch(job.project.repository, job.project.branch);
      if (
        !branch.protected ||
        branch.repositoryId !== job.project.automation?.repositoryId ||
        branch.sha !== job.sha
      ) {
        await store.updateDeployment(
          job.id,
          { status: 'CANCELLED' },
          '上传前发现分支保护、仓库身份或最新提交已变化，已跳过旧版本。',
        );
        return;
      }
    }
    job = await store.prepareUpload(
      job.id,
      remoteProject.targets?.production?.id || remoteProject.targets?.production?.uid,
      `已校验 ${files.length} 个源码文件，开始提交 Vercel。`,
    );
    if (job.status === 'CANCELLED') return;
    const result = await adapter.create(job, files);
    const externalId = result.id || result.uid;
    if (!externalId) throw new Error('上传响应缺少部署 ID');
    const latest = await store.deployment(job.id);
    await store.updateDeployment(
      job.id,
      {
        externalId,
        stage: 'BUILD',
        status: latest?.status === 'CANCEL_REQUESTED' ? 'CANCEL_REQUESTED' : 'WAITING_EXTERNAL',
      },
      'Vercel 已接受部署；正在等待真实构建结果。',
    );
  }
  async poll(job: Deployment, adapter: VercelAdapter) {
    const store = this.service.store;
    let remote: VercelDeployment;
    if (job.status === 'CANCEL_REQUESTED') {
      try {
        remote = await adapter.cancel(job.externalId!);
      } catch {
        remote = await adapter.get(job.externalId!);
      }
    } else remote = await adapter.get(job.externalId!);
    const state = remote.readyState || remote.state;
    if (state === 'CANCELED') {
      await store.updateDeployment(job.id, { status: 'CANCELLED' }, 'Vercel 已确认部署取消。');
      return;
    }
    if (state === 'ERROR') {
      await store.updateDeployment(
        job.id,
        { status: 'FAILED', error: 'Vercel 构建失败，请查看 Vercel 控制台中的构建日志。' },
        'Vercel 返回 ERROR，未完成部署。',
      );
      return;
    }
    if (state !== 'READY') {
      if (Date.now() - new Date(job.createdAt).getTime() > 60 * 60 * 1000)
        await store.updateDeployment(
          job.id,
          { status: 'UNKNOWN', error: '外部平台超过一小时未完成，请核实其状态。' },
          '已停止高频轮询，外部结果仍需核实。',
        );
      return;
    }
    if (job.target.environment === 'production') {
      const project = await adapter.project();
      const productionId = project.targets?.production?.id || project.targets?.production?.uid;
      if (productionId !== job.externalId) {
        await store.updateDeployment(
          job.id,
          {
            status: 'UNKNOWN',
            error: '生产目标已变化或域名未指向本次部署，请在 Vercel 核实；不会覆盖其他发布。',
          },
          '生产指向与本次任务不一致，停止自动处理。',
        );
        return;
      }
    }
    await store.updateDeployment(
      job.id,
      { stage: 'VERIFY' },
      'Vercel 已就绪，正在检查站点可达性。',
    );
    try {
      const url = await adapter.verify(remote.url || '');
      await store.updateDeployment(
        job.id,
        { status: 'SUCCEEDED', stage: 'DISTRIBUTE', url },
        '站点可达性检查通过。',
      );
    } catch (error) {
      const detail = publicError(error);
      if (job.target.environment === 'production' && job.previousDeploymentId) {
        await store.event(job.id, '新站点未通过检查，尝试恢复上一生产部署。', 'warn');
        try {
          const current = await adapter.project();
          if (
            (current.targets?.production?.id || current.targets?.production?.uid) !== job.externalId
          )
            throw new Error('生产目标已变化');
          await adapter.rollback(job.previousDeploymentId);
          await store.event(
            job.id,
            'Vercel 已确认生产目标恢复。自动域名分配行为需遵循平台回滚规则。',
            'warn',
          );
        } catch {
          await store.updateDeployment(
            job.id,
            {
              status: 'UNKNOWN',
              error: '新站点检查失败，回滚结果尚未确认，请立即在 Vercel 核实生产目标。',
            },
            '需要人工核实生产状态。',
          );
          return;
        }
      }
      await store.updateDeployment(
        job.id,
        {
          status: 'FAILED',
          error: `平台已完成构建，但站点验证未通过。${detail} 若启用了访问保护，请在 Vercel 核查。`,
        },
        '没有将仅构建完成的任务标为成功。',
      );
    }
  }
  async reconcile(id: string) {
    const job = await this.service.store.deployment(id);
    if (!job || job.status !== 'UNKNOWN') throw new Error('仅待核实任务可执行对账');
    const values = await this.service.secret(job.target.credentialId!, 'vercel');
    const adapter = new VercelAdapter(values.token, job.target);
    const remote = job.externalId ? await adapter.get(job.externalId) : await adapter.find(job.id);
    if (!remote || !(remote.id || remote.uid))
      throw new Error('仍未找到外部任务，请到 Vercel 控制台核实；未重新提交部署');
    await this.service.store.updateDeployment(
      id,
      { externalId: remote.id || remote.uid, status: 'WAITING_EXTERNAL' },
      '已关联外部任务，恢复状态同步。',
    );
    return { ok: true };
  }
}
