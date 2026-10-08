import { test, expect, type Page } from '@playwright/test';

const ownedProjects = new WeakMap<Page, Set<string>>();
test.beforeEach(async ({ page }) => {
  ownedProjects.set(page, new Set());
  const response = await page.request.get('/api/health');
  expect(response.ok()).toBe(true);
  expect((await response.json()).status).toBe('ok');
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/projects' &&
      response.ok()
    ) {
      void response.json().then((project) => ownedProjects.get(page)?.add(project.id));
    }
  });
});
test.afterEach(async ({ page, baseURL }) => {
  const response = await page.request.get('/api/session');
  const session = (await response.json()) as { user?: { csrf: string } };
  if (!session.user) return;
  const projects = (await (await page.request.get('/api/projects')).json()) as {
    id: string;
    name: string;
    repository: string;
  }[];
  for (const project of projects) {
    if (ownedProjects.get(page)?.has(project.id)) {
      await page.request.delete(`/api/projects/${project.id}`, {
        headers: { Origin: new URL(baseURL!).origin, 'X-CSRF-Token': session.user.csrf },
      });
    }
  }
});

test('桌面工作区：项目保存、双端预检查、筛选及凭据表单', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '每一个好产品，都值得被看见.' })).toBeVisible();
  await page.screenshot({ path: '.data/screenshots/desktop.png', fullPage: true });
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await expect(dialog.getByRole('alert')).toContainText('项目名称');
  const name = `端到端验证-${Date.now()}`;
  await dialog.getByLabel('项目名称', { exact: true }).fill(name);
  await dialog.getByLabel('GitHub 仓库', { exact: true }).fill('example/browser-test');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: /移动 App Android/ }).click();
  await expect(dialog.getByLabel('项目技术模板')).toHaveValue('app-flutter');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: /iOS · TestFlight/ }).click();
  await dialog.getByLabel('Application ID', { exact: true }).fill('com.example.e2e');
  await dialog.getByRole('button', { name: '保存并预检查' }).click();
  await expect(dialog.getByRole('heading', { name: '项目已保存，还有一些准备工作' })).toBeVisible();
  await expect(dialog.getByText('请绑定该平台的有效凭据')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: '开始部署' })).toHaveCount(0);
  await page.screenshot({ path: '.data/screenshots/preflight.png' });
  await dialog.getByRole('button', { name: '保存并返回' }).click();
  await page.getByRole('button', { name: /^我的项目/ }).click();
  await expect(page).toHaveURL(/view=projects/);
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: /Web 网页/ }).click();
  await expect(page.getByRole('heading', { name })).toHaveCount(0);
  await page.getByRole('button', { name: /移动 App/ }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索项目或部署' }).fill('没有这个项目');
  await expect(page.getByRole('heading', { name: '没有找到匹配的项目' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索项目或部署' }).fill('');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `删除项目 ${name}`, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '集成与凭据', exact: true }).click();
  await page.getByRole('button', { name: '添加凭据', exact: true }).click();
  await page.getByLabel('平台', { exact: true }).selectOption('ios');
  await expect(page.getByLabel('App Store Connect .p8', { exact: true })).toBeVisible();
  await page.getByLabel('平台', { exact: true }).selectOption('wechat');
  await expect(page.getByLabel('代码上传私钥', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '技术文档', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('多端产品自动化部署平台技术设计');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('button', { name: '操作审计', exact: true }).click();
  await expect(page.getByText('创建项目', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('项目设置：修改源码、配置冲突提示与自动部署接入说明', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '每一个好产品，都值得被看见.' })).toBeVisible();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  let dialog = page.getByRole('dialog');
  const name = `配置验证-${Date.now()}`;
  await dialog.getByLabel('项目名称', { exact: true }).fill(name);
  await dialog.getByLabel('GitHub 仓库', { exact: true }).fill('example/browser-test');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '保存并预检查' }).click();
  await expect(dialog.getByRole('heading', { name: '项目已保存，还有一些准备工作' })).toBeVisible();
  await dialog.getByRole('button', { name: '保存并返回' }).click();
  await page.getByRole('button', { name: `项目设置 ${name}`, exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('部署分支', { exact: true }).fill('release');
  await dialog.getByLabel('项目子目录', { exact: true }).fill('apps/web');
  await dialog.getByRole('button', { name: '保存源码配置' }).click();
  await expect(
    dialog.getByText('源码配置已保存。原自动部署规则已暂停，需要重新确认。'),
  ).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const projects = await (await page.request.get('/api/projects')).json();
  const current = projects.find((p: { name: string }) => p.name === name);
  const concurrent = await page.request.patch(`/api/projects/${current.id}`, {
    headers: { Origin: new URL(baseURL!).origin, 'X-CSRF-Token': session.user.csrf },
    data: {
      name,
      repository: current.repository,
      branch: current.branch,
      rootDir: current.rootDir,
      revision: current.revision,
    },
  });
  expect(concurrent.ok()).toBe(true);
  await dialog.getByRole('button', { name: '保存源码配置' }).click();
  await expect(dialog.getByRole('alert')).toContainText('配置已变化');
  await dialog.getByRole('button', { name: '重新读取' }).click();
  await expect(dialog.getByText('已读取最新配置。')).toBeVisible();
  await dialog.getByRole('tab', { name: '自动部署', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '开启自动部署' })).not.toBeChecked();
  await expect(dialog.getByText('GitHub 仓库 → Settings → Webhooks')).toBeVisible();
  await expect(dialog.getByText(/当前是本地地址/)).toBeVisible();
  await page.screenshot({ path: '.data/screenshots/project-automation.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: '保存自动部署规则' })).toBeInViewport();
  await page.screenshot({ path: '.data/screenshots/project-automation-mobile.png' });
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: `项目设置 ${name}`, exact: true }).click();
  await expect(page.getByLabel('部署分支', { exact: true })).toHaveValue('release');
  await expect(page.getByLabel('项目子目录', { exact: true })).toHaveValue('apps/web');
});

test('手机工作区：导航、布局及向导按钮可操作', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '每一个好产品，都值得被看见.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.data/screenshots/mobile.png', fullPage: true });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '集成与凭据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接平台，安全交付' })).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('项目名称', { exact: true }).fill('移动端表单测试');
  await dialog.getByLabel('GitHub 仓库', { exact: true }).fill('example/mobile');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await expect(dialog.getByRole('button', { name: /小程序 微信预览/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '下一步' })).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/mobile-wizard.png' });
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
});
