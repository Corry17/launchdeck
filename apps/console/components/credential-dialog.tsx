'use client';
import { useState } from 'react';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button, Modal, Field, Notice } from '../../../packages/ui';
import {
  credentialKinds,
  credentialFields,
  providerLabels,
  type CredentialKind,
} from '../../../packages/domain';
import { api } from '../lib/api';
export function CredentialDialog({
  initial = 'vercel',
  onClose,
  onSaved,
}: {
  initial?: CredentialKind;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<CredentialKind>(initial);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/credentials', { body: { kind, name, values } });
      setValues({});
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="添加发布凭据"
      description="仅服务端使用。保存后不再返回凭据原文。"
      onClose={() => !busy && onClose()}
      className="credential-modal"
    >
      <form onSubmit={save}>
        <div className="wizard-content">
          <Notice>
            <ShieldCheck size={14} /> AES-256-GCM 加密存储，工作区、平台和凭据 ID 共同绑定密文。
          </Notice>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="field-grid">
            <Field label="平台">
              {(id) => (
                <select
                  id={id}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as CredentialKind);
                    setValues({});
                  }}
                >
                  {credentialKinds.map((k) => (
                    <option key={k} value={k}>
                      {k === 'github' ? 'GitHub（本地联调）' : providerLabels[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="凭据名称">
              {(id) => (
                <input
                  id={id}
                  required
                  autoFocus
                  maxLength={60}
                  placeholder="例如：我的 Vercel 账号"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
          </div>
          {credentialFields[kind].map((field) => (
            <Field key={`${kind}-${field.key}`} label={field.label} hint={field.help}>
              {(id) =>
                field.multiline ? (
                  <textarea
                    id={id}
                    required
                    rows={4}
                    maxLength={128000}
                    autoComplete="off"
                    spellCheck={false}
                    value={values[field.key] || ''}
                    placeholder={field.placeholder}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                ) : (
                  <input
                    id={id}
                    required
                    type="password"
                    autoComplete="new-password"
                    maxLength={2000}
                    value={values[field.key] || ''}
                    placeholder={field.placeholder}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                )
              }
            </Field>
          ))}
          {!['github', 'vercel'].includes(kind) && (
            <Notice tone="warning">
              该通道的执行器尚未接入。目前只能安全保存配置，不能执行真实构建、签名或发布。
            </Notice>
          )}
        </div>
        <div className="wizard-footer">
          <span className="footer-hint">
            <LockKeyhole size={15} />
            机密不会写入日志或源码
          </span>
          <div className="button-group">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              加密保存
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
