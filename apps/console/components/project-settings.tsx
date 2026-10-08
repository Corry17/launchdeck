'use client';
import { useState } from 'react';
import { Copy, GitBranch, Github, RefreshCw, Save, ShieldCheck, Zap } from 'lucide-react';
import { Badge, Button, Field, Modal, Notice, cn } from '../../../packages/ui';
import {
  productLabels,
  projectEditSchema,
  providerLabels,
  webhookStatusLabels,
  type Project,
  type WebhookRun,
} from '../../../packages/domain';
import { api, formatDate } from '../lib/api';

export function ProjectSettings({
  initial,
  webhookConfigured,
  webhookUrl,
  runs,
  onClose,
  onSaved,
}: {
  initial: Project;
  webhookConfigured: boolean;
  webhookUrl: string;
  runs: WebhookRun[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [project, setProject] = useState(initial);
  const [tab, setTab] = useState<'source' | 'automation'>('source');
  const [form, setForm] = useState({
    name: initial.name,
    repository: initial.repository,
    branch: initial.branch,
    rootDir: initial.rootDir,
  });
  const [enabled, setEnabled] = useState(Boolean(initial.automation?.enabled));
  const [targetIds, setTargetIds] = useState(
    initial.automation?.targetIds ||
      initial.targets.filter((t) => t.provider === 'vercel').map((t) => t.id),
  );
  const [version, setVersion] = useState(initial.automation?.version || '1.0.0');
  const [production, setProduction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const targets = project.targets.filter((t) => t.provider === 'vercel');
  const productionSelected = targets.some(
    (t) => targetIds.includes(t.id) && t.environment === 'production',
  );
  const sourceDirty = Object.entries(form).some(
    ([key, value]) => project[key as keyof typeof form] !== value,
  );
  function apply(next: Project) {
    setProject(next);
    setForm({
      name: next.name,
      repository: next.repository,
      branch: next.branch,
      rootDir: next.rootDir,
    });
    setEnabled(Boolean(next.automation?.enabled));
    setVersion(next.automation?.version || '1.0.0');
    setTargetIds(
      next.automation?.targetIds ||
        next.targets.filter((t) => t.provider === 'vercel').map((t) => t.id),
    );
    setProduction(false);
  }
  async function reload() {
    if (sourceDirty && !window.confirm('重新读取会放弃尚未保存的源码配置，是否继续？')) return;
    setBusy(true);
    setError('');
    try {
      apply(await api<Project>(`/projects/${project.id}`));
      await onSaved();
      setMessage('已读取最新配置。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setError('');
    setMessage('');
    if (tab === 'source') {
      const result = projectEditSchema.safeParse({ ...form, revision: project.revision ?? 0 });
      if (!result.success) {
        setError(result.error.issues[0].message);
        return;
      }
    } else if (sourceDirty) {
      setError('请先保存或重新读取源码配置，再设置自动部署。');
      return;
    }
    setBusy(true);
    try {
      const next =
        tab === 'source'
          ? await api<Project>(`/projects/${project.id}`, {
              method: 'PATCH',
              body: { ...form, revision: project.revision ?? 0 },
            })
          : await api<Project>(`/projects/${project.id}/automation`, {
              body: {
                enabled,
                targetIds,
                version,
                confirmProduction: production,
                revision: project.revision ?? 0,
              },
            });
      apply(next);
      await onSaved();
      setMessage(
        tab === 'source'
          ? '源码配置已保存。原自动部署规则已暂停，需要重新确认。'
          : next.automation?.enabled
            ? '自动部署已开启，仅处理之后受保护分支的新提交。'
            : '自动部署已关闭。已开始的外部发布仍需在部署记录中处理。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`项目设置 · ${project.name}`}
      description={`配置版本 r${project.revision ?? 0} · ${productLabels[project.type]} · ${project.template}`}
      onClose={() => !busy && onClose()}
      className="project-settings-modal"
    >
      <div className="settings-tabs" role="tablist" aria-label="项目设置分类">
        {[
          { key: 'source', label: '源码配置', icon: Github },
          { key: 'automation', label: '自动部署', icon: Zap },
        ].map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            className={cn(tab === item.key && 'active')}
            onClick={() => {
              setTab(item.key as typeof tab);
              setError('');
              setMessage('');
            }}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
      <div className="wizard-content">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        {tab === 'source' ? (
          <>
            <Notice>
              可以修改名称、仓库、分支和子目录。修改后会暂停原自动部署规则，历史部署保留原始配置快照。
            </Notice>
            <Field label="项目名称">
              {(id) => (
                <input
                  id={id}
                  maxLength={60}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="GitHub 仓库">
              {(id) => (
                <input
                  id={id}
                  maxLength={240}
                  value={form.repository}
                  onChange={(e) => setForm({ ...form, repository: e.target.value })}
                />
              )}
            </Field>
            <div className="field-grid">
              <Field label="部署分支">
                {(id) => (
                  <input
                    id={id}
                    maxLength={120}
                    value={form.branch}
                    onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  />
                )}
              </Field>
              <Field label="项目子目录">
                {(id) => (
                  <input
                    id={id}
                    maxLength={160}
                    value={form.rootDir}
                    onChange={(e) => setForm({ ...form, rootDir: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <p className="field-hint">
              产品类型与模板不在此处转换。如需不同类型，请新建对应项目。存在未结束的部署时，源码配置不可修改。
            </p>
          </>
        ) : (
          <>
            <div className="automation-heading">
              <span className="integration-icon">
                <Zap size={23} />
              </span>
              <div>
                <h3>提交代码，自动进入发布流程</h3>
                <p>只接受指定仓库的受保护分支 push，不触发 fork PR、Tag 或强制推送。</p>
              </div>
              <Badge tone={project.automation?.enabled ? 'green' : 'neutral'}>
                {project.automation?.enabled ? '已开启' : '默认关闭'}
              </Badge>
            </div>
            {!webhookConfigured && (
              <Notice tone="warning">
                服务端未配置 GITHUB_WEBHOOK_SECRET。先由管理员设置至少 32 字符的随机密钥并重启
                API，才能开启自动部署。
              </Notice>
            )}
            {project.type !== 'web' || !targets.length ? (
              <Notice tone="warning">
                当前自动触发仅支持 Vercel Web 目标。请先在“配置部署”中保存 Vercel 目标与有效凭据。
              </Notice>
            ) : null}
            <div className="webhook-setup">
              <strong>GitHub 仓库 → Settings → Webhooks</strong>
              <p>Payload URL（公网 HTTPS 地址）</p>
              <div className="copy-field">
                <code>{webhookUrl}</code>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="复制 Webhook 地址"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(webhookUrl)
                      .then(() => setMessage('Webhook 地址已复制。'))
                      .catch(() => setError('复制失败，请手动复制地址。'))
                  }
                >
                  <Copy size={15} />
                </Button>
              </div>
              <p>Content type：application/json · Events：Just the push event</p>
              <p>
                Secret：与服务端环境变量相同，密钥不会通过网页返回。保持 SSL verification 开启。
              </p>
              {webhookUrl.startsWith('http:') && (
                <p className="setup-warning">
                  当前是本地地址，GitHub 云端无法回调。上线 HTTPS 后请同步设置
                  CONSOLE_ORIGIN，勿将免登录本地模式暴露公网。
                </p>
              )}
            </div>
            <label className="automation-toggle">
              <span>
                <strong>开启自动部署</strong>
                <small>
                  <GitBranch size={13} />
                  {project.repository} · {project.branch}
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={
                  busy || (!project.automation?.enabled && (!webhookConfigured || !targets.length))
                }
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setProduction(false);
                }}
                aria-label="开启自动部署"
              />
            </label>
            <fieldset disabled={!enabled || busy} className="target-fieldset">
              <Field label="自动部署目标">
                {(id) => (
                  <div id={id} className="automation-targets">
                    {targets.map((target) => (
                      <label key={target.id}>
                        <input
                          type="checkbox"
                          checked={targetIds.includes(target.id)}
                          onChange={(e) =>
                            setTargetIds(
                              e.target.checked
                                ? [...targetIds, target.id]
                                : targetIds.filter((t) => t !== target.id),
                            )
                          }
                        />
                        <span>
                          {providerLabels[target.provider]} ·{' '}
                          {target.environment === 'production' ? '生产环境' : '预览环境'}
                        </span>
                        <code>{target.config.projectId || '尚未配置 Project ID'}</code>
                      </label>
                    ))}
                  </div>
                )}
              </Field>
              <Field
                label="自动部署版本标签"
                hint="Web 版本标签可复用；每次部署仍通过不可变 commit SHA 和任务 ID 区分。"
              >
                {(id) => (
                  <input
                    id={id}
                    value={version}
                    placeholder="1.0.0"
                    onChange={(e) => setVersion(e.target.value)}
                  />
                )}
              </Field>
              {productionSelected && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={production}
                    onChange={(e) => setProduction(e.target.checked)}
                  />
                  我授权此受保护分支的新提交自动发布到生产环境，无需逐次确认，并知悉可能产生费用及线上影响。
                </label>
              )}
            </fieldset>
            <p className="field-hint">
              开启时会联网检查仓库
              ID、分支保护及目标权限，不触发一次部署。关闭不会撤回已经上传的版本；排队中的事件和未开始上传的任务会停止。
            </p>
            {runs.length > 0 && (
              <section className="automation-history">
                <h4>最近触发</h4>
                {runs.slice(0, 5).map((run) => (
                  <div key={run.id}>
                    <Badge
                      tone={
                        run.status === 'FAILED'
                          ? 'red'
                          : run.status === 'CREATED'
                            ? 'green'
                            : 'neutral'
                      }
                    >
                      {webhookStatusLabels[run.status]}
                    </Badge>
                    <code>{run.sha.slice(0, 8)}</code>
                    <time>{formatDate(run.createdAt)}</time>
                    <p>{run.message}</p>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <div className="wizard-footer">
        <span className="footer-hint">
          <ShieldCheck size={15} />仅 Owner 可更改发布授权
        </span>
        <div className="button-group">
          <Button variant="ghost" disabled={busy} onClick={reload}>
            <RefreshCw size={15} />
            重新读取
          </Button>
          <Button
            loading={busy}
            disabled={
              tab === 'automation' &&
              enabled &&
              (sourceDirty ||
                !webhookConfigured ||
                !targetIds.length ||
                (productionSelected && !production))
            }
            onClick={save}
          >
            <Save size={15} />
            {tab === 'source' ? '保存源码配置' : '保存自动部署规则'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
