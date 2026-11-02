import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLocalStack, publishesDbPort } from './local-stack.ts';

describe('parseLocalStack', () => {
  it('reads the project config of this repository', () => {
    const s = parseLocalStack(readFileSync('supabase/config.toml', 'utf8'));
    expect(s.projectId).toBe('tma-shop-showcase');
    expect(s).toMatchObject({ apiPort: 54321, dbPort: 54322, mailPort: 54324, dbContainer: 'supabase_db_tma-shop-showcase' });
    expect(s.edgeRuntimeContainer).toBe('supabase_edge_runtime_tma-shop-showcase');
  });

  it('derives container names and ports of an isolated copy', () => {
    const s = parseLocalStack(
      ['project_id = "tma-iso-x" # comment', '[api]', 'port = 64321', '[db]', 'port = 64322', 'shadow_port = 64320', '[local_smtp]', 'port = 64324', '[studio]', 'port = 64323'].join('\n'),
    );
    expect(s).toMatchObject({ projectId: 'tma-iso-x', apiPort: 64321, dbPort: 64322, mailPort: 64324, dbContainer: 'supabase_db_tma-iso-x', mailUrl: 'http://127.0.0.1:64324' });
  });

  it('refuses a config without project_id or ports', () => {
    expect(() => parseLocalStack('[api]\nport = 1')).toThrow(/project_id/);
    expect(() => parseLocalStack('project_id = "x"\n[api]\nport = 1')).toThrow(/\[db\]/);
    expect(() => parseLocalStack('project_id = "x"\n[api]\nport = 1\n[db]\nport = 2')).toThrow(/local_smtp/);
    // Older configs name the mail server section [inbucket].
    expect(parseLocalStack('project_id = "x"\n[api]\nport = 1\n[db]\nport = 2\n[inbucket]\nport = 3').mailPort).toBe(3);
  });

  it('matches only the exact published DB port', () => {
    expect(publishesDbPort('0.0.0.0:54322\n[::]:54322', 54322)).toBe(true);
    expect(publishesDbPort('0.0.0.0:64322', 54322)).toBe(false);
    expect(publishesDbPort('0.0.0.0:543220', 54322)).toBe(false);
  });
});
