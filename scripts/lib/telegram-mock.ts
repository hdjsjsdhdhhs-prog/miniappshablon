// Local mock of the Telegram Bot API for tests and local development. It never talks to Telegram.
// The local Edge Runtime (Docker) reaches it through host.docker.internal (see scripts/supabase-start.ts).
//
// Behaviour is driven by the fake token / chat id, so parallel scenarios do not share state:
//   token secret starting with "UNAUTHORIZED"  → 401 for every method (wrong token)
//   chat id containing "missing"               → getChat: 400 "chat not found"
//   chat id containing "noperm"                → bot is not a member: cannot post (403 on sendMessage)
//   chat id containing "alwaysfail"            → sendMessage: 500 every time
//   POST /__mock/fail { chat_id, times, status? } → the next `times` sendMessage calls to that chat fail (500 or `status`)
// Bot connection (per numeric bot id): getWebhookInfo / setWebhook / deleteWebhook, getChatMenuButton /
// setChatMenuButton keep their state in memory.
//   GET  /__mock/bots/<id>                     → { webhook: { url, secret_token, allowed_updates } | null, menu_button }
//   POST /__mock/bots/<id> { webhook_url? }    → simulates a webhook set by ANOTHER service (no secret known here)
// Inspection: GET /__mock/health, GET /__mock/messages?chat_id=…, DELETE /__mock/messages.
// Tokens are never stored or printed: messages and bot state keep only the numeric bot id.
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { localStack } from './local-stack.ts';

export const TELEGRAM_MOCK_PORT = Number(process.env.TELEGRAM_MOCK_PORT ?? 54390);
export const TELEGRAM_MOCK_URL = `http://127.0.0.1:${TELEGRAM_MOCK_PORT}`;
/** Windows Docker Desktop provides this host alias; Linux uses the fixed gateway of the test bridge. */
export const TELEGRAM_MOCK_DOCKER_GATEWAY = '172.30.0.1';
export const TELEGRAM_MOCK_DOCKER_NETWORK = process.env.TELEGRAM_MOCK_DOCKER_NETWORK ?? 'tma-telegram-mock';
export const TELEGRAM_MOCK_ID = 'tma-telegram-bot-api-mock';

export function telegramMockApiBase(platform = process.platform): string {
  const host = platform === 'win32' ? 'host.docker.internal' : TELEGRAM_MOCK_DOCKER_GATEWAY;
  return `http://${host}:${TELEGRAM_MOCK_PORT}`;
}

export const LOCAL_TELEGRAM_API_BASE = telegramMockApiBase();

export interface MockMessage {
  message_id: number;
  bot_id: number;
  chat_id: string;
  text: string;
  parse_mode: string | null;
  reply_markup: unknown;
  at: string;
}

export interface MockBotState {
  webhook: { url: string; secret_token: string | null; allowed_updates: unknown } | null;
  menu_button: { type: string; text?: string; web_app?: { url: string } };
}

export interface TelegramMock {
  url: string;
  /** True when this process started the server (false: an already running mock was reused). */
  owned: boolean;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function tgError(res: ServerResponse, status: number, description: string) {
  send(res, status, { ok: false, error_code: status, description });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function chatNumericId(chat: string): number {
  if (/^-?\d+$/.test(chat)) return Number(chat);
  let h = 0;
  for (const ch of chat) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000_000;
  return -1_000_000_000_000 - h;
}

export function createTelegramMockServer(log: (line: string) => void = () => undefined): Server {
  const messages: MockMessage[] = [];
  const failures = new Map<string, { times: number; status: number }>();
  const bots = new Map<number, MockBotState>();
  const botState = (id: number): MockBotState => {
    let s = bots.get(id);
    if (!s) {
      s = { webhook: null, menu_button: { type: 'default' } };
      bots.set(id, s);
    }
    return s;
  };
  let nextMessageId = 1;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mock');
      if (url.pathname === '/__mock/health') return send(res, 200, { mock: TELEGRAM_MOCK_ID });
      if (url.pathname === '/__mock/messages') {
        if (req.method === 'DELETE') {
          messages.length = 0;
          return send(res, 200, { ok: true });
        }
        const chat = url.searchParams.get('chat_id');
        return send(res, 200, { messages: chat ? messages.filter((m) => m.chat_id === chat) : messages });
      }
      if (url.pathname === '/__mock/fail' && req.method === 'POST') {
        const body = await readJson(req);
        failures.set(String(body.chat_id), { times: Number(body.times ?? 1), status: Number(body.status ?? 500) });
        return send(res, 200, { ok: true });
      }
      const botPath = /^\/__mock\/bots\/(\d{5,12})$/.exec(url.pathname);
      if (botPath) {
        const state = botState(Number(botPath[1]));
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (typeof body.webhook_url === 'string') state.webhook = body.webhook_url ? { url: body.webhook_url, secret_token: null, allowed_updates: null } : null;
        }
        return send(res, 200, state);
      }

      const m = /^\/bot(\d{5,12}):([A-Za-z0-9_-]{30,64})\/(\w+)$/.exec(url.pathname);
      if (!m) return tgError(res, 404, 'Not Found');
      const [, botIdRaw, secret, method] = m;
      const botId = Number(botIdRaw);
      if (secret!.startsWith('UNAUTHORIZED')) return tgError(res, 401, 'Unauthorized');
      const body = await readJson(req);
      const chat = body.chat_id === undefined ? '' : String(body.chat_id);

      switch (method) {
        case 'getMe':
          return send(res, 200, { ok: true, result: { id: botId, is_bot: true, first_name: 'Mock Bot', username: `mock_${botId}_bot` } });
        case 'getChat':
          if (chat.includes('missing')) return tgError(res, 400, 'Bad Request: chat not found');
          return send(res, 200, {
            ok: true,
            result: {
              id: chatNumericId(chat),
              type: chat.startsWith('@') ? 'channel' : 'supergroup',
              title: `Mock chat ${chat}`,
              ...(chat.startsWith('@') ? { username: chat.slice(1) } : {}),
            },
          });
        case 'getChatMember':
          if (chat.includes('missing')) return tgError(res, 400, 'Bad Request: chat not found');
          if (chat.includes('noperm')) return send(res, 200, { ok: true, result: { status: 'left', user: { id: botId } } });
          return send(res, 200, { ok: true, result: { status: 'administrator', can_post_messages: true, user: { id: botId } } });
        case 'sendMessage': {
          if (chat.includes('missing')) return tgError(res, 400, 'Bad Request: chat not found');
          if (chat.includes('noperm')) return tgError(res, 403, 'Forbidden: bot is not a member of the channel chat');
          const fail = failures.get(chat);
          if (chat.includes('alwaysfail') || (fail && fail.times > 0)) {
            if (fail && fail.times > 0) failures.set(chat, { ...fail, times: fail.times - 1 });
            const status = fail?.status ?? 500;
            return tgError(res, status, status === 403 ? 'Forbidden: bot was blocked by the user' : 'Internal Server Error (mock)');
          }
          const msg: MockMessage = {
            message_id: nextMessageId++,
            bot_id: botId,
            chat_id: chat,
            text: String(body.text ?? ''),
            parse_mode: body.parse_mode ? String(body.parse_mode) : null,
            reply_markup: body.reply_markup ?? null,
            at: new Date().toISOString(),
          };
          messages.push(msg);
          log(`[telegram-mock] sendMessage → ${chat}: ${msg.text.split('\n')[0]}`);
          return send(res, 200, { ok: true, result: { message_id: msg.message_id, chat: { id: chatNumericId(chat) }, text: msg.text } });
        }
        case 'getWebhookInfo': {
          const hook = botState(botId).webhook;
          return send(res, 200, { ok: true, result: { url: hook?.url ?? '', has_custom_certificate: false, pending_update_count: 0 } });
        }
        case 'setWebhook': {
          const hookUrl = String(body.url ?? '');
          if (!/^https?:\/\//.test(hookUrl)) return tgError(res, 400, 'Bad Request: bad webhook: invalid URL');
          const secret = body.secret_token === undefined ? null : String(body.secret_token);
          if (secret !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) return tgError(res, 400, 'Bad Request: bad webhook: secret token contains unallowed characters');
          botState(botId).webhook = { url: hookUrl, secret_token: secret, allowed_updates: body.allowed_updates ?? null };
          return send(res, 200, { ok: true, result: true, description: 'Webhook was set' });
        }
        case 'deleteWebhook':
          botState(botId).webhook = null;
          return send(res, 200, { ok: true, result: true, description: 'Webhook was deleted' });
        case 'setChatMenuButton': {
          const button = (typeof body.menu_button === 'string' ? JSON.parse(body.menu_button) : body.menu_button) as MockBotState['menu_button'] | undefined;
          botState(botId).menu_button = button?.type ? button : { type: 'default' };
          return send(res, 200, { ok: true, result: true });
        }
        case 'getChatMenuButton':
          return send(res, 200, { ok: true, result: botState(botId).menu_button });
        default:
          return tgError(res, 404, 'Not Found: method not found');
      }
    } catch {
      return tgError(res, 500, 'mock error');
    }
  });
}

export async function isTelegramMockRunning(url = TELEGRAM_MOCK_URL): Promise<boolean> {
  try {
    const res = await fetch(`${url}/__mock/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && ((await res.json()) as { mock?: string }).mock === TELEGRAM_MOCK_ID;
  } catch {
    return false;
  }
}

/**
 * Reuses a running mock (e.g. the one started for local development) or starts a new one.
 * Listens on all interfaces because Docker Desktop forwards host.docker.internal to the host's
 * network address, not to 127.0.0.1. It holds no secrets and only answers with fake data.
 */
export async function ensureTelegramMock(log?: (line: string) => void): Promise<TelegramMock> {
  if (await isTelegramMockRunning()) return { url: TELEGRAM_MOCK_URL, owned: false, close: async () => undefined };
  const server = createTelegramMockServer(log);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(TELEGRAM_MOCK_PORT, '0.0.0.0', () => resolve());
  });
  return {
    url: TELEGRAM_MOCK_URL,
    owned: true,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** TELEGRAM_API_BASE the running local Edge Runtime container was started with (null if unknown). */
/** Container of THIS checkout's stack (supabase/config.toml project_id), so an isolated copy checks its own runtime. */
export function edgeRuntimeTelegramBase(container = localStack().edgeRuntimeContainer): string | null {
  try {
    const out = execFileSync('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('TELEGRAM_API_BASE='));
    return line ? line.slice('TELEGRAM_API_BASE='.length) : null;
  } catch {
    return null;
  }
}

/** Test runs that create orders must not let the local Edge Runtime talk to api.telegram.org. */
export function assertEdgeRuntimeUsesMock(): void {
  const base = edgeRuntimeTelegramBase();
  if (base !== LOCAL_TELEGRAM_API_BASE) {
    throw new Error(
      `Local Edge Runtime must use the mock Bot API (${LOCAL_TELEGRAM_API_BASE}), got ${base ?? 'unset'}. ` +
        'Restart the local stack with `pnpm db:stop && pnpm db:start`.',
    );
  }
}

/** Fails before tests write data if the Linux Supabase network does not route to this host gateway. */
export function assertTelegramMockDockerNetwork(): void {
  const gateway = execFileSync(
    'docker',
    ['network', 'inspect', TELEGRAM_MOCK_DOCKER_NETWORK, '--format', '{{(index .IPAM.Config 0).Gateway}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (gateway !== TELEGRAM_MOCK_DOCKER_GATEWAY) {
    throw new Error(
      `Docker network ${TELEGRAM_MOCK_DOCKER_NETWORK} must use gateway ${TELEGRAM_MOCK_DOCKER_GATEWAY}, got ${gateway || 'unset'}. ` +
        'Restart the local stack with `pnpm db:stop && pnpm db:start`.',
    );
  }
}

export async function mockMessages(chatId: string): Promise<MockMessage[]> {
  const res = await fetch(`${TELEGRAM_MOCK_URL}/__mock/messages?chat_id=${encodeURIComponent(chatId)}`);
  return ((await res.json()) as { messages: MockMessage[] }).messages;
}

export async function mockFailNext(chatId: string, times: number, status = 500): Promise<void> {
  await fetch(`${TELEGRAM_MOCK_URL}/__mock/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, times, status }),
  });
}

/** Webhook / Menu Button state the mock keeps for one bot id. */
export async function mockBotState(botId: number | string): Promise<MockBotState> {
  return (await (await fetch(`${TELEGRAM_MOCK_URL}/__mock/bots/${botId}`)).json()) as MockBotState;
}

/** Simulates a webhook set on the bot by another service ('' removes it). */
export async function mockSetForeignWebhook(botId: number | string, url: string): Promise<void> {
  await fetch(`${TELEGRAM_MOCK_URL}/__mock/bots/${botId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook_url: url }),
  });
}
