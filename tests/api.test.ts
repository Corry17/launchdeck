import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hash } from '../packages/security';
import type { Project } from '../packages/domain';
import type { startServer } from '../apps/api/src/main';

let runtime: Awaited<ReturnType<typeof startServer>>;
let base: string;
let cookie: string;
let csrf: string;
const origin = 'http://localhost:3000';
before(async () => {
  process.env.MASTER_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.APP_MODE = 'local';
  process.env.CONSOLE_ORIGIN = origin;
  const { startServer } = await import('../apps/api/src/main');
  runtime = await startServer({ memory: true, port: 0, worker: false });
  base = await runtime.app.getUrl();
  const response = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  csrf = ((await response.json()) as { csrf: string }).csrf;
});
after(async () => {
  await runtime?.close();
});
function request(path: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('API 未登录不能读取工作区', async () => {
  const response = await fetch(`${base}/api/dashboard`);
  assert.equal(response.status, 401);
});
test('写请求必须同时通过来源与 CSRF 校验', async () => {
  const project = {
    name: '安全校验',
    repository: 'example/project',
    branch: 'main',
    rootDir: '.',
    type: 'web',
    template: 'web-vite',
  };
  assert.equal(
    (await request('/projects', project, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await request('/projects', project, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await request('/projects', { ...project, rootDir: '../../secrets' })).status, 400);
});
test('Viewer 不能创建项目或操作凭据', async () => {
  const token = randomUUID();
  const nonce = randomUUID();
  await runtime.service.store.saveSession(hash(token), {
    name: '只读用户',
    role: 'Viewer',
    csrf: nonce,
  });
  const response = await request(
    '/projects',
    {
      name: '禁止创建',
      repository: 'a/b',
      branch: 'main',
      rootDir: '.',
      type: 'web',
      template: 'web-vite',
    },
    { Cookie: `ld_session=${token}`, 'X-CSRF-Token': nonce },
  );
  assert.equal(response.status, 403);
});
test('项目与目标保存到数据库，刷新读取一致', async () => {
  const created = await request('/projects', {
    name: 'API 测试项目',
    repository: 'example/web',
    branch: 'main',
    rootDir: '.',
    type: 'web',
    template: 'web-vite',
  });
  assert.equal(created.status, 201);
  const project = (await created.json()) as Project;
  const saved = await request(`/projects/${project.id}/targets`, [
    { provider: 'vercel', environment: 'preview', config: { projectId: 'prj_test' } },
  ]);
  assert.equal(saved.status, 201);
  const again = (await (await request(`/projects/${project.id}`)).json()) as Project;
  assert.equal(again.name, project.name);
  assert.equal(again.targets[0].config.projectId, 'prj_test');
  const checks = await request('/preflights', { projectId: project.id });
  assert.equal(checks.status, 201);
  assert.equal(((await checks.json()) as { ready: boolean }[])[0].ready, false);
});
test('API 不能通过额外字段绕过目标白名单', async () => {
  const created = await request('/projects', {
    name: '目标字段校验',
    repository: 'example/target',
    branch: 'main',
    rootDir: '.',
    type: 'web',
    template: 'web-vite',
  });
  const project = (await created.json()) as Project;
  assert.equal(
    (
      await request(`/projects/${project.id}/targets`, [
        { provider: 'vercel', environment: 'preview', config: { command: 'unsafe-command' } },
      ])
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/projects/${project.id}/targets`, [
        { provider: 'ios', environment: 'testing', config: {} },
      ])
    ).status,
    400,
  );
});
test('返回结果和审计中均不包含凭据原文', async () => {
  const token = randomBytes(24).toString('base64url');
  const response = await request('/credentials', {
    name: '接口测试凭据',
    kind: 'vercel',
    values: { token },
  });
  assert.equal(response.status, 201);
  assert.equal((await response.text()).includes(token), false);
  const dashboard = await (await request('/dashboard')).text();
  assert.equal(dashboard.includes(token), false);
  assert.equal(dashboard.includes('ciphertext'), false);
});
test('未知项目与其他工作区实体不可访问', async () => {
  const id = randomUUID();
  await runtime.service.store.db.query(
    'INSERT INTO entities(workspace,kind,id,data) VALUES($1,$2,$3,$4)',
    ['other', 'project', id, JSON.stringify({ id, name: '隔离数据' })],
  );
  assert.equal((await request(`/projects/${id}`)).status, 404);
});
test('项目编辑仅限 Owner，并拒绝旧配置版本覆盖', async () => {
  const created = await request('/projects', {
    name: '可编辑项目',
    repository: 'example/edit',
    branch: 'main',
    rootDir: '.',
    type: 'web',
    template: 'web-vite',
  });
  const project = (await created.json()) as Project;
  const patch = {
    name: '编辑成功',
    repository: project.repository,
    branch: 'release',
    rootDir: 'apps/web',
    revision: 0,
  };
  const headers = {
    Cookie: cookie,
    Origin: origin,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
  };
  const updated = await fetch(`${base}/api/projects/${project.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as Project).revision, 1);
  const conflict = await fetch(`${base}/api/projects/${project.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  assert.equal(conflict.status, 409);
  const token = randomUUID();
  const nonce = randomUUID();
  await runtime.service.store.saveSession(hash(token), {
    name: '维护者',
    role: 'Maintainer',
    csrf: nonce,
  });
  const forbidden = await fetch(`${base}/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { ...headers, Cookie: `ld_session=${token}`, 'X-CSRF-Token': nonce },
    body: JSON.stringify({ ...patch, revision: 1 }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (
      await request(
        `/projects/${project.id}/automation`,
        { enabled: false, targetIds: [], version: '1.0.0', revision: 1 },
        { Cookie: `ld_session=${token}`, 'X-CSRF-Token': nonce },
      )
    ).status,
    403,
  );
});

test('Webhook 接口验证原始请求体，无需浏览器会话且快速返回去重结果', async () => {
  const secret = randomBytes(32).toString('hex');
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  const body = '{ "zen": "keep it simple" }';
  const delivery = randomUUID();
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const send = (content: string, sig: string) =>
    fetch(`${base}/api/hooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': delivery,
      },
      body: content,
    });
  assert.equal((await send(body, 'wrong')).status, 403);
  assert.equal((await send(JSON.stringify(JSON.parse(body)), signature)).status, 403);
  const accepted = await send(body, signature);
  assert.equal(accepted.status, 202);
  assert.equal(((await accepted.json()) as { duplicate: boolean }).duplicate, false);
  const duplicate = await send(body, signature);
  assert.equal(duplicate.status, 202);
  assert.equal(((await duplicate.json()) as { duplicate: boolean }).duplicate, true);
  const dashboard = await (await request('/dashboard')).text();
  assert.equal(dashboard.includes(secret), false);
});

test('OAuth 回调拒绝伪造 state，不发起 Token 交换', async () => {
  const response = await fetch(`${base}/api/auth/github/callback?state=forged&code=invalid`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 403);
});
