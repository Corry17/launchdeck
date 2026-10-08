import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Database, Store, StoreConflict } from '../packages/database';
import { Vault, hash } from '../packages/security';
import { AppService } from '../apps/api/src/service';
import { GitHubWebhooks, verifyWebhook } from '../apps/api/src/webhooks';
import { VercelAdapter } from '../packages/adapters/vercel';
import type { Project } from '../packages/domain';

let db: Database;
let store: Store;
let service: AppService;
let webhooks: GitHubWebhooks;
const secret = randomBytes(32).toString('hex');
const baseline = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const heads = new Map<string, { sha: string; protected: boolean; repositoryId: number }>();
let serial = 100;
before(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  db = await Database.open({ memory: true });
  store = new Store(db);
  service = new AppService(store, new Vault(randomBytes(32)), true);
  webhooks = new GitHubWebhooks(service);
  mock.method(service.github, 'branch', async (repo: string) => heads.get(repo)!);
  mock.method(service.github, 'detect', async (_repo: string, ref: string) => ({
    sha: ref,
    template: 'web-vite',
    lockfile: true,
    files: 2,
    manifest: true,
  }));
  mock.method(VercelAdapter.prototype, 'validate', async () => ({ id: 'prj_test', name: 'test' }));
});
after(async () => {
  mock.restoreAll();
  await db.close();
});
function signature(body: Buffer) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
async function setup(environment: 'preview' | 'production' = 'preview') {
  const id = ++serial;
  let project = await service.createProject(
    {
      name: `Webhook 测试 ${id}`,
      repository: `example/web-${id}`,
      branch: 'main',
      rootDir: '.',
      type: 'web',
      template: 'web-vite',
    },
    'Owner',
  );
  const credential = await service.saveCredential(
    { name: `凭据 ${id}`, kind: 'vercel', values: { token: randomBytes(20).toString('hex') } },
    'Owner',
  );
  project = await service.saveTargets(
    project.id,
    [
      {
        provider: 'vercel',
        environment,
        credentialId: credential.id,
        config: { projectId: `prj_${id}` },
      },
    ],
    'Owner',
  );
  heads.set(project.repository, { sha: baseline, protected: true, repositoryId: id });
  return project;
}
async function enable(project: Project, confirmProduction = false) {
  return service.configureAutomation(
    project.id,
    {
      enabled: true,
      targetIds: project.targets.map((t) => t.id),
      version: '1.0.0',
      confirmProduction,
      revision: project.revision ?? 0,
    },
    'Owner',
  );
}
function payload(project: Project, overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      ref: 'refs/heads/main',
      after: commit,
      deleted: false,
      forced: false,
      repository: {
        id: heads.get(project.repository)!.repositoryId,
        full_name: project.repository,
      },
      ...overrides,
    }),
  );
}
async function receive(project: Project, overrides = {}, delivery = randomUUID()) {
  const body = payload(project, overrides);
  return webhooks.receive(body, signature(body), 'push', delivery);
}
function setHead(project: Project, sha = commit, protectedBranch = true) {
  heads.set(project.repository, {
    ...heads.get(project.repository)!,
    sha,
    protected: protectedBranch,
  });
}
async function runs(project: Project) {
  return store.webhookRuns(project.id);
}

test('签名绑定原始字节，拒绝 SHA1、错误签名和未配置的密钥', () => {
  const body = Buffer.from('{"x":1}');
  verifyWebhook(body, signature(body), secret);
  assert.throws(() => verifyWebhook(Buffer.from('{ "x":1 }'), signature(body), secret));
  assert.throws(() => verifyWebhook(body, signature(body).replace('sha256=', 'sha1='), secret));
  assert.throws(() => verifyWebhook(body, signature(body), ''));
});
test('开启自动部署要求分支保护、目标检查以及单独生产确认', async () => {
  const project = await setup('production');
  await assert.rejects(enable(project), /生产自动部署/);
  setHead(project, baseline, false);
  await assert.rejects(enable(project, true), /分支.*保护/);
  setHead(project, baseline, true);
  const enabled = await enable(project, true);
  assert.equal(enabled.automation?.enabled, true);
  assert.equal(enabled.automation?.baselineSha, baseline);
  assert.equal((await store.deployments()).filter((d) => d.projectId === project.id).length, 0);
});
test('未授权分支、Tag、删除、强推、仓库 ID 不符和启用时旧提交都不入队', async () => {
  const project = await enable(await setup());
  for (const overrides of [
    { ref: 'refs/heads/other' },
    { ref: 'refs/tags/v1' },
    { deleted: true },
    { forced: true },
    { after: baseline },
    { repository: { id: 9999, full_name: project.repository } },
  ])
    await receive(project, overrides);
  assert.equal((await runs(project)).length, 0);
  const body = payload(project);
  await webhooks.receive(body, signature(body), 'pull_request', randomUUID());
  assert.equal((await runs(project)).length, 0);
});
test('相同 delivery 原子去重，复用标识篡改内容被拒绝', async () => {
  const project = await enable(await setup());
  const delivery = randomUUID();
  const [a, b] = await Promise.all([
    receive(project, {}, delivery),
    receive(project, {}, delivery),
  ]);
  assert.equal(Number(a.duplicate) + Number(b.duplicate), 1);
  assert.equal((await runs(project)).length, 1);
  await assert.rejects(receive(project, { after: 'c'.repeat(40) }, delivery), StoreConflict);
  setHead(project);
  await webhooks.tick();
  assert.equal((await runs(project))[0].status, 'CREATED');
});
test('不同 delivery 重投同一提交也只生成一批固定源码部署', async () => {
  const project = await enable(await setup());
  setHead(project);
  await receive(project);
  await receive(project);
  await webhooks.tick();
  await webhooks.tick();
  const events = await runs(project);
  const jobs = await store.webhookDeployments(project.id, project.revision!, commit);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sha, commit);
  assert.equal(jobs[0].trigger?.kind, 'github');
  assert.equal(
    events.every((event) => event.status === 'CREATED'),
    true,
  );
  assert.equal(events[0].deploymentIds?.[0], events[1].deploymentIds?.[0]);
});
test('延迟到达的旧提交跳过，不让旧版本覆盖新提交', async () => {
  const project = await enable(await setup());
  setHead(project, 'c'.repeat(40));
  await receive(project);
  await webhooks.tick();
  assert.equal((await runs(project))[0].status, 'SKIPPED');
  assert.equal((await store.webhookDeployments(project.id, project.revision!, commit)).length, 0);
});
test('关闭自动规则使排队事件失效，已创建任务上传前也会被取消', async () => {
  let project = await enable(await setup());
  setHead(project);
  await receive(project);
  await webhooks.tick();
  const job = (await store.webhookDeployments(project.id, project.revision!, commit))[0];
  await receive(project, { after: 'c'.repeat(40) });
  project = await service.configureAutomation(
    project.id,
    { enabled: false, targetIds: [], version: '1.0.0', revision: project.revision },
    'Owner',
  );
  await webhooks.tick();
  assert.equal((await runs(project))[0].status, 'SKIPPED');
  await store.updateDeployment(job.id, { status: 'RUNNING', stage: 'FETCH' });
  assert.equal((await store.prepareUpload(job.id, undefined, '准备上传')).status, 'CANCELLED');
});
test('源码编辑增加配置版本，暂停自动规则，拒绝旧版本覆盖', async () => {
  const project = await enable(await setup());
  const edited = await service.editProject(
    project.id,
    {
      name: '修改后的项目',
      repository: project.repository,
      branch: 'release',
      rootDir: '.',
      revision: project.revision,
    },
    'Owner',
  );
  assert.equal(edited.revision, project.revision! + 1);
  assert.equal(edited.automation?.enabled, false);
  await assert.rejects(
    service.editProject(
      project.id,
      {
        name: '旧窗口覆盖',
        repository: project.repository,
        branch: 'main',
        rootDir: '.',
        revision: project.revision,
      },
      'Owner',
    ),
    StoreConflict,
  );
});
test('未修改目标的重复保存保留自动规则，过期向导不能覆盖新配置', async () => {
  const project = await enable(await setup());
  const targets = project.targets.map(({ id: _, projectId: __, ...target }) => target);
  const unchanged = await service.saveTargets(
    project.id,
    { targets, revision: project.revision },
    'Owner',
  );
  assert.equal(unchanged.revision, project.revision);
  assert.equal(unchanged.automation?.enabled, true);
  await assert.rejects(
    service.saveTargets(project.id, { targets, revision: 0 }, 'Owner'),
    StoreConflict,
  );
});

test('进行中的部署阻止源码配置修改，并保留任务内的历史快照', async () => {
  const project = await enable(await setup());
  setHead(project);
  await receive(project);
  await webhooks.tick();
  const original = (await store.webhookDeployments(project.id, project.revision!, commit))[0];
  await assert.rejects(
    service.editProject(
      project.id,
      {
        name: '不应修改',
        repository: project.repository,
        branch: 'release',
        rootDir: '.',
        revision: project.revision,
      },
      'Owner',
    ),
    StoreConflict,
  );
  assert.equal((await store.deployment(original.id))?.project.branch, 'main');
  assert.equal((await service.project(project.id)).revision, project.revision);
});

test('预检查期间配置变化阻止任务创建', async () => {
  const project = await enable(await setup());
  setHead(project);
  const original = service.preflightProject.bind(service);
  const changed = mock.method(
    service,
    'preflightProject',
    async (...args: Parameters<typeof service.preflightProject>) => {
      const result = await original(...args);
      await service.editProject(
        project.id,
        {
          name: '并发修改',
          repository: project.repository,
          branch: project.branch,
          rootDir: '.',
          revision: project.revision,
        },
        'Owner',
      );
      return result;
    },
  );
  try {
    await receive(project);
    await webhooks.tick();
    assert.equal((await runs(project))[0].status, 'SKIPPED');
    assert.equal((await store.webhookDeployments(project.id, project.revision!, commit)).length, 0);
  } finally {
    changed.mock.restore();
  }
});
test('忙碌目标延迟处理，不绕过发布互斥', async () => {
  const project = await enable(await setup());
  setHead(project);
  await receive(project);
  await webhooks.tick();
  setHead(project, 'c'.repeat(40));
  await receive(project, { after: 'c'.repeat(40) });
  await webhooks.tick();
  assert.equal((await runs(project))[0].status, 'DEFERRED');
  assert.equal(
    (await store.webhookDeployments(project.id, project.revision!, 'c'.repeat(40))).length,
    0,
  );
  await service.configureAutomation(
    project.id,
    { enabled: false, targetIds: [], version: '1.0.0', revision: project.revision },
    'Owner',
  );
});
test('前次任务已落库但事件未完成时，恢复关联而不是重复发布', async () => {
  const project = await enable(await setup());
  setHead(project);
  await receive(project);
  const claim = await store.claimWebhook();
  assert.ok(claim);
  assert.equal(claim.run.projectId, project.id);
  const jobs = await service.createRelease(
    {
      projectId: project.id,
      targetIds: project.automation!.targetIds,
      version: '1.0.0',
      confirmProduction: false,
    },
    `gh-${hash(`${project.id}:${project.revision}:${commit}`)}`,
    'GitHub 自动触发',
    commit,
    { revision: project.revision!, trigger: { kind: 'github', webhookRunId: claim.run.id } },
  );
  await db.query("UPDATE webhook_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [
    claim.run.id,
  ]);
  await webhooks.tick();
  assert.equal((await runs(project))[0].status, 'CREATED');
  assert.deepEqual(
    (await runs(project))[0].deploymentIds,
    jobs.map((d) => d.id),
  );
});
