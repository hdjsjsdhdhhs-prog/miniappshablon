import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RegistrationApi from '../owner-registration-api';
import { OwnerRegistrationPage } from './OwnerRegistrationPage';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_';

const api = vi.hoisted(() => ({ preview: vi.fn(), register: vi.fn(), claim: vi.fn() }));
const auth = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn(), session: null as null | { user: { email: string } } }));
const sb = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../owner-registration-api', async (importOriginal) => ({
  ...(await importOriginal<typeof RegistrationApi>()),
  ownerRegistrationApi: api,
}));
vi.mock('../auth', () => ({
  useSession: () => ({ session: auth.session, loading: false }),
  signIn: auth.signIn,
  signOut: auth.signOut,
}));
vi.mock('@/lib/supabase', () => ({
  publicImageUrl: () => null,
  supabase: { auth: { getSession: sb.getSession } },
}));

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/register']}>
        <Routes>
          <Route path="/admin/register" element={<OwnerRegistrationPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const active = { status: 'active', shop: { name: 'Mint Lab', logo_path: null }, email_bound: false, expires_at: '2026-11-21T10:00:00Z' };
const done = (slug = 'mint-lab') => ({ status: 'completed', via: 'registration', shop: { slug, name: 'Mint Lab' } });

async function fill(email = 'buyer@example.com', password = 'correct-horse-battery', repeat = password) {
  await userEvent.type(screen.getByTestId('owner-reg-email'), email);
  await userEvent.type(screen.getByTestId('owner-reg-password'), password);
  await userEvent.type(screen.getByTestId('owner-reg-repeat'), repeat);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.session = null;
  window.history.replaceState(null, '', `/admin/register#${TOKEN}`);
  api.preview.mockResolvedValue(active);
  sb.getSession.mockResolvedValue({ data: { session: { access_token: 'user-access-token' } } });
});

describe('Страница регистрации владельца: ссылка', () => {
  it('without a token in the address nothing is requested and nothing can be submitted', async () => {
    window.history.replaceState(null, '', '/admin/register');
    renderPage();
    expect(await screen.findByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'invalid');
    expect(api.preview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('owner-reg-form')).not.toBeInTheDocument();
  });

  it('a malformed token is treated as no token (never sent to the server)', async () => {
    window.history.replaceState(null, '', '/admin/register#not-a-token');
    renderPage();
    expect(await screen.findByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'invalid');
    expect(api.preview).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'Срок действия ссылки истёк'],
    ['revoked', 'Ссылка отозвана'],
    ['used', 'Ссылка уже использована'],
    ['unavailable', 'Ссылка больше не действует'],
    ['busy', 'Магазин сейчас занят'],
    ['invalid', 'Ссылка недействительна'],
  ])('a %s link shows a clear message and no form', async (status, title) => {
    api.preview.mockResolvedValue({ status });
    renderPage();
    const card = await screen.findByTestId('owner-reg-dead');
    expect(card).toHaveTextContent(title);
    expect(card).toHaveAttribute('data-status', status);
    expect(screen.queryByTestId('owner-reg-form')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти по паролю' })).toHaveAttribute('href', '/admin');
  });

  it('a failed check offers a retry instead of a dead end', async () => {
    api.preview.mockRejectedValueOnce(new Error('offline'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Повторить/ }));
    expect(await screen.findByTestId('owner-reg-form')).toBeInTheDocument();
  });

  it('shows the shop name, removes the token from the address bar and shows no internal id', async () => {
    renderPage();
    expect(await screen.findByTestId('owner-reg-shop')).toHaveTextContent('Mint Lab');
    expect(api.preview).toHaveBeenCalledWith(TOKEN);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  });
});

describe('Страница регистрации владельца: форма', () => {
  it('validates the e-mail, the password strength and the repeat before anything is sent', async () => {
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByText('Введите электронную почту')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('owner-reg-email'), 'not-an-email');
    await userEvent.type(screen.getByTestId('owner-reg-password'), 'short');
    await userEvent.type(screen.getByTestId('owner-reg-repeat'), 'other');
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByText('Введите корректный адрес электронной почты')).toBeInTheDocument();
    expect(screen.getByText(/Пароль — не короче 10 символов/)).toBeInTheDocument();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('refuses two different passwords', async () => {
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill('buyer@example.com', 'correct-horse-battery', 'correct-horse-batterY');
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByText('Пароли не совпадают')).toBeInTheDocument();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('tells honestly that the e-mail is not verified and is the login and the recovery address', async () => {
    renderPage();
    await screen.findByTestId('owner-reg-form');
    expect(screen.getByText(/Почту мы не проверяем/)).toBeInTheDocument();
    expect(screen.getByTestId('owner-reg-email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByTestId('owner-reg-password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('registers, signs in with the chosen password and opens the admin of THE shop the server named', async () => {
    api.register.mockResolvedValue(done('mint-lab'));
    auth.signIn.mockResolvedValue(undefined);
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops/mint-lab'));
    // Only what the form holds goes to the server (+ the link token): no shop id, no slug, no role.
    expect(api.register).toHaveBeenCalledOnce();
    expect(api.register).toHaveBeenCalledWith(TOKEN, { email: 'buyer@example.com', password: 'correct-horse-battery', passwordConfirm: 'correct-horse-battery' });
    expect(auth.signIn).toHaveBeenCalledWith('buyer@example.com', 'correct-horse-battery');
  });

  it('locks the form while the request runs: a double click sends one request', async () => {
    let resolve!: (v: unknown) => void;
    api.register.mockReturnValue(new Promise((r) => (resolve = r)));
    auth.signIn.mockResolvedValue(undefined);
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    const button = screen.getByTestId('owner-reg-submit');
    await userEvent.dblClick(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Регистрируем…');
    expect(api.register).toHaveBeenCalledTimes(1);
    resolve(done());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops/mint-lab'));
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('keeps the account when the automatic sign-in fails: it says so and offers the login page', async () => {
    api.register.mockResolvedValue(done());
    auth.signIn.mockRejectedValue(new Error('network'));
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    const card = await screen.findByTestId('owner-reg-created');
    expect(card).toHaveTextContent('Аккаунт создан');
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/admin');
  });
});

describe('Страница регистрации владельца: сбои и повторы', () => {
  it('a network error is explained and the retry is safe; if the first request had gone through, the buyer is signed in', async () => {
    const { OwnerRegistrationError } = await vi.importActual<typeof RegistrationApi>('../owner-registration-api');
    api.register.mockRejectedValueOnce(new OwnerRegistrationError(0, 'network_error')).mockRejectedValueOnce(new OwnerRegistrationError(410, 'invite_used'));
    auth.signIn.mockResolvedValue(undefined);
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByTestId('owner-reg-error')).toHaveTextContent('повторная отправка безопасна');
    expect(auth.signIn).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    // "Already used" after an unanswered attempt: the buyer's own password proves the account is theirs.
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops'));
    expect(auth.signIn).toHaveBeenCalledWith('buyer@example.com', 'correct-horse-battery');
    expect(api.register).toHaveBeenCalledTimes(2);
  });

  it('"already used" without an earlier unanswered attempt is only a message — nobody is signed in', async () => {
    const { OwnerRegistrationError } = await vi.importActual<typeof RegistrationApi>('../owner-registration-api');
    api.register.mockRejectedValue(new OwnerRegistrationError(410, 'invite_used'));
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'used');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('a link that expires or is revoked while the form is open ends in the matching message', async () => {
    const { OwnerRegistrationError } = await vi.importActual<typeof RegistrationApi>('../owner-registration-api');
    api.register.mockRejectedValue(new OwnerRegistrationError(410, 'invite_expired'));
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'expired');
  });

  it('a rate limit says when to retry; a weak password (server policy) is explained', async () => {
    const { OwnerRegistrationError } = await vi.importActual<typeof RegistrationApi>('../owner-registration-api');
    api.register.mockRejectedValueOnce(new OwnerRegistrationError(429, 'rate_limited', 300)).mockRejectedValueOnce(new OwnerRegistrationError(422, 'weak_password'));
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill();
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    expect(await screen.findByTestId('owner-reg-error')).toHaveTextContent('Повторите через 5 мин');
    await userEvent.click(screen.getByTestId('owner-reg-submit'));
    await waitFor(() => expect(screen.getByTestId('owner-reg-error')).toHaveTextContent('Пароль слишком простой'));
  });

  it('an e-mail that already has an account switches to sign-in; signing in applies the link to that account', async () => {
    const { OwnerRegistrationError } = await vi.importActual<typeof RegistrationApi>('../owner-registration-api');
    api.register.mockRejectedValue(new OwnerRegistrationError(409, 'account_exists'));
    api.claim.mockResolvedValue({ status: 'completed', via: 'claim', shop: { slug: 'mint-lab', name: 'Mint Lab' } });
    auth.signIn.mockResolvedValue(undefined);
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await fill('existing@example.com');
    await userEvent.click(screen.getByTestId('owner-reg-submit'));

    expect(await screen.findByTestId('owner-reg-signin-form')).toBeInTheDocument();
    expect(screen.getByTestId('owner-reg-error')).toHaveTextContent('Аккаунт с этой почтой уже есть');
    expect(screen.getByTestId('owner-claim-email')).toHaveValue('existing@example.com');
    await userEvent.type(screen.getByTestId('owner-claim-password'), 'my-old-password');
    await userEvent.click(screen.getByTestId('owner-claim-submit'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops/mint-lab'));
    expect(auth.signIn).toHaveBeenCalledWith('existing@example.com', 'my-old-password');
    // The link is applied with the buyer's own access token — the server learns the account from it, not from the page.
    expect(api.claim).toHaveBeenCalledWith(TOKEN, 'user-access-token');
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('a wrong password in the sign-in form does not touch the link', async () => {
    auth.signIn.mockRejectedValue(new Error('invalid'));
    renderPage();
    await screen.findByTestId('owner-reg-form');
    await userEvent.click(screen.getByTestId('owner-reg-to-signin'));
    await userEvent.type(screen.getByTestId('owner-claim-email'), 'existing@example.com');
    await userEvent.type(screen.getByTestId('owner-claim-password'), 'wrong');
    await userEvent.click(screen.getByTestId('owner-claim-submit'));
    expect(await screen.findByTestId('owner-reg-error')).toHaveTextContent('Неверная почта или пароль');
    expect(api.claim).not.toHaveBeenCalled();
  });

  it('a visitor who is already signed in is offered the link for that account, and may sign out to register a new one', async () => {
    auth.session = { user: { email: 'me@example.com' } };
    api.claim.mockResolvedValue({ status: 'completed', via: 'claim', shop: { slug: 'mint-lab', name: 'Mint Lab' } });
    renderPage();
    const banner = await screen.findByTestId('owner-reg-session');
    expect(banner).toHaveTextContent('me@example.com');
    await userEvent.click(screen.getByTestId('owner-reg-claim-session'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops/mint-lab'));
    expect(api.claim).toHaveBeenCalledWith(TOKEN, 'user-access-token');
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});
