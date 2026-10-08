import { Agent, request } from 'node:https';
import ipaddr from 'ipaddr.js';

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
export function checkIP(value: string) {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress())
      address = (address as ipaddr.IPv6).toIPv4Address();
    return address.range() === 'unicast';
  } catch {
    return false;
  }
}
export function buildSafeAgent() {
  const agent = new Agent({ keepAlive: false });
  const original = agent.createConnection.bind(agent);
  agent.createConnection = function (options, callback) {
    const host = String(options.host || options.hostname || '');
    if (ipaddr.isValid(host) && !checkIP(host)) throw new ProviderError('目标网络地址不被允许');
    const socket = original(options, callback);
    socket?.on('lookup', (error: Error | null, address: string) => {
      if (error || !checkIP(address)) socket.destroy(new ProviderError('目标网络地址不被允许'));
    });
    return socket;
  };
  return agent;
}
export function validateProviderUrl(value: string, siteCheck = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError('目标地址格式无效');
  }
  const allowed = siteCheck
    ? /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)
    : ['api.github.com', 'github.com', 'api.vercel.com'].includes(url.hostname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !allowed
  )
    throw new ProviderError('目标地址不在发布平台白名单内');
  return url;
}
export async function providerRequest<T>(
  value: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    siteCheck?: boolean;
    maxBytes?: number;
  } = {},
): Promise<T> {
  const url = validateProviderUrl(value, options.siteCheck);
  const agent = buildSafeAgent();
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const max = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise<T>((resolve, reject) => {
    const req = request(
      url,
      {
        agent,
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Launchdeck/0.1',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }
            : {}),
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            new ProviderError(
              status === 404
                ? '平台资源不存在，或当前账号无权访问。'
                : status === 401 || status === 403
                  ? '平台授权失败，请检查凭据和目标项目权限。'
                  : status === 429
                    ? '平台请求限流，请稍后重试。'
                    : `平台请求未完成（HTTP ${status}），没有跟随重定向。`,
              status,
            ),
          );
          return;
        }
        if (options.siteCheck) {
          res.destroy();
          resolve({ reachable: true } as T);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) res.destroy(new ProviderError('平台响应超出安全大小限制'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(text ? (JSON.parse(text) as T) : ({} as T));
          } catch {
            reject(new ProviderError('平台返回了无法识别的数据'));
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new ProviderError('平台请求超时，请检查网络连接')),
      20000,
    );
    req.on('error', (error) =>
      reject(
        error instanceof ProviderError
          ? error
          : new ProviderError('无法连接外部平台，请检查网络或代理设置。'),
      ),
    );
    req.on('close', () => {
      clearTimeout(timer);
      agent.destroy();
    });
    if (body) req.write(body);
    req.end();
  });
}
