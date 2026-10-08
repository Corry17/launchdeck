'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Command,
  Compass,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Github,
  Globe2,
  History,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import {
  Button,
  Badge,
  EmptyState,
  Notice,
  ProductIcon,
  ProviderIcon,
  StatusBadge,
  Modal,
  cn,
} from '../../../packages/ui';
import {
  activeStatuses,
  templates,
  productTypes,
  productLabels,
  providerLabels,
  prerequisites,
  webhookStatusLabels,
  type ProductType,
  type Project,
  type Deployment,
  type CredentialKind,
  type Credential,
} from '../../../packages/domain';
import { api, formatDate, setCsrf, type DashboardData, type Session, type User } from '../lib/api';
import { ProjectWizard } from './project-wizard';
import { ProjectSettings } from './project-settings';
import { CredentialDialog } from './credential-dialog';
import { DeploymentDetail } from './deployment-detail';
const navItems = [
  { id: 'overview', name: '工作台', icon: LayoutDashboard },
  { id: 'projects', name: '我的项目', icon: FolderGit2 },
  { id: 'deployments', name: '部署记录', icon: Workflow },
  { id: 'integrations', name: '集成与凭据', icon: Boxes },
  { id: 'audit', name: '操作审计', icon: History },
  { id: 'settings', name: '工作区设置', icon: Settings2 },
];
const typeCopy = {
  web: {
    eyebrow: 'WEB APPLICATION',
    title: 'Web 网页',
    description: '从个人网站到全栈产品，让创意拥有一个可以访问的地址。',
    tags: ['Vercel', '自有服务器'],
    action: '部署网页',
    className: 'web',
  },
  miniapp: {
    eyebrow: 'MINI PROGRAM',
    title: '微信小程序',
    description: '连接微信生态，管理代码上传、预览和体验版本。',
    tags: ['Taro', '微信 CI'],
    action: '配置小程序',
    className: 'miniapp',
  },
  app: {
    eyebrow: 'MOBILE APPLICATION',
    title: '移动 App',
    description: '一份 Flutter 源码，分别配置 Android 和 iOS 测试分发。',
    tags: ['Android', 'TestFlight'],
    action: '配置 App',
    className: 'app',
  },
};
export function Dashboard() {
  const router = useRouter();
  const params = useSearchParams();
  const view = navItems.some((n) => n.id === params.get('view')) ? params.get('view')! : 'overview';
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [wizard, setWizard] = useState<{ project?: Project; type: ProductType } | null>(null);
  const [credentialModal, setCredentialModal] = useState<CredentialKind | null>(null);
  const [projectSettings, setProjectSettings] = useState<Project | null>(null);
  const [detail, setDetail] = useState<Deployment | null>(null);
  const [help, setHelp] = useState(false);
  const [doc, setDoc] = useState('');
  const [busyId, setBusyId] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const result = await api<DashboardData>('/dashboard');
    setData(result);
    setError('');
  }, []);
  useEffect(() => {
    let live = true;
    async function init() {
      try {
        let current = await api<Session>('/session');
        if (!live) return;
        if (!current.user && current.mode === 'local') {
          const user = await api<User>('/auth/local', { body: {} });
          current = { ...current, user };
        }
        if (!live) return;
        setSession(current);
        if (current.user) {
          setCsrf(current.user.csrf);
          await refresh();
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    }
    void init();
    return () => {
      live = false;
    };
  }, [refresh]);
  useEffect(() => {
    const expired = () => {
      setSession((prev) => (prev ? { ...prev, user: null } : null));
      setData(null);
      setCsrf('');
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('session-expired', expired);
    window.addEventListener('keydown', keyboard);
    return () => {
      window.removeEventListener('session-expired', expired);
      window.removeEventListener('keydown', keyboard);
    };
  }, []);
  useEffect(() => {
    if (!session?.user) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch((e) => setError(e.message));
    }, 12000);
    return () => clearInterval(timer);
  }, [session?.user, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setFilter(params.get('filter') || 'all');
    setQuery(params.get('q') || '');
  }, [view, params]);
  const navigate = (next: string) => {
    router.push(next === 'overview' ? '/' : `/?view=${next}`);
    setNavOpen(false);
  };
  const create = (type: ProductType = 'web') => {
    if (session?.user?.role !== 'Owner') {
      setToast('新项目的目标配置需要 Owner 完成；Maintainer 可发布已有项目。');
      return;
    }
    setWizard({ type });
  };
  const user = session?.user;
  const owner = user?.role === 'Owner';
  const writable = Boolean(user && user.role !== 'Viewer');
  async function saved(message?: string) {
    await refresh();
    if (message) setToast(message);
  }
  async function credentialAction(credential: Credential, operation: 'verify' | 'delete') {
    if (
      operation === 'delete' &&
      !window.confirm(
        `确认撤销“${credential.name}”在本工作区保存的凭据？平台上的原始令牌不会被自动撤销。`,
      )
    )
      return;
    setBusyId(credential.id);
    setError('');
    try {
      await api(
        `/credentials/${credential.id}${operation === 'verify' ? '/verify' : ''}`,
        operation === 'verify' ? { body: {} } : { method: 'DELETE' },
      );
      await saved(
        operation === 'verify'
          ? '凭据账号验证通过，目标项目权限仍会在预检查时验证'
          : '本工作区的凭据已撤销',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId('');
    }
  }
  async function deleteProject(project: Project) {
    if (!window.confirm(`删除尚未部署的项目“${project.name}”？这不会删除 GitHub 仓库。`)) return;
    setBusyId(project.id);
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      await saved('项目已删除，GitHub 仓库不受影响');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId('');
    }
  }
  async function openHelp() {
    setHelp(true);
    if (!doc)
      try {
        const result = await api<{ content: string }>('/documentation');
        setDoc(result.content);
      } catch (e) {
        setDoc((e as Error).message);
      }
  }
  const deployments = data?.deployments || [];
  const projects = data?.projects || [];
  const pending = deployments.filter((d) =>
    ['WAITING_MANUAL', 'UNKNOWN', 'FAILED'].includes(d.status),
  );
  const filteredProjects = projects.filter(
    (p) =>
      `${p.name} ${p.repository}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || p.type === filter),
  );
  const filteredDeployments = deployments.filter(
    (d) =>
      `${d.projectName} ${d.sha} ${d.version}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'active'
          ? activeStatuses.includes(d.status)
          : filter === 'attention'
            ? pending.some((p) => p.id === d.id)
            : d.status === filter)),
  );

  if (loading)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <Rocket size={25} />
        </div>
        <h2>Launchdeck</h2>
        <span>
          <Loader2 size={16} className="spin" />
          正在连接你的工作区
        </span>
      </div>
    );
  if (!user || !data)
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="brand-mark">
            <Rocket size={27} />
          </div>
          <div className="section-eyebrow">YOUR PRODUCT, EVERYWHERE.</div>
          <h1>从创意，到上线。</h1>
          <p>欢迎来到 Launchdeck，你的多端产品部署工作台。</p>
          {error && <Notice tone="error">{error}</Notice>}
          {session?.mode === 'local' ? (
            <Button
              loading={Boolean(busyId)}
              onClick={async () => {
                setBusyId('login');
                try {
                  const result = await api<User>('/auth/local', { body: {} });
                  setCsrf(result.csrf);
                  setSession({ ...session, user: result });
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusyId('');
                }
              }}
            >
              进入本地工作区
              <ArrowRight size={17} />
            </Button>
          ) : session?.oauthConfigured ? (
            <Button asChild>
              <a href="/api/auth/github">
                <Github size={17} />
                使用 GitHub 登录
              </a>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => window.location.reload()}>
              重新连接服务
            </Button>
          )}
          <small>邀请制工作区 · 不开放公众注册</small>
        </div>
      </div>
    );

  function ProjectList({ compact = false }: { compact?: boolean }) {
    const list = compact ? filteredProjects.slice(0, 4) : filteredProjects;
    return list.length ? (
      <div className="project-grid">
        {list.map((project) => {
          const last = deployments.find((d) => d.projectId === project.id);
          return (
            <article className="project-card" key={project.id}>
              <div className="project-card-top">
                <span className={`type-icon ${project.type}`}>
                  <ProductIcon type={project.type} size={23} />
                </span>
                <div>
                  <h3>{project.name}</h3>
                  <span>
                    {templates.find((t) => t.id === project.template)?.name}
                    {project.automation?.enabled ? ' · 自动部署已开启' : ''}
                  </span>
                </div>
                {last ? <StatusBadge status={last.status} /> : <Badge>待部署</Badge>}
              </div>
              <a
                className="repository-link"
                href={`https://github.com/${project.repository}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github size={14} />
                <span>{project.repository}</span>
                <ArrowUpRight size={13} />
              </a>
              <div className="project-card-foot">
                <span>
                  <GitBranch size={13} />
                  {project.branch}
                </span>
                <div>
                  {owner && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`项目设置 ${project.name}`}
                      onClick={() => setProjectSettings(project)}
                    >
                      <Settings2 size={15} />
                    </Button>
                  )}
                  {owner && !last && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除项目 ${project.name}`}
                      loading={busyId === project.id}
                      onClick={() => deleteProject(project)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={!writable}
                    onClick={() => setWizard({ project, type: project.type })}
                  >
                    {owner ? '配置部署' : '预检查发布'}
                    <ArrowRight size={14} />
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    ) : (
      <EmptyState
        icon={<FolderGit2 size={30} strokeWidth={1.4} />}
        title={query || filter !== 'all' ? '没有找到匹配的项目' : '你的下一次发布，从这里开始'}
        text={
          query || filter !== 'all'
            ? '试试其他关键词或产品类型。'
            : '导入一个 GitHub 仓库，选择产品类型，即可开始配置部署。'
        }
      >
        {!query && filter === 'all' && (
          <Button variant="secondary" size="small" disabled={!writable} onClick={() => create()}>
            <Plus size={15} />
            导入第一个项目
          </Button>
        )}
      </EmptyState>
    );
  }
  function DeploymentList({ compact = false }: { compact?: boolean }) {
    const list = compact ? deployments.slice(0, 4) : filteredDeployments;
    return list.length ? (
      <div className="deployment-table">
        <div className="table-header">
          <span>项目 / 版本</span>
          <span>发布目标</span>
          <span>状态</span>
          <span>创建时间</span>
          <span />
        </div>
        {list.map((job) => (
          <button className="deployment-row" key={job.id} onClick={() => setDetail(job)}>
            <span>
              <strong>{job.projectName}</strong>
              <small>
                v{job.version} <i>·</i> {job.sha.slice(0, 7)} <i>·</i>{' '}
                {job.trigger?.kind === 'github' ? 'GitHub 自动' : '手动'}
              </small>
            </span>
            <span className="inline-icon">
              <ProviderIcon provider={job.target.provider} size={15} />
              {providerLabels[job.target.provider]}
            </span>
            <span>
              <StatusBadge status={job.status} />
            </span>
            <time>{formatDate(job.createdAt)}</time>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<Workflow size={28} strokeWidth={1.4} />}
        title={query || filter !== 'all' ? '没有匹配的部署记录' : '还没有部署记录'}
        text={
          query || filter !== 'all'
            ? '尝试调整搜索条件。'
            : '通过预检查并开始部署后，可在这里跟踪每个阶段的真实进度。'
        }
      />
    );
  }
  return (
    <div className="app-shell">
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={cn('sidebar', navOpen && 'open')}>
        <button
          className="brand"
          onClick={() => navigate('overview')}
          aria-label="Launchdeck 工作台"
        >
          <span className="brand-mark">
            <Rocket size={21} />
          </span>
          <strong>
            Launchdeck<span>BETA</span>
          </strong>
        </button>
        <div className="workspace-switch">
          <span className="workspace-avatar">L</span>
          <div>
            <strong>我的工作空间</strong>
            <small>{data.system.mode === 'local' ? '本地开发 · Personal' : '邀请制 · Team'}</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {navItems.slice(0, 3).map((item) => (
            <button
              key={item.id}
              className={cn('nav-item', view === item.id && 'active')}
              onClick={() => navigate(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <item.icon size={18} />
              <span>{item.name}</span>
              {item.id === 'projects' && projects.length > 0 && <small>{projects.length}</small>}
            </button>
          ))}
          <div className="nav-label secondary">管理</div>
          {navItems.slice(3).map((item) => (
            <button
              key={item.id}
              className={cn('nav-item', view === item.id && 'active')}
              onClick={() => navigate(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <item.icon size={18} />
              <span>{item.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span>
              <Sparkles size={16} />
              专注创造，轻松交付
            </span>
            <p>
              把复杂的发布流程，
              <br />
              收进一个简单的工作台。
            </p>
            <button onClick={openHelp}>
              阅读部署指南
              <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="sidebar-help" onClick={openHelp}>
            <BookOpen size={16} />
            技术文档
            <ArrowUpRight size={14} />
          </button>
          <div className="user-card">
            <div className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </div>
            <button
              aria-label="退出工作区"
              onClick={async () => {
                try {
                  await api('/auth/logout', { body: {} });
                  setSession({ ...session!, user: null });
                  setData(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-toggle"
              onClick={() => setNavOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={21} />
            </button>
            <span>我的工作空间</span>
            <ChevronRight size={14} />
            <strong>{navItems.find((n) => n.id === view)?.name}</strong>
          </div>
          <div className="topbar-actions">
            <div className="search-box">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="搜索项目或部署"
                placeholder="搜索项目或部署…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!['projects', 'deployments', 'overview'].includes(view))
                    router.push(`/?view=projects&q=${encodeURIComponent(e.target.value)}`);
                }}
              />
              <kbd>⌘ K</kbd>
            </div>
            <button
              className="notification-button"
              aria-label={pending.length ? `${pending.length} 项待处理部署` : '查看部署记录'}
              onClick={() => {
                router.push('/?view=deployments&filter=attention');
                setFilter('attention');
              }}
            >
              <Bell size={18} />
              {pending.length > 0 && <i />}
            </button>
            <span className="topbar-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {error && (
            <div className="page-error">
              <Notice tone="error">{error}</Notice>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setError('')}
                aria-label="关闭错误提示"
              >
                <X size={16} />
              </Button>
            </div>
          )}
          {view === 'overview' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">YOUR LAUNCH CONTROL</div>
                  <h1>
                    每一个好产品，都值得被看见<span className="title-dot">.</span>
                  </h1>
                  <p>从代码到用户，让每一次发布都有条不紊。</p>
                </div>
                <Button onClick={() => create()} disabled={!writable}>
                  <Plus size={17} />
                  新建项目
                </Button>
              </div>
              <section className="hero">
                <div className="hero-text">
                  <span className="hero-eyebrow">
                    <i /> ONE WORKSPACE. EVERY PLATFORM.
                  </span>
                  <h2>
                    创意已就绪，
                    <br />
                    下一站，<span>上线。</span>
                  </h2>
                  <p>
                    网页、小程序、移动 App。
                    <br />
                    选择你的目的地，让产品走出代码。
                  </p>
                  <button className="hero-link" onClick={openHelp}>
                    了解部署流程
                    <ArrowRight size={16} />
                  </button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="orbit orbit-three" />
                  <div className="orbit-line horizontal" />
                  <div className="orbit-line vertical" />
                  <div className="launch-core">
                    <Rocket size={45} strokeWidth={1.2} />
                    <div />
                  </div>
                  <div className="orbit-node node-web">
                    <Globe2 size={22} />
                    <span>Web</span>
                    <i />
                  </div>
                  <div className="orbit-node node-mini">
                    <Code2 size={21} />
                    <span>Mini Program</span>
                    <i />
                  </div>
                  <div className="orbit-node node-app">
                    <Command size={21} />
                    <span>Mobile App</span>
                    <i />
                  </div>
                  <div className="art-caption">
                    <span />
                    <small>BUILD ONCE. LAUNCH WITH CONFIDENCE.</small>
                  </div>
                  <i className="star star-one" />
                  <i className="star star-two" />
                </div>
                <span className="hero-coordinate">LAUNCHDECK / 001</span>
              </section>
              <div className="metrics-grid">
                {[
                  {
                    label: '全部项目',
                    value: projects.length,
                    icon: FolderGit2,
                    note: '创意的起点',
                    color: 'blue',
                  },
                  {
                    label: '已完成部署',
                    value: deployments.filter((d) => d.status === 'SUCCEEDED').length,
                    icon: CheckCircle2,
                    note: '经目标平台验证',
                    color: 'green',
                  },
                  {
                    label: '正在进行',
                    value: deployments.filter((d) =>
                      ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL'].includes(d.status),
                    ).length,
                    icon: Radio,
                    note: '实时同步任务状态',
                    color: 'purple',
                  },
                  {
                    label: '需要关注',
                    value: pending.length,
                    icon: CircleDot,
                    note: '等待处理或结果核实',
                    color: 'amber',
                  },
                ].map((metric) => (
                  <div className="metric-card" key={metric.label}>
                    <div>
                      <span>{metric.label}</span>
                      <metric.icon size={17} />
                    </div>
                    <strong>{metric.value.toString().padStart(2, '0')}</strong>
                    <small>
                      <i className={metric.color} />
                      {metric.note}
                    </small>
                  </div>
                ))}
              </div>
              <section className="launch-section">
                <div className="section-heading">
                  <div>
                    <h2>你的产品，即刻启程</h2>
                    <p>选择产品类型，配置专属发布流程。</p>
                  </div>
                  <span className="subtle-label">
                    <ShieldCheck size={14} />
                    先检查，再发布
                  </span>
                </div>
                <div className="launch-grid">
                  {productTypes.map((type) => {
                    const item = typeCopy[type];
                    return (
                      <button
                        key={type}
                        className={`launch-card ${item.className}`}
                        onClick={() => create(type)}
                        disabled={!writable}
                      >
                        <div className="launch-card-top">
                          <span className={`type-icon ${type}`}>
                            <ProductIcon type={type} size={27} />
                          </span>
                          <ArrowUpRight size={19} />
                        </div>
                        <div className="launch-eyebrow">{item.eyebrow}</div>
                        <h3>{item.title}</h3>
                        <p>{item.description}</p>
                        <div className="launch-tags">
                          {item.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                        <div className="launch-card-footer">
                          <span>{item.action}</span>
                          <ArrowRight size={16} />
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="section-footnote">
                  <InfoDot />
                  Web 已提供 Vercel 适配器；自有服务器、小程序与 App
                  的执行器正在接入，配置可先保存。
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>最近项目</h2>
                    <span>{projects.length} 个项目</span>
                  </div>
                  <button className="text-button" onClick={() => navigate('projects')}>
                    查看全部
                    <ArrowRight size={14} />
                  </button>
                </div>
                <ProjectList compact />
              </section>
              <div className="bottom-columns">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>最近部署</h2>
                    </div>
                    <button className="text-button" onClick={() => navigate('deployments')}>
                      全部记录
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <DeploymentList compact />
                </section>
                <section className="quickstart-card">
                  <div className="quickstart-title">
                    <Compass size={19} />
                    <h3>三步开始你的第一次发布</h3>
                  </div>
                  {[
                    {
                      title: '连接产品源码',
                      note: '导入 GitHub 仓库',
                      done: projects.length > 0,
                      action: () => create(),
                    },
                    {
                      title: '配置平台凭据',
                      note: '安全连接你的发布账号',
                      done: data.credentials.length > 0,
                      action: () => navigate('integrations'),
                    },
                    {
                      title: '通过检查，开始部署',
                      note: '查看访问地址与发布状态',
                      done: deployments.some((d) => d.status === 'SUCCEEDED'),
                      action: () => navigate('projects'),
                    },
                  ].map((step, index) => (
                    <button key={step.title} className="quickstart-step" onClick={step.action}>
                      <span className={step.done ? 'done' : ''}>
                        {step.done ? <Check size={13} /> : `0${index + 1}`}
                      </span>
                      <div>
                        <strong>{step.title}</strong>
                        <small>{step.note}</small>
                      </div>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </section>
              </div>
            </>
          )}
          {view === 'projects' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">YOUR PRODUCTS</div>
                  <h1>我的项目</h1>
                  <p>管理每个产品的源码、发布目标与部署配置。</p>
                </div>
                <Button onClick={() => create()} disabled={!writable}>
                  <Plus size={17} />
                  新建项目
                </Button>
              </div>
              <div className="filter-bar">
                <div className="filter-tabs">
                  {[
                    { id: 'all', label: '全部项目' },
                    ...productTypes.map((t) => ({ id: t, label: productLabels[t] })),
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setFilter(item.id)}
                      className={filter === item.id ? 'active' : ''}
                    >
                      {item.label}
                      <span>
                        {item.id === 'all'
                          ? projects.length
                          : projects.filter((p) => p.type === item.id).length}
                      </span>
                    </button>
                  ))}
                </div>
                <span className="subtle-label">
                  <SlidersHorizontal size={15} />
                  按创建时间排序
                </span>
              </div>
              <section className={cn(!filteredProjects.length && 'panel')}>
                <ProjectList />
              </section>
            </>
          )}
          {view === 'deployments' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">RELEASE TIMELINE</div>
                  <h1>每一次发布，都有迹可循</h1>
                  <p>构建、上传与可用状态分别记录，不把“已上传”误认为“已上线”。</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => refresh().catch((e) => setError(e.message))}
                >
                  <RefreshCw size={16} />
                  刷新状态
                </Button>
              </div>
              <div className="filter-bar">
                <div className="filter-tabs">
                  {[
                    { id: 'all', label: '全部记录' },
                    { id: 'active', label: '进行中' },
                    { id: 'SUCCEEDED', label: '已完成' },
                    { id: 'attention', label: '待关注' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      className={filter === item.id ? 'active' : ''}
                      onClick={() => setFilter(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <section className="panel">
                <DeploymentList />
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>GitHub 自动触发</h2>
                    <span>接收不等于发布成功</span>
                  </div>
                  <Badge tone={data.system.webhookConfigured ? 'green' : 'neutral'}>
                    {data.system.webhookConfigured ? '验签已配置' : '待配置 Secret'}
                  </Badge>
                </div>
                {data.webhookRuns?.length ? (
                  <div className="webhook-run-list">
                    {data.webhookRuns
                      .filter((run) =>
                        `${run.projectName} ${run.sha}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((run) => (
                        <div className="webhook-run" key={run.id}>
                          <div>
                            <strong>{run.projectName}</strong>
                            <code>
                              {run.ref.replace('refs/heads/', '')} · {run.sha.slice(0, 8)}
                            </code>
                            <p>{run.message}</p>
                          </div>
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
                          <time>{formatDate(run.createdAt)}</time>
                          {run.deploymentIds?.[0] && (
                            <Button
                              size="small"
                              variant="secondary"
                              onClick={() =>
                                api<Deployment>(`/deployments/${run.deploymentIds![0]}`)
                                  .then(setDetail)
                                  .catch((e) => setError(e.message))
                              }
                            >
                              查看部署
                            </Button>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<GitBranch size={27} />}
                    title="还没有自动触发事件"
                    text="在项目设置中开启受保护分支自动部署，并在 GitHub 配置 Webhook；重复投递不会重复发布。"
                  />
                )}
              </section>
            </>
          )}
          {view === 'integrations' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">CONNECTED, SECURELY</div>
                  <h1>连接平台，安全交付</h1>
                  <p>账号属于你，凭据隔离保存。按项目选择所需的发布权限。</p>
                </div>
                <Button disabled={!owner} onClick={() => setCredentialModal('vercel')}>
                  <Plus size={17} />
                  添加凭据
                </Button>
              </div>
              <Notice>
                <LockKeyhole size={16} />
                凭据原文只在创建时提交，保存后仅展示指纹。添加账号不会自动触发发布或开通付费资源。
              </Notice>
              <div className="integration-grid">
                {data.capabilities.map((capability) => {
                  const count = data.credentials.filter(
                    (c) => c.kind === capability.provider,
                  ).length;
                  return (
                    <article className="integration-card" key={capability.provider}>
                      <div>
                        <span className={`integration-icon ${capability.provider}`}>
                          <ProviderIcon provider={capability.provider} size={25} />
                        </span>
                        <Badge tone={capability.executable ? 'blue' : 'neutral'}>
                          {capability.label}
                        </Badge>
                      </div>
                      <h3>{providerLabels[capability.provider]}</h3>
                      <p>{capability.detail}</p>
                      <div className="integration-footer">
                        <small>{count ? `${count} 份凭据已保存` : '未保存凭据'}</small>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!owner}
                          onClick={() => setCredentialModal(capability.provider)}
                        >
                          配置
                          <ArrowUpRight size={14} />
                        </Button>
                      </div>
                    </article>
                  );
                })}
                <article className="integration-card github-card">
                  <div>
                    <span className="integration-icon github">
                      <Github size={26} />
                    </span>
                    <Badge tone={data.system.githubApp ? 'green' : 'neutral'}>
                      {data.system.githubApp ? 'App 已配置' : '公开仓库可读取'}
                    </Badge>
                  </div>
                  <h3>GitHub</h3>
                  <p>
                    从固定 commit SHA 获取源码。生产环境使用限定仓库范围的 GitHub
                    App；本地可使用只读令牌。
                  </p>
                  <div className="integration-footer">
                    <small>源码与发布权限分离</small>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!owner || data.system.mode !== 'local'}
                      onClick={() => setCredentialModal('github')}
                    >
                      配置
                      <ArrowUpRight size={14} />
                    </Button>
                  </div>
                </article>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>凭据保险箱</h2>
                    <span>{data.credentials.length} 份凭据</span>
                  </div>
                  <ShieldCheck size={18} />
                </div>
                {data.credentials.length ? (
                  <div className="credential-list">
                    {data.credentials.map((credential) => (
                      <div className="credential-row" key={credential.id}>
                        <span className="credential-icon">
                          <ProviderIcon provider={credential.kind} />
                        </span>
                        <div className="credential-info">
                          <strong>{credential.name}</strong>
                          <small>
                            {credential.kind === 'github'
                              ? 'GitHub'
                              : providerLabels[credential.kind]}{' '}
                            · 指纹 <code>{credential.fingerprint}</code>
                          </small>
                        </div>
                        <Badge tone={credential.verifiedAt ? 'green' : 'neutral'}>
                          {credential.verifiedAt ? '账号已验证' : '已保存 · 未验证'}
                        </Badge>
                        <div className="button-group">
                          {['github', 'vercel'].includes(credential.kind) && (
                            <Button
                              variant="secondary"
                              size="small"
                              disabled={!owner}
                              loading={busyId === credential.id}
                              onClick={() => credentialAction(credential, 'verify')}
                            >
                              验证账号
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`撤销凭据 ${credential.name}`}
                            disabled={!owner || busyId === credential.id}
                            onClick={() => credentialAction(credential, 'delete')}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<LockKeyhole size={29} strokeWidth={1.4} />}
                    title="还没有保存凭据"
                    text="选择上方平台添加账号，凭据会在服务端加密存储。"
                  />
                )}
              </section>
            </>
          )}
          {view === 'audit' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">WORKSPACE ACTIVITY</div>
                  <h1>操作审计</h1>
                  <p>记录配置、凭据与发布操作，不记录秘密原文。</p>
                </div>
                <Badge dot tone="green">
                  数据库持久化
                </Badge>
              </div>
              <section className="panel">
                {data.audit.length ? (
                  <div className="audit-list">
                    {data.audit.map((entry) => (
                      <div className="audit-row" key={entry.id}>
                        <span>
                          <History size={16} />
                        </span>
                        <div>
                          <strong>{entry.action}</strong>
                          <p>{entry.subject}</p>
                        </div>
                        <small>{entry.actor}</small>
                        <time>{formatDate(entry.createdAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<History size={29} />}
                    title="还没有操作记录"
                    text="首次创建项目或添加凭据后，操作记录将出现在这里。"
                  />
                )}
              </section>
            </>
          )}
          {view === 'settings' && (
            <>
              <div className="page-title">
                <div>
                  <div className="section-eyebrow">WORKSPACE CONTROL</div>
                  <h1>工作区设置</h1>
                  <p>当前运行环境、身份权限与资源边界。</p>
                </div>
                <Badge tone="blue">v0.1.0 · 开发版本</Badge>
              </div>
              <div className="settings-grid">
                <section className="panel settings-panel">
                  <h2>运行环境</h2>
                  {[
                    {
                      label: '工作区模式',
                      value:
                        data.system.mode === 'local'
                          ? '本地工作区（仅回环地址）'
                          : '生产邀请制工作区',
                    },
                    { label: '数据存储', value: data.system.database },
                    { label: '任务调度', value: data.system.queue },
                    { label: '凭据保护', value: 'AES-256-GCM / 独立主密钥' },
                    { label: '当前身份', value: `${user.name} · ${user.role}` },
                    {
                      label: '自动部署',
                      value: `${projects.filter((p) => p.automation?.enabled).length} 个项目已开启 · Owner 按项目授权`,
                    },
                    {
                      label: 'GitHub Webhook',
                      value: data.system.webhookConfigured
                        ? '服务端验签已配置'
                        : '未配置 GITHUB_WEBHOOK_SECRET',
                    },
                  ].map((item) => (
                    <div className="setting-row" key={item.label}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </section>
                <section className="panel settings-panel">
                  <h2>开发版本边界</h2>
                  <div className="setting-note">
                    <ShieldCheck size={19} />
                    <div>
                      <strong>默认不暴露公网</strong>
                      <p>
                        本地登录不适用于公网。生产环境必须提供 HTTPS、数据库、GitHub OAuth
                        和受邀用户名单。
                      </p>
                    </div>
                  </div>
                  <div className="setting-note">
                    <Boxes size={19} />
                    <div>
                      <strong>源码快照限额</strong>
                      <p>
                        每次最多 300 个文件、总计 5 MB、单文件 1 MB。暂不支持 Git 子模块或符号链接。
                      </p>
                    </div>
                  </div>
                  <div className="setting-note">
                    <Workflow size={19} />
                    <div>
                      <strong>部署能力以执行器为准</strong>
                      <p>
                        Vercel
                        可接入真实账号验证；其余通道尚缺执行器。页面不会以动画或假日志冒充真实发布。
                      </p>
                    </div>
                  </div>
                </section>
              </div>
              <Notice tone="warning">
                Apple、微信、Vercel
                等账号费用和平台限制需自行确认。当前未自动配置账单、域名、构建节点或测试成员。
              </Notice>
            </>
          )}
          <footer className="page-footer">
            <span>
              Launchdeck <i>/</i> 从代码到用户手中。
            </span>
            <div>
              <span className="connection-dot" />
              本地数据，真实状态
              <button onClick={openHelp}>
                部署指南
                <ArrowUpRight size={12} />
              </button>
            </div>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {wizard && (
        <ProjectWizard
          project={wizard.project}
          initialType={wizard.type}
          credentials={data.credentials}
          allowConfigure={owner}
          onClose={() => {
            setWizard(null);
            void saved().catch((e) => setError(e.message));
          }}
          onSaved={() => saved()}
          onDeployment={(job) => {
            setWizard(null);
            setDetail(job);
          }}
        />
      )}
      {projectSettings && (
        <ProjectSettings
          initial={projectSettings}
          webhookConfigured={data.system.webhookConfigured}
          webhookUrl={data.system.webhookUrl}
          runs={(data.webhookRuns || []).filter((run) => run.projectId === projectSettings.id)}
          onClose={() => setProjectSettings(null)}
          onSaved={() => saved()}
        />
      )}
      {credentialModal && (
        <CredentialDialog
          initial={credentialModal}
          onClose={() => setCredentialModal(null)}
          onSaved={() => saved('凭据已加密保存')}
        />
      )}
      {detail && (
        <DeploymentDetail
          initial={detail}
          onClose={() => {
            setDetail(null);
            void refresh().catch((e) => setError(e.message));
          }}
          onChanged={refresh}
          writable={writable}
        />
      )}
      {help && (
        <Modal
          open
          title="技术设计与部署指南"
          description="查看已确认的架构方案与当前实现边界。"
          onClose={() => setHelp(false)}
          className="documentation-modal"
        >
          <div className="documentation-content">
            <pre>{doc || '正在读取项目技术文档…'}</pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
function InfoDot() {
  return <span className="info-dot">i</span>;
}
