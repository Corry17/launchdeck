import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Database, Store } from '../packages/database';
import { Vault, hash, sanitizePath } from '../packages/security';
import { checkIP, validateProviderUrl } from '../packages/security/http';
import {
  aggregateStatus,
  assertTransition,
  projectSchema,
  rootDirSchema,
  repositorySchema,
  type Deployment,
  type Project,
  type Target,
} from '../packages/domain';
import { AppService, type StoredCredential } from '../apps/api/src/service';
import { DeploymentWorker } from '../apps/api/src/worker';
import { VercelAdapter } from '../packages/adapters/vercel';

let db: Database;
let store: Store;
let service: AppService;
before(async () => {
  db = await Database.open({ memory: true });
  store = new Store(db);
  service = new AppService(store, new Vault(randomBytes(32)), true);
});
after(async () => {
  await db.close();
});
function fixture(provider: Target['provider'] = 'vercel'): Deployment {
  const id = randomUUID();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  const target: Target = {
    id: randomUUID(),
    projectId,
    provider,
    environment: 'preview',
    config: { projectId: `prj_${id}` },
  };
  const project: Project = {
    id: projectId,
    name: '测试项目',
    repository: 'example/repository',
    branch: 'main',
    rootDir: '.',
    type: 'web',
    template: 'web-vite',
    targets: [target],
    createdAt: now,
  };
  return {
    id,
    batchId: randomUUID(),
    projectId,
    projectName: project.name,
    target,
    project,
    sha: 'a'.repeat(40),
    version: '1.0.0',
    status: 'QUEUED',
    stage: 'PREFLIGHT',
    createdAt: now,
    updatedAt: now,
  };
}

test('源码地址只允许合法 GitHub 仓库，不能带凭据或任意主机', () => {
  assert.equal(repositorySchema.parse('https://github.com/owner/product.git'), 'owner/product');
  for (const invalid of [
    'https://127.0.0.1/owner/repo',
    'https://github.com.evil.test/a/b',
    'https://secret@github.com/a/b',
    'https://github.com/a/b?token=secret',
    'a/..',
    'a/.',
  ])
    assert.equal(repositorySchema.safeParse(invalid).success, false);
});
test('模板、子目录和平台类型不能被篡改', () => {
  for (const dir of ['../../secret', '/etc/passwd', 'app/../secret', 'app\\secret', 'app//src'])
    assert.equal(rootDirSchema.safeParse(dir).success, false);
  assert.equal(rootDirSchema.parse('apps/web'), 'apps/web');
  assert.throws(() => sanitizePath('../secret', '/safe'));
  assert.equal(sanitizePath('artifact.bin', '/safe'), '/safe/artifact.bin');
  assert.equal(
    projectSchema.safeParse({
      name: 'App',
      repository: 'a/b',
      branch: 'main',
      rootDir: '.',
      type: 'app',
      template: 'web-vite',
    }).success,
    false,
  );
});
test('出站请求拒绝内部 IP、主机混淆及不安全协议', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ])
    assert.equal(checkIP(ip), false);
  assert.equal(checkIP('8.8.8.8'), true);
  for (const url of [
    'file:///etc/passwd',
    'http://api.github.com/user',
    'https://api.vercel.com.evil.test/v1',
    'https://api.github.com:444/user',
    'https://user:password@api.github.com/user',
  ])
    assert.throws(() => validateProviderUrl(url));
  assert.equal(validateProviderUrl('https://api.github.com/user').hostname, 'api.github.com');
  assert.throws(() => validateProviderUrl('https://evil.test/site', true));
});
test('加密随机 IV、防篡改以及凭据作用域绑定', () => {
  const vault = new Vault(randomBytes(32));
  const secret = { token: randomBytes(24).toString('hex') };
  const first = vault.seal(secret, 'workspace:vercel:1');
  const second = vault.seal(secret, 'workspace:vercel:1');
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(vault.open(first, 'workspace:vercel:1'), secret);
  assert.throws(() => vault.open(first, 'other:vercel:1'));
  assert.throws(() =>
    vault.open({ ...first, tag: Buffer.alloc(16).toString('base64') }, 'workspace:vercel:1'),
  );
  assert.throws(() => new Vault(Buffer.alloc(16)));
});
test('终态不可重新推进，多目标部分成功不会伪装为全成功', () => {
  assert.throws(() => assertTransition('SUCCEEDED', 'RUNNING'));
  assert.throws(() => assertTransition('CANCELLED', 'SUCCEEDED'));
  assert.equal(aggregateStatus([{ status: 'SUCCEEDED' }, { status: 'FAILED' }]), 'PARTIAL_SUCCESS');
  assert.equal(
    aggregateStatus([{ status: 'SUCCEEDED' }, { status: 'WAITING_EXTERNAL' }]),
    'IN_PROGRESS',
  );
});
test('凭据只返回元数据，数据库中无原文', async () => {
  const token = randomBytes(24).toString('hex');
  const result = await service.saveCredential(
    { name: '单测凭据', kind: 'vercel', values: { token } },
    'test',
  );
  assert.equal('envelope' in result, false);
  const stored = await store.get<StoredCredential>('credential', result.id);
  assert.ok(stored?.envelope.ciphertext);
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal((await service.secret(result.id, 'vercel')).token, token);
  assert.equal(JSON.stringify(await service.credentials()).includes(token), false);
  await assert.rejects(service.secret(result.id, 'ios'));
});
test('未接入的 App 通道保留草稿但禁止创建发布任务', async () => {
  const project = await service.createProject(
    {
      name: 'Flutter 测试',
      repository: 'example/flutter',
      branch: 'main',
      rootDir: '.',
      type: 'app',
      template: 'app-flutter',
    },
    'test',
  );
  const saved = await service.saveTargets(
    project.id,
    [
      {
        provider: 'android',
        environment: 'testing',
        config: { applicationId: 'com.example.test' },
      },
      { provider: 'ios', environment: 'testing', config: {} },
    ],
    'test',
  );
  const checks = await service.preflight(project.id);
  assert.equal(checks.length, 2);
  assert.equal(
    checks.every((c) => !c.ready),
    true,
  );
  assert.equal(checks[0].checks.find((c) => c.key === 'executor')?.status, 'fail');
  await assert.rejects(
    service.createRelease(
      { projectId: project.id, targetIds: saved.targets.map((t) => t.id), version: '1.0.0' },
      randomUUID(),
      'test',
    ),
  );
  assert.equal(
    (await store.deployments()).some((d) => d.projectId === project.id),
    false,
  );
});
test('发布任务、日志、outbox 与幂等记录在同一事务创建', async () => {
  const job = fixture();
  const key = randomUUID();
  const fp = hash('same');
  const [a, b] = await Promise.all([
    store.createRelease(key, fp, [job], 'test'),
    store.createRelease(key, fp, [job], 'test'),
  ]);
  assert.equal(a[0].id, b[0].id);
  assert.equal((await store.deployments()).filter((d) => d.id === job.id).length, 1);
  assert.equal((await store.events(job.id)).length, 1);
  assert.ok((await store.pendingOutbox()).some((row) => row.id === job.id));
  await assert.rejects(store.createRelease(key, hash('different'), [job], 'test'));
  const claim = await store.claim(job.id);
  assert.equal(claim?.id, job.id);
  assert.equal(await store.claim(job.id), undefined);
  await store.updateDeployment(job.id, { status: 'RUNNING' });
  await store.updateDeployment(job.id, { status: 'FAILED' });
  await assert.rejects(store.updateDeployment(job.id, { status: 'SUCCEEDED' }));
});
test('不同项目不能同时向同一外部目标发布', async () => {
  const first = fixture();
  const second = fixture();
  second.target.config.projectId = first.target.config.projectId;
  await store.createRelease(randomUUID(), hash('first'), [first], 'test');
  await assert.rejects(store.createRelease(randomUUID(), hash('second'), [second], 'test'));
  assert.equal(await store.deployment(second.id), undefined);
  await store.updateDeployment(first.id, { status: 'CANCELLED' });
});
test('上传后失联只对账，不重复调用发布 API', async () => {
  const credential = await service.saveCredential(
    { name: 'Worker 单测', kind: 'vercel', values: { token: randomBytes(32).toString('hex') } },
    'test',
  );
  const job = fixture();
  job.target.credentialId = credential.id;
  await store.createRelease(randomUUID(), hash(job.id), [job], 'test');
  await store.updateDeployment(job.id, { status: 'RUNNING', stage: 'UPLOAD' });
  const find = mock.method(VercelAdapter.prototype, 'find', async () => undefined);
  const create = mock.method(VercelAdapter.prototype, 'create', async () => {
    throw new Error('不应发起第二次发布');
  });
  try {
    await new DeploymentWorker(service).runClaim(job.id);
    assert.equal((await store.deployment(job.id))?.status, 'UNKNOWN');
    assert.equal(find.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 0);
  } finally {
    find.mock.restore();
    create.mock.restore();
  }
});

test('平台 READY 仍须站点检查通过，不能将上传完成当作发布成功', async () => {
  const job = fixture();
  job.externalId = 'dpl_test';
  await store.createRelease(randomUUID(), hash(job.id), [job], 'test');
  await store.updateDeployment(job.id, { status: 'RUNNING' });
  const waiting = await store.updateDeployment(job.id, {
    status: 'WAITING_EXTERNAL',
    stage: 'BUILD',
  });
  const get = mock.method(VercelAdapter.prototype, 'get', async () => ({
    id: 'dpl_test',
    readyState: 'READY',
    url: 'example.vercel.app',
  }));
  const verify = mock.method(VercelAdapter.prototype, 'verify', async () => {
    throw new Error('站点不可达');
  });
  try {
    await new DeploymentWorker(service).poll(waiting, new VercelAdapter('unit-test', job.target));
    assert.equal((await store.deployment(job.id))?.status, 'FAILED');
    assert.equal((await store.deployment(job.id))?.url, undefined);
  } finally {
    get.mock.restore();
    verify.mock.restore();
  }
});

test('平台侧取消可正确结束等待中的任务', async () => {
  const job = fixture();
  job.externalId = 'dpl_cancel';
  await store.createRelease(randomUUID(), hash(job.id), [job], 'test');
  await store.updateDeployment(job.id, { status: 'RUNNING' });
  const waiting = await store.updateDeployment(job.id, {
    status: 'WAITING_EXTERNAL',
    stage: 'BUILD',
  });
  const get = mock.method(VercelAdapter.prototype, 'get', async () => ({
    id: job.externalId,
    readyState: 'CANCELED',
  }));
  try {
    await new DeploymentWorker(service).poll(waiting, new VercelAdapter('unit-test', job.target));
    assert.equal((await store.deployment(job.id))?.status, 'CANCELLED');
  } finally {
    get.mock.restore();
  }
});

test('生产指向已被其他发布改变时，不误报成功或覆盖生产版本', async () => {
  const job = fixture();
  job.externalId = 'dpl_ours';
  job.target.environment = 'production';
  await store.createRelease(randomUUID(), hash(job.id), [job], 'test');
  await store.updateDeployment(job.id, { status: 'RUNNING' });
  const waiting = await store.updateDeployment(job.id, {
    status: 'WAITING_EXTERNAL',
    stage: 'BUILD',
  });
  const get = mock.method(VercelAdapter.prototype, 'get', async () => ({
    id: job.externalId,
    readyState: 'READY',
    url: 'example.vercel.app',
  }));
  const project = mock.method(VercelAdapter.prototype, 'project', async () => ({
    id: 'prj_test',
    name: 'test',
    targets: { production: { id: 'dpl_other' } },
  }));
  const rollback = mock.method(VercelAdapter.prototype, 'rollback', async () => {});
  try {
    await new DeploymentWorker(service).poll(waiting, new VercelAdapter('unit-test', job.target));
    assert.equal((await store.deployment(job.id))?.status, 'UNKNOWN');
    assert.equal(rollback.mock.callCount(), 0);
  } finally {
    get.mock.restore();
    project.mock.restore();
    rollback.mock.restore();
  }
});
