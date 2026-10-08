import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  HttpCode,
  Delete,
  Body,
  Param,
  Req,
  Res,
  Inject,
  HttpException,
  BadRequestException,
  NotFoundException,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { json, raw, type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Database, Store, StoreConflict } from '../../../packages/database';
import { Vault, hash, publicError } from '../../../packages/security';
import { capabilities, detectSchema, type Project } from '../../../packages/domain';
import { AppService, parse } from './service';
import { Auth } from './auth';
import { DeploymentWorker } from './worker';
import { GitHubWebhooks } from './webhooks';

interface Runtime {
  service: AppService;
  auth: Auth;
  worker: DeploymentWorker;
  webhooks: GitHubWebhooks;
}
@Controller('api')
class ApiController {
  constructor(@Inject('runtime') readonly runtime: Runtime) {}
  @Post('hooks/github') @HttpCode(202) githubWebhook(@Req() req: Request, @Body() body: unknown) {
    return this.runtime.webhooks.receive(
      body,
      String(req.headers['x-hub-signature-256'] || ''),
      String(req.headers['x-github-event'] || ''),
      String(req.headers['x-github-delivery'] || ''),
    );
  }
  @Get('health') health() {
    return { status: 'ok', version: '0.1.0' };
  }
  @Get('session') async session(@Req() req: Request) {
    return {
      user: (await this.runtime.auth.current(req)) || null,
      mode: this.runtime.service.local ? 'local' : 'production',
      oauthConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    };
  }
  @Post('auth/local') local(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.runtime.auth.localLogin(req, res);
  }
  @Get('auth/github') github(@Res() res: Response) {
    return this.runtime.auth.githubLogin(res);
  }
  @Get('auth/github/callback') callback(@Req() req: Request, @Res() res: Response) {
    return this.runtime.auth.githubCallback(req, res);
  }
  @Post('auth/logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.runtime.auth.require(req);
    await this.runtime.service.store.db.query('DELETE FROM sessions WHERE hash=$1', [
      hash(req.cookies.ld_session),
    ]);
    res.clearCookie('ld_session', this.runtime.auth.cookieOptions());
    return { ok: true };
  }
  @Get('dashboard') async dashboard(@Req() req: Request) {
    await this.runtime.auth.require(req);
    const { store } = this.runtime.service;
    const [projects, deployments, credentials, audit, webhookRuns] = await Promise.all([
      store.list<Project>('project'),
      store.deployments(),
      this.runtime.service.credentials(),
      store.list('audit'),
      store.webhookRuns(),
    ]);
    return {
      projects,
      deployments,
      credentials,
      audit: audit.slice(0, 50),
      webhookRuns,
      capabilities,
      system: {
        database: store.db.embedded ? 'PGlite · 本地持久化' : 'PostgreSQL',
        queue: process.env.REDIS_URL ? 'BullMQ + 数据库恢复' : '数据库 Outbox',
        mode: this.runtime.service.local ? 'local' : 'production',
        webhookConfigured: this.runtime.service.webhookConfigured(),
        webhookUrl: `${this.runtime.auth.origin}/api/hooks/github`,
        githubApp: Boolean(
          process.env.GITHUB_APP_ID &&
          process.env.GITHUB_INSTALLATION_ID &&
          process.env.GITHUB_APP_PRIVATE_KEY,
        ),
      },
    };
  }
  @Get('projects') async projects(@Req() req: Request) {
    await this.runtime.auth.require(req);
    return this.runtime.service.store.list<Project>('project');
  }
  @Post('projects') async createProject(@Req() req: Request, @Body() body: unknown) {
    const user = await this.runtime.auth.require(req, 'write');
    return this.runtime.service.createProject(body, user.name);
  }
  @Post('projects/import') async detect(@Req() req: Request, @Body() body: unknown) {
    await this.runtime.auth.require(req, 'write');
    const input = parse(detectSchema, body);
    return this.runtime.service.github.detect(input.repository, input.branch, input.rootDir);
  }
  @Get('projects/:id') async project(@Req() req: Request, @Param('id') id: string) {
    await this.runtime.auth.require(req);
    return this.runtime.service.project(id);
  }
  @Patch('projects/:id') async editProject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.editProject(id, body, user.name);
  }
  @Post('projects/:id/automation') async automation(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.configureAutomation(id, body, user.name);
  }
  @Delete('projects/:id') async deleteProject(@Req() req: Request, @Param('id') id: string) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.deleteProject(id, user.name);
  }
  @Post('projects/:id/targets') async targets(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.saveTargets(id, body, user.name);
  }
  @Post('preflights') async preflight(@Req() req: Request, @Body() body: unknown) {
    await this.runtime.auth.require(req, 'write');
    const input = parse(
      z
        .object({
          projectId: z.string().uuid(),
          targetIds: z.array(z.string().uuid()).min(1).max(2).optional(),
        })
        .strict(),
      body,
    );
    return this.runtime.service.preflight(input.projectId, input.targetIds);
  }
  @Get('credentials') async credentials(@Req() req: Request) {
    await this.runtime.auth.require(req);
    return this.runtime.service.credentials();
  }
  @Post('credentials') async saveCredential(@Req() req: Request, @Body() body: unknown) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.saveCredential(body, user.name);
  }
  @Post('credentials/:id/verify') async verifyCredential(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.verifyCredential(id, user.name);
  }
  @Delete('credentials/:id') async revoke(@Req() req: Request, @Param('id') id: string) {
    const user = await this.runtime.auth.require(req, 'owner');
    return this.runtime.service.revokeCredential(id, user.name);
  }
  @Post('releases') async release(@Req() req: Request, @Body() body: unknown) {
    const user = await this.runtime.auth.require(req, 'write');
    return this.runtime.service.createRelease(
      body,
      String(req.headers['idempotency-key'] || ''),
      user.name,
    );
  }
  @Get('deployments/:id') async deployment(@Req() req: Request, @Param('id') id: string) {
    await this.runtime.auth.require(req);
    const job = await this.runtime.service.store.deployment(id);
    if (!job) throw new NotFoundException('部署不存在');
    return job;
  }
  @Post('deployments/:id/cancel') async cancel(@Req() req: Request, @Param('id') id: string) {
    const user = await this.runtime.auth.require(req, 'write');
    return this.runtime.service.cancel(id, user.name);
  }
  @Post('deployments/:id/retry') async retry(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = await this.runtime.auth.require(req, 'write');
    return this.runtime.service.retry(
      id,
      body,
      String(req.headers['idempotency-key'] || ''),
      user.name,
    );
  }
  @Post('deployments/:id/reconcile') async reconcile(@Req() req: Request, @Param('id') id: string) {
    const user = await this.runtime.auth.require(req, 'write');
    const result = await this.runtime.worker.reconcile(id);
    await this.runtime.service.store.audit('外部状态对账', id, user.name);
    return result;
  }
  @Get('deployments/:id/events') async events(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    await this.runtime.auth.require(req);
    const store = this.runtime.service.store;
    if (!(await store.deployment(id))) throw new NotFoundException('部署不存在');
    let cursor = Number(req.headers['last-event-id'] || req.query.after || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new BadRequestException('日志游标无效');
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let running = false;
    let closed = false;
    const emit = async () => {
      if (running || closed) return;
      running = true;
      try {
        if (!(await this.runtime.auth.current(req))) {
          res.end();
          return;
        }
        for (const event of await store.events(id, cursor)) {
          res.write(`id: ${event.sequence}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.sequence;
        }
        res.write(`event: deployment\ndata: ${JSON.stringify(await store.deployment(id))}\n\n`);
        res.write(': heartbeat\n\n');
      } catch {
        res.end();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void emit(), 2000);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    await emit();
  }
  @Get('documentation') async documentation(@Req() req: Request) {
    await this.runtime.auth.require(req);
    return { content: await readFile(resolve('docs/technical-design.md'), 'utf8') };
  }
}
class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof StoreConflict) {
      res.status(409).json({ message: error.message, code: error.code });
      return;
    }
    if ((error as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ message: '请求体超出大小限制' });
      return;
    }
    if ((error as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ message: '请求 JSON 无效' });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      res.status(error.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    } else res.status(502).json({ message: publicError(error) });
  }
}
@Module({})
class AppModule {}
export async function startServer(
  options: { memory?: boolean; port?: number; worker?: boolean } = {},
) {
  const local = process.env.APP_MODE
    ? process.env.APP_MODE === 'local'
    : process.env.NODE_ENV !== 'production';
  if (process.env.NODE_ENV === 'production' && local)
    throw new Error('生产启动不允许使用本地免登录模式');
  const db = await Database.open({
    url: process.env.DATABASE_URL || undefined,
    memory: options.memory,
  });
  const service = new AppService(new Store(db), await Vault.open(local), local);
  const auth = new Auth(service.store, local);
  const worker = new DeploymentWorker(service);
  const webhooks = new GitHubWebhooks(service);
  const app = await NestFactory.create(
    {
      module: AppModule,
      controllers: [ApiController],
      providers: [{ provide: 'runtime', useValue: { service, auth, worker, webhooks } }],
    },
    { bodyParser: false, logger: ['error', 'warn'] },
  );
  app.use(cookieParser());
  const limits = new Map<string, { count: number; until: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    const key = `${req.socket.remoteAddress}:${req.method === 'GET' ? 'read' : 'write'}`;
    const now = Date.now();
    const rate = limits.get(key);
    if (!rate || rate.until < now) limits.set(key, { count: 1, until: now + 60000 });
    else if (++rate.count > (req.method === 'GET' ? 360 : 60)) {
      res.status(429).json({ message: '请求过于频繁，请一分钟后重试' });
      return;
    }
    if (limits.size > 1000)
      for (const [id, value] of limits) if (value.until < now) limits.delete(id);
    next();
  });
  app.use('/api/hooks/github', raw({ type: 'application/json', limit: '512kb', inflate: false }));
  app.use(json({ limit: '512kb' }));
  app.useGlobalFilters(new SafeExceptionFilter());
  const port = options.port ?? Number(process.env.API_PORT || 4310);
  await app.listen(port, '127.0.0.1');
  if (options.worker !== false) {
    await worker.start();
    webhooks.start();
  }
  console.info(
    `Launchdeck API 已启动：http://127.0.0.1:${port}（${local ? '本地工作区' : '邀请制工作区'}）`,
  );
  return {
    app,
    service,
    worker,
    webhooks,
    close: async () => {
      await webhooks.stop();
      await worker.stop();
      await app.close();
      await db.close();
    },
  };
}
if (require.main === module)
  startServer()
    .then((runtime) => {
      let closing = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => {
          if (closing) return;
          closing = true;
          void runtime.close().then(() => process.exit(0));
        });
    })
    .catch(() => {
      console.error('API 启动失败，请检查数据库、主密钥、环境配置或端口占用。');
      process.exitCode = 1;
    });
