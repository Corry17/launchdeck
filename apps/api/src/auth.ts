import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { hash, randomToken, equalSecret } from '../../../packages/security';
import { providerRequest } from '../../../packages/security/http';
import type { Role } from '../../../packages/domain';
import type { Store } from '../../../packages/database';

export interface Identity {
  name: string;
  role: Role;
  csrf: string;
  githubId?: string;
}
export class Auth {
  readonly origin: string;
  constructor(
    readonly store: Store,
    readonly local: boolean,
  ) {
    this.origin = process.env.CONSOLE_ORIGIN || 'http://localhost:3000';
    const parsed = new URL(this.origin);
    if (parsed.origin !== this.origin) throw new Error('CONSOLE_ORIGIN 不能包含路径');
    if (
      !local &&
      (parsed.protocol !== 'https:' ||
        !process.env.DATABASE_URL ||
        !process.env.GITHUB_CLIENT_ID ||
        !process.env.GITHUB_CLIENT_SECRET ||
        !process.env.ALLOWED_GITHUB_IDS)
    )
      throw new Error('生产模式需要 HTTPS、数据库、GitHub OAuth 与邀请名单配置');
  }
  cookieOptions() {
    return {
      httpOnly: true,
      secure: !this.local,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    };
  }
  checkOrigin(req: Request) {
    if (req.headers.origin !== this.origin || req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('请求来源验证失败');
  }
  async current(req: Request) {
    const token = req.cookies?.ld_session;
    return typeof token === 'string' && token.length <= 100
      ? this.store.session(hash(token))
      : undefined;
  }
  async require(req: Request, role: 'read' | 'write' | 'owner' = 'read'): Promise<Identity> {
    const user = await this.current(req);
    if (!user) throw new UnauthorizedException('请先登录工作区');
    if (!['GET', 'HEAD'].includes(req.method)) {
      this.checkOrigin(req);
      if (
        typeof req.headers['x-csrf-token'] !== 'string' ||
        !equalSecret(req.headers['x-csrf-token'], user.csrf)
      )
        throw new ForbiddenException('CSRF 验证失败，请刷新后重试');
    }
    if (role === 'owner' && user.role !== 'Owner')
      throw new ForbiddenException('此操作仅限工作区 Owner');
    if (role === 'write' && user.role === 'Viewer')
      throw new ForbiddenException('当前账号只有查看权限');
    return user;
  }
  async issue(res: Response, identity: Omit<Identity, 'csrf'>) {
    const token = randomToken();
    const user = { ...identity, csrf: randomToken() };
    await this.store.saveSession(hash(token), user);
    res.cookie('ld_session', token, this.cookieOptions());
    return user;
  }
  async localLogin(req: Request, res: Response) {
    if (
      !this.local ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
    )
      throw new ForbiddenException('本地登录仅限回环连接');
    this.checkOrigin(req);
    return this.issue(res, { name: '本地开发者', role: 'Owner' });
  }
  async githubLogin(res: Response) {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET)
      throw new ForbiddenException('尚未配置 GitHub OAuth');
    const state = randomToken();
    await this.store.db.query(
      "INSERT INTO oauth_states(hash,expires_at) VALUES($1,now()+interval '10 minutes')",
      [hash(state)],
    );
    await this.store.db.query('DELETE FROM oauth_states WHERE expires_at<now()');
    res.cookie('ld_oauth', state, { ...this.cookieOptions(), maxAge: 10 * 60 * 1000 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${this.origin}/api/auth/github/callback`);
    url.searchParams.set('state', state);
    res.redirect(url.href);
  }
  async githubCallback(req: Request, res: Response) {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const cookie = typeof req.cookies.ld_oauth === 'string' ? req.cookies.ld_oauth : '';
    res.clearCookie('ld_oauth', this.cookieOptions());
    if (
      !state ||
      state.length > 100 ||
      code.length > 300 ||
      !code ||
      !cookie ||
      !equalSecret(state, cookie)
    )
      throw new ForbiddenException('OAuth state 验证失败');
    const nonce = await this.store.db.query(
      'DELETE FROM oauth_states WHERE hash=$1 AND expires_at>now() RETURNING hash',
      [hash(state)],
    );
    if (!nonce.rows.length) throw new ForbiddenException('授权请求已过期或已使用');
    const token = await providerRequest<{ access_token?: string }>(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        body: {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${this.origin}/api/auth/github/callback`,
        },
      },
    );
    if (!token.access_token) throw new ForbiddenException('GitHub 授权失败');
    const account = await providerRequest<{ id: number; login: string }>(
      'https://api.github.com/user',
      { token: token.access_token },
    );
    const entries = (process.env.ALLOWED_GITHUB_IDS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const match = entries.find((entry) => entry.split(':')[0] === String(account.id));
    if (!match) throw new ForbiddenException('该 GitHub 账号尚未被邀请到工作区');
    const declared = match.split(':')[1];
    const role: Role =
      declared === 'Owner' || declared === 'Viewer' || declared === 'Maintainer'
        ? declared
        : entries[0] === match
          ? 'Owner'
          : 'Maintainer';
    await this.issue(res, { name: account.login, githubId: String(account.id), role });
    await this.store.audit('登录工作区', 'GitHub OAuth', account.login);
    res.redirect(this.origin);
  }
}
