// Identity of the LOCAL Supabase stack the current working directory belongs to (supabase/config.toml).
// Test helpers that talk to Docker containers (psql, edge runtime logs) or to Mailpit derive container names and
// ports from here instead of hard-coding the main stack: a run from an isolated copy of the project (own project_id
// and ports) can therefore never reach the containers or the database of another stack.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalStack {
  projectId: string;
  apiPort: number;
  dbPort: number;
  mailPort: number;
  dbContainer: string;
  edgeRuntimeContainer: string;
  mailUrl: string;
}

/** Mail testing server section: `[local_smtp]` in current CLI configs, `[inbucket]` in older ones. */
const MAIL_SECTIONS = ['local_smtp', 'inbucket'];

/** Minimal reader for the keys we need: `project_id` and `port` inside [api], [db] and the mail server section. */
export function parseLocalStack(toml: string): LocalStack {
  let section = '';
  let projectId: string | null = null;
  const ports: Record<string, number> = {};
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (section === '' && key === 'project_id') projectId = value!.replace(/^"|"$/g, '');
    if (key === 'port' && (section === 'api' || section === 'db')) ports[section] = Number(value);
    if (key === 'port' && MAIL_SECTIONS.includes(section)) ports.mail = Number(value);
  }
  if (!projectId || !/^[A-Za-z0-9_.-]+$/.test(projectId)) throw new Error('supabase/config.toml: project_id is missing or invalid');
  for (const [k, label] of [['api', '[api]'], ['db', '[db]'], ['mail', '[local_smtp]']] as const) {
    if (!Number.isInteger(ports[k])) throw new Error(`supabase/config.toml: ${label} port is missing`);
  }
  return {
    projectId,
    apiPort: ports.api!,
    dbPort: ports.db!,
    mailPort: ports.mail!,
    dbContainer: `supabase_db_${projectId}`,
    edgeRuntimeContainer: `supabase_edge_runtime_${projectId}`,
    mailUrl: `http://127.0.0.1:${ports.mail}`,
  };
}

let cached: LocalStack | null = null;

export function localStack(cwd: string = process.cwd()): LocalStack {
  if (cached) return cached;
  cached = parseLocalStack(readFileSync(join(cwd, 'supabase', 'config.toml'), 'utf8'));
  return cached;
}

/** True when `docker port <container> 5432/tcp` output publishes exactly this stack's DB port on loopback/any. */
export function publishesDbPort(dockerPortOutput: string, dbPort: number): boolean {
  return new RegExp(`(127\\.0\\.0\\.1|0\\.0\\.0\\.0):${dbPort}(\\s|$)`).test(dockerPortOutput);
}
