'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  RotateCw,
  StopCircle,
  Terminal,
  Check,
  Radio,
} from 'lucide-react';
import { Button, Modal, Notice, StatusBadge, ProviderIcon, cn } from '../../../packages/ui';
import {
  activeStatuses,
  providerLabels,
  stageLabels,
  type Stage,
  type Deployment,
  type DeploymentEvent,
} from '../../../packages/domain';
import { api, formatDate } from '../lib/api';
export function DeploymentDetail({
  initial,
  onClose,
  onChanged,
  writable,
}: {
  initial: Deployment;
  onClose: () => void;
  onChanged: () => Promise<void>;
  writable: boolean;
}) {
  const [job, setJob] = useState(initial);
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const source = new EventSource(`/api/deployments/${initial.id}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('log', (event) => {
      const item = JSON.parse((event as MessageEvent).data) as DeploymentEvent;
      setEvents((prev) =>
        prev.some((e) => e.sequence === item.sequence) ? prev : [...prev, item].slice(-500),
      );
    });
    source.addEventListener('deployment', (event) => {
      const next = JSON.parse((event as MessageEvent).data) as Deployment | null;
      if (next) setJob(next);
    });
    return () => source.close();
  }, [initial.id]);
  useEffect(
    () => logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    [events.length],
  );
  async function action(name: string) {
    if (
      name === 'cancel' &&
      !window.confirm('确定请求取消这次部署？已经发生的外部发布不能保证撤回。')
    )
      return;
    let confirmProduction = false;
    if (name === 'retry' && job.target.environment === 'production') {
      confirmProduction = window.confirm(
        '确认使用当前目标配置，将相同源码版本重新发布到生产环境？',
      );
      if (!confirmProduction) return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/deployments/${job.id}/${name}`, {
        body: name === 'retry' ? { confirmProduction } : {},
        key: name === 'retry' ? crypto.randomUUID() : undefined,
      });
      await onChanged();
      if (name === 'retry') onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const blob = new Blob(
      [events.map((e) => `[${e.createdAt}] ${e.level.toUpperCase()} ${e.message}`).join('\n')],
      { type: 'text/plain;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `deployment-${job.id}.log`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stages = (
    job.target.provider === 'vercel'
      ? ['PREFLIGHT', 'FETCH', 'UPLOAD', 'BUILD', 'VERIFY', 'DISTRIBUTE']
      : Object.keys(stageLabels)
  ) as Stage[];
  return (
    <Modal
      open
      title={job.projectName}
      description={`部署详情 · ${job.id.slice(0, 8)}`}
      onClose={onClose}
      className="deployment-modal"
    >
      <div className="wizard-content">
        <div className="deployment-meta">
          <StatusBadge status={job.status} />
          <span>
            <ProviderIcon provider={job.target.provider} />
            {providerLabels[job.target.provider]}
          </span>
          <span>
            <GitBranch size={15} />
            {job.sha.slice(0, 12)}
          </span>
          <span>v{job.version}</span>
          <span>{formatDate(job.createdAt)}</span>
        </div>
        <div className="pipeline">
          {stages.map((stage, index) => (
            <div
              key={stage}
              className={cn(
                index < stages.indexOf(job.stage) && 'done',
                stage === job.stage && 'current',
              )}
            >
              <span>{index < stages.indexOf(job.stage) ? <Check size={13} /> : index + 1}</span>
              <small>{stageLabels[stage]}</small>
            </div>
          ))}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {job.error && (
          <Notice tone={job.status === 'UNKNOWN' ? 'warning' : 'error'}>{job.error}</Notice>
        )}
        {job.url && /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(job.url) && (
          <div className="result-url">
            <div>
              <small>访问地址</small>
              <a href={job.url} target="_blank" rel="noopener noreferrer">
                {job.url}
                <ExternalLink size={15} />
              </a>
            </div>
            <Button
              variant="secondary"
              size="icon"
              aria-label="复制访问地址"
              onClick={() =>
                navigator.clipboard
                  .writeText(job.url!)
                  .catch(() => setError('浏览器未允许复制，请手动复制链接'))
              }
            >
              <Copy size={16} />
            </Button>
          </div>
        )}
        <div className="log-panel">
          <div className="log-heading">
            <span>
              <Terminal size={15} />
              部署事件
            </span>
            <small>
              <Radio size={12} />
              {connected ? '实时连接' : '正在重连'}
            </small>
            <button onClick={download} aria-label="下载已加载的日志" disabled={!events.length}>
              <Download size={15} />
            </button>
          </div>
          <div className="log-body">
            {!events.length && <p className="log-empty">正在读取任务事件…</p>}
            {events.map((event) => (
              <div key={event.sequence} className={`log-line ${event.level}`}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                </time>
                <span>{event.message}</span>
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </div>
        <p className="field-hint">
          此处显示经过脱敏的编排事件。Vercel
          原始构建日志请在其控制台查看，避免将构建输出中的秘密带入平台。
        </p>
      </div>
      <div className="wizard-footer">
        <span className="footer-hint">源码固定，状态以发布平台回执为准</span>
        <div className="button-group">
          {writable && activeStatuses.includes(job.status) && job.status !== 'CANCEL_REQUESTED' && (
            <Button variant="secondary" loading={busy} onClick={() => action('cancel')}>
              <StopCircle size={15} />
              请求取消
            </Button>
          )}
          {writable && ['FAILED', 'CANCELLED'].includes(job.status) && (
            <Button loading={busy} onClick={() => action('retry')}>
              <RotateCw size={15} />
              重试此目标
            </Button>
          )}
          {writable && job.status === 'UNKNOWN' && (
            <Button loading={busy} onClick={() => action('reconcile')}>
              核实外部状态
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
