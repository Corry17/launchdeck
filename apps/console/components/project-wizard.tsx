'use client';
import { useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Github,
  GitBranch,
  Folder,
  Rocket,
  ShieldCheck,
  CheckCircle2,
  CircleAlert,
  Circle,
  ScanSearch,
  Save,
} from 'lucide-react';
import {
  Button,
  Modal,
  Field,
  ProductIcon,
  ProviderIcon,
  Notice,
  Badge,
  cn,
} from '../../../packages/ui';
import {
  templates,
  productTypes,
  productLabels,
  providerLabels,
  targetFields,
  capabilities,
  prerequisites,
  projectSchema,
  type Project,
  type ProductType,
  type TemplateId,
  type Provider,
  type Credential,
  type Target,
  type Preflight,
  type Deployment,
} from '../../../packages/domain';
import { api } from '../lib/api';
const defaultTemplate: Record<ProductType, TemplateId> = {
  web: 'web-vite',
  miniapp: 'miniapp-taro',
  app: 'app-flutter',
};
const defaultProvider: Record<ProductType, Provider> = {
  web: 'vercel',
  miniapp: 'wechat',
  app: 'android',
};
type TargetDraft = Omit<Target, 'id' | 'projectId'>;
const targetDraft = (provider: Provider): TargetDraft => ({
  provider,
  environment: ['vercel', 'docker'].includes(provider) ? 'preview' : 'testing',
  config: provider === 'wechat' ? { robot: '1' } : {},
});
export function ProjectWizard({
  project,
  initialType = 'web',
  credentials,
  allowConfigure = true,
  onClose,
  onSaved,
  onDeployment,
}: {
  project?: Project;
  initialType?: ProductType;
  credentials: Credential[];
  allowConfigure?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeployment: (deployment: Deployment) => void;
}) {
  const [step, setStep] = useState(project ? 2 : 0);
  const [draft, setDraft] = useState<Project | undefined>(project);
  const [form, setForm] = useState({
    name: project?.name || '',
    repository: project?.repository || '',
    branch: project?.branch || 'main',
    rootDir: project?.rootDir || '.',
    type: project?.type || initialType,
    template: project?.template || defaultTemplate[initialType],
  });
  const [targets, setTargets] = useState<TargetDraft[]>(
    project?.targets.length
      ? project.targets.map(({ id: _, projectId: __, ...target }) => target)
      : [targetDraft(defaultProvider[project?.type || initialType])],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [checks, setChecks] = useState<Preflight[]>([]);
  const [version, setVersion] = useState('1.0.0');
  const [confirmed, setConfirmed] = useState(false);
  const [releaseKey] = useState(() => crypto.randomUUID());
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
    setInfo('');
  };
  const updateTarget = (provider: Provider, patch: Partial<TargetDraft>) =>
    setTargets((prev) =>
      prev.map((target) => (target.provider === provider ? { ...target, ...patch } : target)),
    );
  const changeType = (type: ProductType) => {
    setForm((prev) => ({ ...prev, type, template: defaultTemplate[type] }));
    setTargets([targetDraft(defaultProvider[type])]);
  };
  const chooseProvider = (provider: Provider) =>
    setTargets((prev) =>
      form.type === 'app'
        ? prev.some((t) => t.provider === provider)
          ? prev.length > 1
            ? prev.filter((t) => t.provider !== provider)
            : prev
          : [...prev, targetDraft(provider)]
        : [prev.find((t) => t.provider === provider) || targetDraft(provider)],
    );
  async function detect() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await api<{ template: TemplateId | null; sha: string; files: number }>(
        '/projects/import',
        { body: { repository: form.repository, branch: form.branch, rootDir: form.rootDir } },
      );
      if (!result.template) throw new Error('未识别到支持的标准模板，可以先手动选择并保存草稿。');
      const template = templates.find((t) => t.id === result.template)!;
      setForm((prev) => ({ ...prev, template: template.id, type: template.type }));
      setTargets([targetDraft(defaultProvider[template.type])]);
      setInfo(`已识别 ${template.name} · ${result.files} 个文件 · ${result.sha.slice(0, 8)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    setBusy(true);
    setError('');
    try {
      let current = draft;
      if (!current) {
        current = await api<Project>('/projects', { body: form });
        setDraft(current);
      }
      if (allowConfigure)
        current = await api<Project>(`/projects/${current.id}/targets`, {
          body: { targets, revision: current.revision ?? 0 },
        });
      setDraft(current);
      await onSaved();
      const result = await api<Preflight[]>('/preflights', { body: { projectId: current.id } });
      setChecks(result);
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deploy() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const jobs = await api<Deployment[]>('/releases', {
        key: releaseKey,
        body: {
          projectId: draft.id,
          targetIds: draft.targets.map((t) => t.id),
          version,
          confirmProduction: confirmed,
        },
      });
      await onSaved();
      onDeployment(jobs[0]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ready = checks.length > 0 && checks.every((c) => c.ready);
  const production = targets.some((t) => t.environment === 'production');
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={project ? `配置部署 · ${project.name}` : '让你的下一个产品上线'}
      description="连接源码，选择目标，剩下的交给部署流程。"
      className="wizard-modal"
    >
      <div className="wizard-steps">
        {['连接源码', '选择产品', '配置目标', '预检查'].map((label, index) => (
          <div
            key={label}
            className={cn('wizard-step', index === step && 'current', index < step && 'done')}
          >
            <span>{index < step ? <Check size={13} /> : index + 1}</span>
            <b>{label}</b>
            {index < 3 && <i />}
          </div>
        ))}
      </div>
      <div className="wizard-content">
        {error && <Notice tone="error">{error}</Notice>}
        {step === 0 && (
          <>
            <div className="section-eyebrow">
              <Github size={18} /> GITHUB REPOSITORY
            </div>
            <h3>从一个仓库开始</h3>
            <p className="muted">支持公开仓库；私有仓库需要 GitHub App 或本地只读令牌。</p>
            <Field label="项目名称">
              {(id) => (
                <input
                  id={id}
                  autoFocus
                  maxLength={60}
                  placeholder="例如：我的产品官网"
                  value={form.name}
                  onChange={(e) => update('name', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="GitHub 仓库"
              hint="源码不会在控制面执行，版本会在发布时固定为 commit SHA。"
            >
              {(id) => (
                <div className="input-action">
                  <input
                    id={id}
                    placeholder="https://github.com/your-name/your-product"
                    value={form.repository}
                    maxLength={240}
                    onChange={(e) => update('repository', e.target.value)}
                  />
                  <Button variant="secondary" size="small" loading={busy} onClick={detect}>
                    <ScanSearch size={15} />
                    识别仓库
                  </Button>
                </div>
              )}
            </Field>
            <div className="field-grid">
              <Field label="部署分支">
                {(id) => (
                  <div className="input-icon">
                    <GitBranch size={15} />
                    <input
                      id={id}
                      value={form.branch}
                      maxLength={120}
                      onChange={(e) => update('branch', e.target.value)}
                    />
                  </div>
                )}
              </Field>
              <Field label="项目子目录" hint="独立项目填 .，多产品仓库填写对应子目录。">
                {(id) => (
                  <div className="input-icon">
                    <Folder size={15} />
                    <input
                      id={id}
                      value={form.rootDir}
                      maxLength={160}
                      onChange={(e) => update('rootDir', e.target.value)}
                    />
                  </div>
                )}
              </Field>
            </div>
            {info && <Notice tone="success">{info}</Notice>}
            <Notice>暂时无法连接 GitHub？可以先填写信息并保存项目，发布前会再次验证源码。</Notice>
          </>
        )}
        {step === 1 && (
          <>
            <h3>这次，你想发布什么？</h3>
            <p className="muted">选择与你的源码对应的产品类型，平台不会自动转换跨端代码。</p>
            <div className="type-choices">
              {productTypes.map((type) => (
                <button
                  key={type}
                  className={cn('type-choice', form.type === type && 'selected')}
                  onClick={() => changeType(type)}
                  aria-pressed={form.type === type}
                >
                  <span className={`type-icon ${type}`}>
                    <ProductIcon type={type} size={28} />
                  </span>
                  <strong>{productLabels[type]}</strong>
                  <small>
                    {type === 'web'
                      ? '网站与全栈应用'
                      : type === 'miniapp'
                        ? '微信预览与体验版本'
                        : 'Android / iOS 测试分发'}
                  </small>
                  <span className="choice-radio">{form.type === type && <i />}</span>
                </button>
              ))}
            </div>
            <Field label="项目技术模板">
              {(id) => (
                <select
                  id={id}
                  value={form.template}
                  onChange={(e) => update('template', e.target.value as TemplateId)}
                >
                  {templates
                    .filter((t) => t.type === form.type)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.description}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Notice>
              首期按标准模板适配。原生工程、uni-app、React Native 等其他技术栈尚未支持。
            </Notice>
          </>
        )}
        {step === 2 && (
          <>
            {!allowConfigure && (
              <Notice>
                当前以 Maintainer 身份发布，只使用 Owner 已保存的配置。如需修改目标，请联系 Owner。
              </Notice>
            )}
            <fieldset disabled={!allowConfigure} className="target-fieldset">
              <h3>{form.type === 'app' ? '选择测试分发平台' : '选择你的发布目的地'}</h3>
              <p className="muted">
                {form.type === 'app'
                  ? '可同时选择 Android 与 iOS，两端独立执行、独立展示结果。'
                  : '配置可以先保存。缺少凭据或执行器时，预检查会明确拦截。'}
              </p>
              <div className="target-choices">
                {templates
                  .find((t) => t.id === form.template)!
                  .providers.map((provider) => (
                    <button
                      key={provider}
                      className={cn(
                        'target-choice',
                        targets.some((t) => t.provider === provider) && 'selected',
                      )}
                      onClick={() => chooseProvider(provider)}
                      aria-pressed={targets.some((t) => t.provider === provider)}
                    >
                      <ProviderIcon provider={provider} size={23} />
                      <span>
                        <strong>{providerLabels[provider]}</strong>
                        <small>{capabilities.find((c) => c.provider === provider)?.label}</small>
                      </span>
                      {targets.some((t) => t.provider === provider) && <CheckCircle2 size={19} />}
                    </button>
                  ))}
              </div>
              {targets.map((target) => (
                <section className="target-form" key={target.provider}>
                  <div className="target-form-heading">
                    <ProviderIcon provider={target.provider} />
                    <strong>{providerLabels[target.provider]}</strong>
                    <Badge tone={target.provider === 'vercel' ? 'blue' : 'amber'}>
                      {target.provider === 'vercel' ? '真实 API 适配器' : '执行器待接入'}
                    </Badge>
                  </div>
                  {form.type === 'web' && (
                    <Field label="部署环境">
                      {(id) => (
                        <select
                          id={id}
                          value={target.environment}
                          onChange={(e) =>
                            updateTarget(target.provider, {
                              environment: e.target.value as Target['environment'],
                            })
                          }
                        >
                          <option value="preview">预览环境 · Preview</option>
                          <option value="production">生产环境 · Production（需确认）</option>
                        </select>
                      )}
                    </Field>
                  )}
                  <div className="field-grid">
                    {targetFields[target.provider].map((field) => (
                      <Field key={field.key} label={field.label} hint={field.help}>
                        {(id) => (
                          <input
                            id={id}
                            value={target.config[field.key] || ''}
                            placeholder={field.placeholder}
                            maxLength={500}
                            onChange={(e) =>
                              updateTarget(target.provider, {
                                config: { ...target.config, [field.key]: e.target.value },
                              })
                            }
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <Field label="发布凭据" hint="可以先保存项目，再到「集成与凭据」添加并绑定。">
                    {(id) => (
                      <select
                        id={id}
                        value={target.credentialId || ''}
                        onChange={(e) =>
                          updateTarget(target.provider, {
                            credentialId: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">稍后配置凭据</option>
                        {credentials
                          .filter((c) => c.kind === target.provider)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} · {c.fingerprint.slice(0, 6)}
                            </option>
                          ))}
                      </select>
                    )}
                  </Field>
                  <div className="requirements">
                    <ShieldCheck size={15} />
                    <span>{prerequisites[target.provider].join('；')}</span>
                  </div>
                </section>
              ))}
            </fieldset>
          </>
        )}
        {step === 3 && (
          <>
            <div className="preflight-summary">
              <span className={ready ? 'success-circle' : 'warning-circle'}>
                {ready ? <CheckCircle2 size={27} /> : <CircleAlert size={27} />}
              </span>
              <div>
                <h3>{ready ? '准备就绪，可以部署' : '项目已保存，还有一些准备工作'}</h3>
                <p className="muted">
                  {ready
                    ? '点击部署会重新校验权限，并创建真实发布任务。'
                    : '没有启动构建，也没有执行外部发布。完成下方配置后可重新检查。'}
                </p>
              </div>
            </div>
            {checks.map((result) => (
              <section className="check-panel" key={result.targetId}>
                <h4>
                  {providerLabels[draft!.targets.find((t) => t.id === result.targetId)!.provider]}
                </h4>
                {result.checks.map((check) => (
                  <div key={check.key} className={`check-row ${check.status}`}>
                    {check.status === 'pass' ? (
                      <CheckCircle2 size={17} />
                    ) : check.status === 'fail' ? (
                      <CircleAlert size={17} />
                    ) : (
                      <Circle size={17} />
                    )}
                    <div>
                      <strong>{check.label}</strong>
                      <p>{check.detail}</p>
                    </div>
                    <span>
                      {check.status === 'pass'
                        ? '通过'
                        : check.status === 'fail'
                          ? '待处理'
                          : '提示'}
                    </span>
                  </div>
                ))}
              </section>
            ))}
            {ready && (
              <Field label="发布版本号">
                {(id) => (
                  <input
                    id={id}
                    value={version}
                    placeholder="1.0.0"
                    onChange={(e) => setVersion(e.target.value)}
                  />
                )}
              </Field>
            )}
            {production && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我确认将所选版本发布到生产环境，可能影响当前访问用户。
              </label>
            )}
          </>
        )}
      </div>
      <div className="wizard-footer">
        <div className="footer-hint">
          <ShieldCheck size={15} />
          {step === 3 ? '预检查结果来自实际配置' : '凭据加密保存，不写入源码'}
        </div>
        <div className="button-group">
          {step > (draft ? 2 : 0) && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStep(step - 1);
                setError('');
              }}
            >
              <ArrowLeft size={16} />
              上一步
            </Button>
          )}
          {step < 2 && (
            <Button
              disabled={busy}
              onClick={() => {
                const result = projectSchema.safeParse(form);
                if (!result.success) {
                  setError(result.error.issues[0].message);
                  return;
                }
                setStep(step + 1);
                setError('');
              }}
            >
              下一步
              <ArrowRight size={16} />
            </Button>
          )}
          {step === 2 && (
            <Button loading={busy} onClick={review}>
              <ShieldCheck size={16} />
              {allowConfigure ? '保存并预检查' : '运行预检查'}
            </Button>
          )}
          {step === 3 && (
            <>
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                <Save size={15} />
                保存并返回
              </Button>
              {ready ? (
                <Button loading={busy} disabled={production && !confirmed} onClick={deploy}>
                  <Rocket size={16} />
                  开始部署
                </Button>
              ) : (
                <Button variant="primary" loading={busy} onClick={review}>
                  重新检查
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
