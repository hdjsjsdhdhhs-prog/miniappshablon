import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryErrorText } from '../password-recovery';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { LoginPage } from './LoginPage';
import { SetPasswordPage } from './SetPasswordPage';

const sb = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));
const auth = vi.hoisted(() => ({ session: null as null | { user: { email: string } } }));
/** lib/supabase.ts takes this flag at start-up, before supabase-js strips the fragment of the e-mail link. */
const flags = vi.hoisted(() => ({ recovery: false }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { resetPasswordForEmail: sb.resetPasswordForEmail, updateUser: sb.updateUser, signOut: sb.signOut } },
  get openedByRecoveryLink() {
    return flags.recovery;
  },
}));
vi.mock('../auth', () => ({
  useSession: () => ({ session: auth.session, loading: false }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<LoginPage />} />
        <Route path="/admin/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/admin/set-password" element={<SetPasswordPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.session = null;
  flags.recovery = false;
  sb.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  sb.updateUser.mockResolvedValue({ data: {}, error: null });
  sb.signOut.mockResolvedValue({ error: null });
  window.history.replaceState(null, '', '/admin');
});
afterEach(() => vi.useRealTimers());

describe('Вход: «Забыли пароль?»', () => {
  it('the login page links to the recovery page', async () => {
    renderAt('/admin');
    await userEvent.click(screen.getByRole('link', { name: 'Забыли пароль?' }));
    expect(await screen.findByTestId('forgot-password')).toBeInTheDocument();
  });

  it('says there is no open registration', () => {
    renderAt('/admin');
    expect(screen.getByText(/Открытой регистрации нет/)).toBeInTheDocument();
  });
});

describe('Восстановление пароля: запрос письма', () => {
  it('asks Supabase for the standard recovery mail with a redirect to the set-password page of THIS app', async () => {
    renderAt('/admin/forgot-password');
    await userEvent.type(screen.getByTestId('forgot-email'), 'buyer@example.com');
    await userEvent.click(screen.getByTestId('forgot-submit'));
    await screen.findByTestId('forgot-sent');
    expect(sb.resetPasswordForEmail).toHaveBeenCalledWith('buyer@example.com', { redirectTo: `${window.location.origin}/admin/set-password` });
  });

  it('answers the same for any address (no account enumeration) and does not claim the account exists', async () => {
    renderAt('/admin/forgot-password');
    await userEvent.type(screen.getByTestId('forgot-email'), 'nobody@example.com');
    await userEvent.click(screen.getByTestId('forgot-submit'));
    expect(await screen.findByTestId('forgot-sent')).toHaveTextContent('Если аккаунт с адресом nobody@example.com существует');
  });

  it('validates the e-mail first and sends nothing for an invalid one', async () => {
    renderAt('/admin/forgot-password');
    await userEvent.type(screen.getByTestId('forgot-email'), 'nope');
    await userEvent.click(screen.getByTestId('forgot-submit'));
    expect(await screen.findByText('Введите корректный адрес электронной почты')).toBeInTheDocument();
    expect(sb.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('waits before the next request (Auth allows one mail per minute) and then offers to send again', async () => {
    renderAt('/admin/forgot-password');
    await userEvent.type(screen.getByTestId('forgot-email'), 'buyer@example.com');
    await userEvent.click(screen.getByTestId('forgot-submit'));
    const button = await screen.findByTestId('forgot-submit');
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent(/Отправить ещё раз через \d+ с/);
  });

  it('a rate-limit refusal is explained with the real consequence and starts the wait', async () => {
    sb.resetPasswordForEmail.mockResolvedValue({ data: null, error: { status: 429, code: 'over_email_send_rate_limit', message: 'rate limit' } });
    renderAt('/admin/forgot-password');
    await userEvent.type(screen.getByTestId('forgot-email'), 'buyer@example.com');
    await userEvent.click(screen.getByTestId('forgot-submit'));
    expect(await screen.findByTestId('forgot-error')).toHaveTextContent('исчерпан лимит отправки писем');
    expect(screen.queryByTestId('forgot-sent')).not.toBeInTheDocument();
    expect(screen.getByTestId('forgot-submit')).toBeDisabled();
  });

  it('maps the Supabase refusals to readable texts', () => {
    expect(recoveryErrorText({ status: 429 })).toContain('лимит');
    expect(recoveryErrorText({ code: 'email_address_not_authorized' })).toContain('почтовый сервис платформы ограничен');
    expect(recoveryErrorText({ status: 500 })).toBe('Не удалось отправить письмо. Повторите попытку позже.');
  });
});

describe('Восстановление пароля: новая ссылка и установка пароля', () => {
  it('a link that is expired or already used says so and offers to request a new mail', async () => {
    window.history.replaceState(null, '', '/admin/set-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    renderAt('/admin/set-password');
    const card = await screen.findByTestId('set-password-invalid');
    expect(card).toHaveTextContent('Срок действия ссылки истёк');
    await userEvent.click(screen.getByTestId('set-password-request-new'));
    expect(await screen.findByTestId('forgot-password')).toBeInTheDocument();
  });

  it('a recovery link (session + type=recovery) shows «Новый пароль», checks both fields and saves through Supabase Auth', async () => {
    auth.session = { user: { email: 'buyer@example.com' } };
    // As in the browser: supabase-js has already signed in from the link and removed the fragment; the start-up flag remains.
    flags.recovery = true;
    window.history.replaceState(null, '', '/admin/set-password');
    renderAt('/admin/set-password');
    expect(await screen.findByTestId('set-password')).toHaveTextContent('Придумайте новый пароль');

    await userEvent.type(screen.getByLabelText('Новый пароль'), 'short');
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'short');
    await userEvent.click(screen.getByTestId('set-password-submit'));
    expect(await screen.findByText(/не короче 10 символов/)).toBeInTheDocument();
    expect(sb.updateUser).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Новый пароль'));
    await userEvent.clear(screen.getByLabelText('Повторите пароль'));
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'brand-new-password');
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'brand-new-passworD');
    await userEvent.click(screen.getByTestId('set-password-submit'));
    expect(await screen.findByText('Пароли не совпадают.')).toBeInTheDocument();
    expect(sb.updateUser).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Повторите пароль'));
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'brand-new-password');
    await userEvent.click(screen.getByTestId('set-password-submit'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/shops'));
    expect(sb.updateUser).toHaveBeenCalledWith({ password: 'brand-new-password' });
    // Other devices are signed out after a recovery.
    expect(sb.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('the invitation flavour of the page stays as it was (no recovery wording, other sessions untouched)', async () => {
    auth.session = { user: { email: 'invited@example.com' } };
    window.history.replaceState(null, '', '/admin/set-password#access_token=x&type=invite');
    renderAt('/admin/set-password');
    expect(await screen.findByText('Установите пароль')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'brand-new-password');
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'brand-new-password');
    await userEvent.click(screen.getByTestId('set-password-submit'));
    await waitFor(() => expect(sb.updateUser).toHaveBeenCalled());
    expect(sb.signOut).not.toHaveBeenCalled();
  });

  it('Auth refusing the same password or a weak one is explained', async () => {
    auth.session = { user: { email: 'buyer@example.com' } };
    window.history.replaceState(null, '', '/admin/set-password#type=recovery');
    sb.updateUser.mockResolvedValueOnce({ data: null, error: { code: 'same_password', message: 'New password should be different' } });
    renderAt('/admin/set-password');
    await userEvent.type(await screen.findByLabelText('Новый пароль'), 'brand-new-password');
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'brand-new-password');
    await userEvent.click(screen.getByTestId('set-password-submit'));
    expect(await screen.findByText('Новый пароль должен отличаться от прежнего.')).toBeInTheDocument();
    expect(sb.signOut).not.toHaveBeenCalled();
  });
});
