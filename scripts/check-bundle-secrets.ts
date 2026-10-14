// pnpm check:bundle-secrets  (run after `pnpm build`)
// Fails if the built frontend contains anything that looks like a server secret.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log, run } from './lib/cli.ts';
import { ROOT } from './lib/tenant-fs.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function decodeJwtRole(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { role?: string };
    return payload.role ?? null;
  } catch {
    return null;
  }
}

run(async () => {
  const dist = join(ROOT, 'dist');
  const files = walk(dist).filter((f) => /\.(js|html|css|map|json|txt)$/.test(f));
  const problems: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.map')) problems.push(`${f}: source map опубликован`);
    if (/SUPABASE_SERVICE_ROLE|service_role_key|TELEGRAM_BOT_TOKEN/i.test(text)) problems.push(`${f}: имя серверного секрета`);
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) problems.push(`${f}: Supabase secret key`);
    if (/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/.test(text)) problems.push(`${f}: похоже на Telegram bot token`);
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      if (decodeJwtRole(m[0]) === 'service_role') problems.push(`${f}: JWT с ролью service_role`);
    }
  }
  if (problems.length) {
    problems.forEach((p) => log.err(p));
    return 1;
  }
  log.ok(`Секретов в бандле не найдено (${files.length} файлов проверено)`);
  return 0;
});
