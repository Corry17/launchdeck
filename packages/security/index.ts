import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function sanitizePath(userPath: string, safeDir: string) {
  const root = resolve(safeDir);
  const target = resolve(root, userPath);
  const part = relative(root, target);
  if (
    part === '..' ||
    part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(part)
  )
    throw new Error('路径超出允许目录');
  return target;
}
export type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('加密主密钥必须为 32 字节');
  }
  static async open(local: boolean) {
    if (process.env.MASTER_KEY_BASE64)
      return new Vault(Buffer.from(process.env.MASTER_KEY_BASE64, 'base64'));
    if (!local) throw new Error('生产模式必须配置 MASTER_KEY_BASE64');
    const safeDir = resolve('.data');
    await mkdir(safeDir, { recursive: true, mode: 0o700 });
    const keyFile = sanitizePath('master.key', safeDir);
    try {
      return new Vault(await readFile(keyFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32);
    try {
      await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
      return new Vault(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return new Vault(await readFile(keyFile));
    }
  }
  seal(value: Record<string, string>, context: string): Envelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  open(envelope: Envelope, context: string): Record<string, string> {
    if (envelope.version !== 1) throw new Error('不支持的凭据密文版本');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
  }
}
export function publicError(error: unknown): string {
  if (error instanceof Error && error.name === 'ProviderError') return error.message;
  return '操作未完成，请检查网络、账号权限或服务端配置后重试。';
}
