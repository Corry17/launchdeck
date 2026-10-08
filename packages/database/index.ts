import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  activeStatuses,
  assertTransition,
  type Deployment,
  type DeploymentEvent,
  type Status,
  type Project,
  type WebhookRun,
} from '../domain';

export class StoreConflict extends Error {
  constructor(
    readonly code: 'CONFIG_CHANGED' | 'TARGET_BUSY' | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
const schema = `
CREATE TABLE IF NOT EXISTS entities (
  workspace text NOT NULL, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace, kind, id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, workspace text NOT NULL, project_id text NOT NULL, target_id text NOT NULL,
  status text NOT NULL, data jsonb NOT NULL, version integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_target_idx ON jobs(workspace, target_id)
  WHERE status IN ('QUEUED','RUNNING','WAITING_EXTERNAL','WAITING_MANUAL','CANCEL_REQUESTED','UNKNOWN');
CREATE TABLE IF NOT EXISTS events (
  sequence bigserial PRIMARY KEY, deployment_id text NOT NULL REFERENCES jobs(id),
  workspace text NOT NULL, data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job_idx ON events(workspace, deployment_id, sequence);
CREATE TABLE IF NOT EXISTS idempotency (
  workspace text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(workspace, key)
);
CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY REFERENCES jobs(id), sent boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS sessions (
  hash text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  hash text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  workspace text NOT NULL, delivery_id text NOT NULL, fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace,delivery_id)
);
CREATE TABLE IF NOT EXISTS webhook_runs (
  id text PRIMARY KEY, workspace text NOT NULL, project_id text NOT NULL,
  status text NOT NULL, data jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_runs_due_idx ON webhook_runs(status,due_at);
`;
export class Database implements Queryable {
  private constructor(
    private engine: PGlite | Pool,
    readonly embedded: boolean,
  ) {}
  static async open(options: { url?: string; memory?: boolean; directory?: string } = {}) {
    let db: Database;
    if (options.url) db = new Database(new Pool({ connectionString: options.url, max: 8 }), false);
    else {
      const directory = options.memory ? undefined : resolve(options.directory || '.data/postgres');
      if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
      db = new Database(new PGlite(directory), true);
    }
    await db.query(schema);
    return db;
  }
  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    if (this.engine instanceof Pool) {
      const result = await this.engine.query(sql, values);
      return { rows: result.rows as T[] };
    }
    if (!values.length && sql.includes('CREATE TABLE')) {
      await this.engine.exec(sql);
      return { rows: [] };
    }
    return this.engine.query<T>(sql, values);
  }
  async transaction<T>(fn: (query: Queryable) => Promise<T>): Promise<T> {
    if (this.engine instanceof PGlite) return this.engine.transaction((tx) => fn(tx));
    const client = await this.engine.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    if (this.engine instanceof Pool) await this.engine.end();
    else await this.engine.close();
  }
}
export class Store {
  readonly workspace = 'default';
  constructor(readonly db: Database) {}
  async list<T>(kind: 'project' | 'credential' | 'audit') {
    const result = await this.db.query<{ data: T }>(
      'SELECT data FROM entities WHERE workspace=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1000',
      [this.workspace, kind],
    );
    return result.rows.map((row) => row.data);
  }
  async get<T>(kind: string, id: string, q: Queryable = this.db): Promise<T | undefined> {
    return (
      await q.query<{ data: T }>(
        'SELECT data FROM entities WHERE workspace=$1 AND kind=$2 AND id=$3',
        [this.workspace, kind, id],
      )
    ).rows[0]?.data;
  }
  async put(kind: string, data: { id: string }, q: Queryable = this.db) {
    await q.query(
      'INSERT INTO entities(workspace,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(workspace,kind,id) DO UPDATE SET data=excluded.data',
      [this.workspace, kind, data.id, JSON.stringify(data)],
    );
  }
  async remove(kind: string, id: string) {
    await this.db.query('DELETE FROM entities WHERE workspace=$1 AND kind=$2 AND id=$3', [
      this.workspace,
      kind,
      id,
    ]);
  }
  async audit(action: string, subject: string, actor: string, q: Queryable = this.db) {
    await this.put(
      'audit',
      { id: randomUUID(), action, subject, actor, createdAt: new Date().toISOString() } as {
        id: string;
      },
      q,
    );
  }
  async hasActiveProject(projectId: string, q: Queryable = this.db) {
    return (
      (
        await q.query(
          'SELECT id FROM jobs WHERE workspace=$1 AND project_id=$2 AND status=ANY($3) LIMIT 1',
          [this.workspace, projectId, activeStatuses],
        )
      ).rows.length > 0
    );
  }
  async changeProject(
    id: string,
    revision: number,
    change: (project: Project, q: Queryable) => Promise<Project>,
    actor: string,
    action: string,
    allowActive = false,
  ) {
    return this.db.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const current = await this.get<Project>('project', id, q);
      if (!current || (current.revision ?? 0) !== revision)
        throw new StoreConflict('CONFIG_CHANGED', '配置已变化，请刷新项目后重试');
      if (!allowActive && (await this.hasActiveProject(id, q)))
        throw new StoreConflict('TARGET_BUSY', '项目有未结束的部署，暂不能修改配置');
      const updated = {
        ...(await change(current, q)),
        id,
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.put('project', updated, q);
      await this.audit(action, updated.name, actor, q);
      return updated;
    });
  }
  async deleteProject(id: string, actor: string) {
    return this.db.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const project = await this.get<Project>('project', id, q);
      if (!project) throw new StoreConflict('CONFIG_CHANGED', '项目不存在或已删除');
      if (
        (
          await q.query('SELECT id FROM jobs WHERE workspace=$1 AND project_id=$2 LIMIT 1', [
            this.workspace,
            id,
          ])
        ).rows.length
      )
        throw new StoreConflict('TARGET_BUSY', '项目已有部署记录，为保留审计暂不支持删除');
      await q.query('DELETE FROM entities WHERE workspace=$1 AND kind=$2 AND id=$3', [
        this.workspace,
        'project',
        id,
      ]);
      await this.audit('删除未部署项目', project.name, actor, q);
      return { ok: true };
    });
  }
  async deployments() {
    return (
      await this.db.query<{ data: Deployment }>(
        'SELECT data FROM jobs WHERE workspace=$1 ORDER BY created_at DESC LIMIT 500',
        [this.workspace],
      )
    ).rows.map((row) => row.data);
  }
  async deployment(id: string, q: Queryable = this.db): Promise<Deployment | undefined> {
    return (
      await q.query<{ data: Deployment }>('SELECT data FROM jobs WHERE workspace=$1 AND id=$2', [
        this.workspace,
        id,
      ])
    ).rows[0]?.data;
  }
  async event(
    id: string,
    message: string,
    level: DeploymentEvent['level'] = 'info',
    q: Queryable = this.db,
  ) {
    await q.query('INSERT INTO events(workspace,deployment_id,data) VALUES($1,$2,$3)', [
      this.workspace,
      id,
      JSON.stringify({ deploymentId: id, level, message, createdAt: new Date().toISOString() }),
    ]);
  }
  async events(id: string, after = 0): Promise<DeploymentEvent[]> {
    return (
      await this.db.query<{ sequence: string; data: Omit<DeploymentEvent, 'sequence'> }>(
        'SELECT sequence,data FROM events WHERE workspace=$1 AND deployment_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 200',
        [this.workspace, id, after],
      )
    ).rows.map((row) => ({ ...row.data, sequence: Number(row.sequence) }));
  }
  async updateDeployment(id: string, patch: Partial<Deployment>, message?: string) {
    return this.db.transaction(async (q) => {
      const row = (
        await q.query<{ data: Deployment }>(
          'SELECT data FROM jobs WHERE workspace=$1 AND id=$2 FOR UPDATE',
          [this.workspace, id],
        )
      ).rows[0];
      if (!row) throw new Error('部署记录不存在');
      if (patch.status) assertTransition(row.data.status, patch.status);
      const data = { ...row.data, ...patch, id, updatedAt: new Date().toISOString() };
      await q.query(
        'UPDATE jobs SET data=$1,status=$2,version=version+1 WHERE workspace=$3 AND id=$4',
        [JSON.stringify(data), data.status, this.workspace, id],
      );
      if (message) await this.event(id, message, patch.status === 'FAILED' ? 'error' : 'info', q);
      return data;
    });
  }
  async prepareUpload(id: string, previousDeploymentId: string | undefined, message: string) {
    return this.db.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const job = (
        await q.query<{ data: Deployment }>(
          'SELECT data FROM jobs WHERE workspace=$1 AND id=$2 FOR UPDATE',
          [this.workspace, id],
        )
      ).rows[0]?.data;
      if (!job) throw new Error('部署记录不存在');
      const project = await this.get<Project>('project', job.projectId, q);
      const disabled =
        job.trigger?.kind === 'github' &&
        (!project?.automation?.enabled || (project.revision ?? 0) !== (job.project.revision ?? 0));
      if (job.status === 'CANCELLED') return job;
      if (job.status !== 'RUNNING' && job.status !== 'CANCEL_REQUESTED')
        throw new StoreConflict('CONFIG_CHANGED', '部署状态已变化，停止上传');
      if (job.stage === 'UPLOAD') throw new StoreConflict('CONFIG_CHANGED', '上传已开始，请先对账');
      const cancelled = disabled || job.status === 'CANCEL_REQUESTED';
      const updated: Deployment = {
        ...job,
        status: cancelled ? 'CANCELLED' : 'RUNNING',
        stage: cancelled ? job.stage : 'UPLOAD',
        previousDeploymentId,
        updatedAt: new Date().toISOString(),
      };
      await q.query(
        'UPDATE jobs SET status=$1,data=$2,version=version+1 WHERE workspace=$3 AND id=$4',
        [updated.status, JSON.stringify(updated), this.workspace, id],
      );
      await this.event(
        id,
        cancelled ? '上传前已取消，或自动部署配置已关闭/变化。' : message,
        'info',
        q,
      );
      return updated;
    });
  }
  async createRelease(
    key: string,
    fingerprint: string,
    jobs: Deployment[],
    actor: string,
    expectedRevision?: number,
  ): Promise<Deployment[]> {
    return this.db.transaction(async (q) => {
      // 工作区级事务锁同时约束幂等键和跨目标发布，防止并发创建重复任务。
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const existing = (
        await q.query<{ fingerprint: string; result: Deployment[] }>(
          'SELECT fingerprint,result FROM idempotency WHERE workspace=$1 AND key=$2',
          [this.workspace, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new StoreConflict('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
        return existing.result;
      }
      if (expectedRevision !== undefined) {
        const current = await this.get<Project>('project', jobs[0].projectId, q);
        if (!current || (current.revision ?? 0) !== expectedRevision)
          throw new StoreConflict('CONFIG_CHANGED', '预检查期间配置已变化，请重新检查');
        for (const job of jobs) {
          if (
            job.target.credentialId &&
            !(await this.get('credential', job.target.credentialId, q))
          )
            throw new StoreConflict('CONFIG_CHANGED', '发布凭据已撤销，请重新配置');
        }
      }
      for (const job of jobs) {
        await q.query(
          'INSERT INTO jobs(id,workspace,project_id,target_id,status,data) VALUES($1,$2,$3,$4,$5,$6)',
          [
            job.id,
            this.workspace,
            job.projectId,
            `${job.target.provider}:${job.target.environment}:${job.target.config.teamId || ''}:${job.target.config.projectId || job.target.id}`,
            job.status,
            JSON.stringify(job),
          ],
        );
        await q.query('INSERT INTO outbox(id) VALUES($1)', [job.id]);
        await this.event(
          job.id,
          `任务已创建，源码固定为 ${job.sha.slice(0, 12)}；等待执行。`,
          'info',
          q,
        );
      }
      await q.query(
        'INSERT INTO idempotency(workspace,key,fingerprint,result) VALUES($1,$2,$3,$4)',
        [this.workspace, key, fingerprint, JSON.stringify(jobs)],
      );
      await this.audit('创建部署', jobs[0].projectName, actor, q);
      return jobs;
    });
  }
  async idempotent(key: string, fingerprint: string) {
    const row = (
      await this.db.query<{ fingerprint: string; result: Deployment[] }>(
        'SELECT fingerprint,result FROM idempotency WHERE workspace=$1 AND key=$2',
        [this.workspace, key],
      )
    ).rows[0];
    if (row && row.fingerprint !== fingerprint)
      throw new StoreConflict('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
    return row?.result;
  }
  async acceptWebhook(
    deliveryId: string,
    fingerprint: string,
    select: (projects: Project[]) => WebhookRun[],
  ) {
    return this.db.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(74012001)');
      const old = (
        await q.query<{ fingerprint: string }>(
          'SELECT fingerprint FROM webhook_deliveries WHERE workspace=$1 AND delivery_id=$2',
          [this.workspace, deliveryId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new StoreConflict('IDEMPOTENCY_CONFLICT', '事件标识已对应其他内容');
        return { accepted: true, duplicate: true };
      }
      await q.query(
        'INSERT INTO webhook_deliveries(workspace,delivery_id,fingerprint) VALUES($1,$2,$3)',
        [this.workspace, deliveryId, fingerprint],
      );
      const projects = (
        await q.query<{ data: Project }>(
          'SELECT data FROM entities WHERE workspace=$1 AND kind=$2',
          [this.workspace, 'project'],
        )
      ).rows.map((row) => row.data);
      for (const run of select(projects))
        await q.query(
          'INSERT INTO webhook_runs(id,workspace,project_id,status,data) VALUES($1,$2,$3,$4,$5)',
          [run.id, this.workspace, run.projectId, run.status, JSON.stringify(run)],
        );
      return { accepted: true, duplicate: false };
    });
  }
  async webhookDeployments(projectId: string, revision: number, sha: string) {
    return (
      await this.db.query<{ data: Deployment }>(
        "SELECT data FROM jobs WHERE workspace=$1 AND project_id=$2 AND data->>'sha'=$3 AND data->'trigger'->>'kind'='github' AND COALESCE((data->'project'->>'revision')::integer,0)=$4",
        [this.workspace, projectId, sha, revision],
      )
    ).rows.map((row) => row.data);
  }
  async webhookRuns(projectId?: string): Promise<WebhookRun[]> {
    return (
      await this.db.query<{ data: WebhookRun; attempts: number; status: WebhookRun['status'] }>(
        'SELECT data,attempts,status FROM webhook_runs WHERE workspace=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 100',
        [this.workspace, projectId ?? null],
      )
    ).rows.map((row) => ({ ...row.data, attempts: row.attempts, status: row.status }));
  }
  async claimWebhook() {
    const token = randomUUID();
    const row = (
      await this.db.query<{ data: WebhookRun; attempts: number }>(
        `UPDATE webhook_runs SET lease_until=now()+interval '2 minutes',lease_token=$1,attempts=attempts+1,status='PROCESSING' WHERE id=(
      SELECT id FROM webhook_runs WHERE workspace=$2 AND status=ANY($3) AND due_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING data,attempts`,
        [token, this.workspace, ['ACCEPTED', 'DEFERRED', 'PROCESSING']],
      )
    ).rows[0];
    return row ? { run: { ...row.data, attempts: row.attempts }, token } : undefined;
  }
  async finishWebhook(
    run: WebhookRun,
    token: string,
    status: WebhookRun['status'],
    message: string,
    deploymentIds?: string[],
  ) {
    await this.db.query(
      `UPDATE webhook_runs SET status=$1,data=$2,lease_until=NULL,lease_token=NULL,due_at=now()+interval '30 seconds'
      WHERE workspace=$3 AND id=$4 AND lease_token=$5`,
      [
        status,
        JSON.stringify({
          ...run,
          status,
          message,
          deploymentIds,
          updatedAt: new Date().toISOString(),
        }),
        this.workspace,
        run.id,
        token,
      ],
    );
  }
  async claim(id?: string): Promise<Deployment | undefined> {
    const result = await this.db.query<{ data: Deployment }>(
      `UPDATE jobs SET lease_until=now()+interval '90 seconds' WHERE id=(
      SELECT id FROM jobs WHERE workspace=$1 AND status=ANY($2) AND due_at<=now()
      AND (lease_until IS NULL OR lease_until<now()) AND ($3::text IS NULL OR id=$3)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING data`,
      [this.workspace, ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'CANCEL_REQUESTED'], id ?? null],
    );
    return result.rows[0]?.data;
  }
  async releaseLease(id: string, delaySeconds = 15) {
    await this.db.query(
      "UPDATE jobs SET lease_until=NULL,due_at=now()+($1 * interval '1 second') WHERE workspace=$2 AND id=$3",
      [delaySeconds, this.workspace, id],
    );
  }
  async heartbeat(id: string) {
    await this.db.query(
      "UPDATE jobs SET lease_until=now()+interval '90 seconds' WHERE workspace=$1 AND id=$2",
      [this.workspace, id],
    );
  }
  async pendingOutbox() {
    return (await this.db.query<{ id: string }>('SELECT id FROM outbox WHERE sent=false LIMIT 100'))
      .rows;
  }
  async markSent(id: string) {
    await this.db.query('UPDATE outbox SET sent=true WHERE id=$1', [id]);
  }
  async activeForProject(projectId: string) {
    return (
      (
        await this.db.query<{ id: string }>(
          'SELECT id FROM jobs WHERE workspace=$1 AND project_id=$2 LIMIT 1',
          [this.workspace, projectId],
        )
      ).rows.length > 0
    );
  }
  async session(hash: string) {
    return (
      await this.db.query<{
        data: {
          name: string;
          role: 'Owner' | 'Maintainer' | 'Viewer';
          csrf: string;
          githubId?: string;
        };
      }>('SELECT data FROM sessions WHERE hash=$1 AND expires_at>now()', [hash])
    ).rows[0]?.data;
  }
  async saveSession(hash: string, data: object) {
    await this.db.query(
      "INSERT INTO sessions(hash,data,expires_at) VALUES($1,$2,now()+interval '12 hours')",
      [hash, JSON.stringify(data)],
    );
    await this.db.query('DELETE FROM sessions WHERE expires_at<now()');
  }
  async countStatuses() {
    return (
      await this.db.query<{ status: Status; count: string }>(
        'SELECT status,count(*)::text FROM jobs WHERE workspace=$1 GROUP BY status',
        [this.workspace],
      )
    ).rows;
  }
}
