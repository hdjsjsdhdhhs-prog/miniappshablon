// Runtime-agnostic validation of Telegram Mini App initData (Deno Edge Functions and Node tests).
// Algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   data_check_string = all fields except `hash`, sorted by key, "key=value" joined with "\n"
//   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
//   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
  startParam?: string;
  queryId?: string;
}

export type InitDataErrorCode =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'from_future'
  | 'no_user';

export class InitDataError extends Error {
  readonly code: InitDataErrorCode;
  constructor(code: InitDataErrorCode) {
    super(`telegram_init_data_${code}`);
    this.code = code;
  }
}

export interface ValidateOptions {
  /** Maximum accepted age of auth_date in seconds. */
  maxAgeSec: number;
  /** Current unix time in seconds (injectable for tests). */
  nowSec?: number;
}

const encoder = new TextEncoder();

async function hmacSha256(key: Uint8Array | ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  return pairs.sort().join('\n');
}

async function computeHash(dataCheckString: string, botToken: string): Promise<string> {
  const secretKey = await hmacSha256(encoder.encode('WebAppData'), botToken);
  return toHex(await hmacSha256(secretKey, dataCheckString));
}

export async function validateInitData(
  raw: string | null | undefined,
  botToken: string,
  options: ValidateOptions,
): Promise<VerifiedInitData> {
  if (!raw || raw.trim() === '') throw new InitDataError('missing');
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    throw new InitDataError('malformed');
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataError('malformed');

  const expected = await computeHash(buildDataCheckString(params), botToken);
  if (!timingSafeEqualHex(expected, hash)) throw new InitDataError('bad_signature');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) throw new InitDataError('malformed');
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (authDate - now > 60) throw new InitDataError('from_future');
  if (now - authDate > options.maxAgeSec) throw new InitDataError('expired');

  const userRaw = params.get('user');
  if (!userRaw) throw new InitDataError('no_user');
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    throw new InitDataError('malformed');
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new InitDataError('no_user');

  return {
    user,
    authDate,
    startParam: params.get('start_param') ?? undefined,
    queryId: params.get('query_id') ?? undefined,
  };
}

/**
 * Produces a correctly signed initData string. Used ONLY by automated tests and local E2E with a
 * local test token; production initData is always produced by the Telegram client.
 */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  params.delete('hash');
  const hash = await computeHash(buildDataCheckString(params), botToken);
  params.set('hash', hash);
  return params.toString();
}
