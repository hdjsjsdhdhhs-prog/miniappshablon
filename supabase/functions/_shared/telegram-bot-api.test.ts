import { describe, expect, it, vi } from 'vitest';
import { BotApiError, canPost, isValidBotToken, maskToken, normalizeChatId, redactToken, TelegramBotApi, verifyConnection } from './telegram-bot-api';

// Fake token in the BotFather format; never valid in Telegram.
const TOKEN = '123456789:FAKE_test_token_aaaaaaaaaaaaaaaaaaaaaaa';

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('token helpers', () => {
  it('validates, masks and redacts tokens', () => {
    expect(isValidBotToken(TOKEN)).toBe(true);
    expect(isValidBotToken('123:short')).toBe(false);
    expect(isValidBotToken(' ' + TOKEN)).toBe(false);
    expect(maskToken(TOKEN)).toBe('123456789:••••aaaa');
    expect(maskToken(TOKEN)).not.toContain('FAKE_test');
    const secret = TOKEN.split(':')[1]!;
    expect(redactToken(`GET https://api.telegram.org/bot${TOKEN}/getMe failed (${secret})`, TOKEN)).toBe(
      'GET https://api.telegram.org/bot<token>/getMe failed (<token>)',
    );
  });

  it('normalizes chat ids and rejects invite links and junk', () => {
    expect(normalizeChatId('@my_orders')).toBe('@my_orders');
    expect(normalizeChatId('my_orders')).toBe('@my_orders');
    expect(normalizeChatId('https://t.me/my_orders')).toBe('@my_orders');
    expect(normalizeChatId(' -1001234567890 ')).toBe('-1001234567890');
    expect(normalizeChatId('https://t.me/+AbCdEf')).toBeNull();
    expect(normalizeChatId('@ab')).toBeNull();
    expect(normalizeChatId('drop table')).toBeNull();
  });
});

describe('TelegramBotApi', () => {
  it('posts to <base>/bot<token>/<method> with HTML parse mode', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, result: { message_id: 9 } }));
    const api = new TelegramBotApi(TOKEN, { baseUrl: 'http://mock.local/', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await api.sendMessage('@c_hat', 'hi')).toEqual({ message_id: 9 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://mock.local/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: '@c_hat', text: 'hi', parse_mode: 'HTML' });
  });

  it.each([
    [401, 'Unauthorized', 'telegram_unauthorized', true],
    [400, 'Bad Request: chat not found', 'chat_not_found', true],
    [403, 'Forbidden: bot is not a member of the channel chat', 'bot_cannot_post', true],
    [429, 'Too Many Requests: retry after 5', 'telegram_rate_limited', false],
    [502, 'Bad Gateway', 'telegram_unavailable', false],
  ])('maps HTTP %i "%s" to %s', async (status, description, code, permanent) => {
    const fetchImpl = async () => reply(status, { ok: false, error_code: status, description });
    const api = new TelegramBotApi(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotApiError);
    expect((err as BotApiError).code).toBe(code);
    expect((err as BotApiError).permanent).toBe(permanent);
  });

  it('network errors never carry the token', async () => {
    const fetchImpl = async () => {
      throw new TypeError(`connect ECONNREFUSED for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    };
    const api = new TelegramBotApi(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await api.sendMessage('@c_hat', 'x').catch((e: unknown) => e)) as BotApiError;
    expect(err.code).toBe('network_error');
    expect(err.description).not.toContain(TOKEN);
    expect(err.description).not.toContain(TOKEN.split(':')[1]);
    expect(JSON.stringify(err)).not.toContain(TOKEN.split(':')[1]);
  });

  it('refuses a malformed token before any request', () => {
    expect(() => new TelegramBotApi('nope')).toThrow(BotApiError);
  });

  /** The error of a sendText that Telegram answered with `status` / `body`. */
  async function failure(status: number, body: unknown): Promise<BotApiError> {
    const api = new TelegramBotApi(TOKEN, { fetchImpl: (async () => reply(status, body)) as unknown as typeof fetch });
    try {
      await api.sendText(42, { text: 'x' });
    } catch (err) {
      return err as BotApiError;
    }
    throw new Error('expected the request to fail');
  }

  it('flood control: a 429 carries the seconds Telegram asks to wait (rounded up); nothing else does', async () => {
    expect(await failure(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } })).toMatchObject({
      code: 'telegram_rate_limited',
      retryAfter: 7,
    });
    expect((await failure(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1.2 } })).retryAfter).toBe(2);
    expect((await failure(429, { ok: false, error_code: 429, description: 'Too Many Requests' })).retryAfter).toBeNull();
    expect((await failure(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: -3 } })).retryAfter).toBeNull();
    expect((await failure(502, { ok: false, error_code: 502, description: 'Bad Gateway' })).retryAfter).toBeNull();
  });

  it.each([
    [403, 'Forbidden: bot was blocked by the user', true],
    [403, 'Forbidden: user is deactivated', true],
    [400, 'Bad Request: chat not found', true],
    [400, 'Bad Request: PEER_ID_INVALID', true],
    [400, 'Bad Request: message is too long', false],
    [429, 'Too Many Requests: retry after 5', false],
    [500, 'Internal Server Error', false],
    [401, 'Unauthorized', false],
  ])('HTTP %i "%s": the recipient can not be written to any more = %s', async (status, description, gone) => {
    expect((await failure(status, { ok: false, error_code: status, description })).recipientGone).toBe(gone);
  });

  const entities = [{ type: 'custom_emoji' as const, offset: 0, length: 2, custom_emoji_id: '5368324170671202286' }];
  const keyboard = { inline_keyboard: [[{ text: 'Open', web_app: { url: 'https://x.dev/s/a/' }, icon_custom_emoji_id: '5368324170671202286' }]] };
  const callOf = (fetchImpl: { mock: { calls: unknown[][] } }, n: number) => fetchImpl.mock.calls[n] as unknown as [string, RequestInit];

  it('sendText sends plain text with custom_emoji entities and never a parse mode', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, result: { message_id: 3 } }));
    const api = new TelegramBotApi(TOKEN, { baseUrl: 'http://mock.local', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await api.sendText(42, { text: '🔥 <b>hi</b>', entities, replyMarkup: keyboard })).toEqual({ message_id: 3 });
    expect(callOf(fetchImpl, 0)[0]).toBe(`http://mock.local/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(callOf(fetchImpl, 0)[1].body))).toEqual({
      chat_id: 42,
      text: '🔥 <b>hi</b>',
      entities,
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    // Without entities and a keyboard the fields are absent.
    await api.sendText(42, { text: 'x', entities: [], replyMarkup: null });
    expect(JSON.parse(String(callOf(fetchImpl, 1)[1].body))).toEqual({ chat_id: 42, text: 'x', link_preview_options: { is_disabled: true } });
  });

  it('sendPhoto uploads a file as multipart/form-data and re-sends a stored one by its file_id', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, result: { message_id: 4, photo: [{ file_id: 'small' }, { file_id: 'big' }] } }));
    const api = new TelegramBotApi(TOKEN, { baseUrl: 'http://mock.local', fetchImpl: fetchImpl as unknown as typeof fetch });
    const photo = new Blob([new Uint8Array(5)], { type: 'image/jpeg' });
    expect(await api.sendPhoto(42, { photo, caption: 'Новинка', captionEntities: entities, replyMarkup: keyboard })).toMatchObject({ message_id: 4 });

    const [url, init] = callOf(fetchImpl, 0);
    expect(url).toBe(`http://mock.local/bot${TOKEN}/sendPhoto`);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('Новинка');
    expect(JSON.parse(String(form.get('caption_entities')))).toEqual(entities);
    expect(JSON.parse(String(form.get('reply_markup')))).toEqual(keyboard);
    expect((form.get('photo') as File).size).toBe(5);
    // The multipart boundary is chosen by fetch: no content type is forced.
    expect(init.headers).toBeUndefined();

    // The file_id Telegram returned: a plain JSON request, nothing is uploaded again.
    await api.sendPhoto(42, { photo: 'big', caption: 'Новинка' });
    expect(JSON.parse(String(callOf(fetchImpl, 1)[1].body))).toEqual({ chat_id: 42, caption: 'Новинка', photo: 'big' });
  });
});

describe('rights check', () => {
  it('channels need an admin with can_post_messages; groups need a non-muted member', () => {
    const channel = { id: 1, type: 'channel' as const };
    const group = { id: 2, type: 'supergroup' as const };
    expect(canPost(channel, { status: 'administrator', can_post_messages: true })).toBe(true);
    expect(canPost(channel, { status: 'administrator', can_post_messages: false })).toBe(false);
    expect(canPost(channel, { status: 'member' })).toBe(false);
    expect(canPost(group, { status: 'member' })).toBe(true);
    expect(canPost(group, { status: 'restricted', can_send_messages: false })).toBe(false);
    expect(canPost(group, { status: 'left' })).toBe(false);
  });

  it('verifyConnection reports bot_cannot_post when the bot was not added', async () => {
    const answers: Record<string, unknown> = {
      getMe: { ok: true, result: { id: 123456789, is_bot: true, username: 'shop_bot' } },
      getChat: { ok: true, result: { id: -100, type: 'channel', title: 'Orders' } },
      getChatMember: { ok: true, result: { status: 'left' } },
    };
    const fetchImpl = async (url: string) => reply(200, answers[url.split('/').pop()!]);
    const api = new TelegramBotApi(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(verifyConnection(api, '@orders_chat')).rejects.toMatchObject({ code: 'bot_cannot_post' });
    answers.getChatMember = { ok: true, result: { status: 'administrator', can_post_messages: true } };
    await expect(verifyConnection(api, '@orders_chat')).resolves.toMatchObject({ bot: { username: 'shop_bot' }, chat: { title: 'Orders' } });
  });
});
