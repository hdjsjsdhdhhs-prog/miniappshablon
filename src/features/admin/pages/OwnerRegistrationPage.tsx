import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  readInviteToken,
  registrationSchema,
  signInSchema,
  type InvitePreviewStatus,
  type RegistrationInput,
  type SignInInput,
} from '@/domain/owner-registration';
import { MIN_PASSWORD_LENGTH } from '@/domain/password';
import { supabase } from '@/lib/supabase';
import { ShopLogo } from '@/features/storefront/components/ShopLogo';
import { signIn, signOut, useSession } from '../auth';
import { isUncertainOutcome, OwnerRegistrationError, ownerRegistrationApi, ownerRegistrationErrorText } from '../owner-registration-api';

/** Links that can no longer be used → what the buyer is told. */
const DEAD: Record<string, { title: string; text: string }> = {
  invalid: { title: 'Ссылка недействительна', text: 'Проверьте, что вы открыли ссылку целиком, или попросите новую у администратора платформы.' },
  expired: { title: 'Срок действия ссылки истёк', text: 'Попросите администратора платформы создать новую ссылку.' },
  revoked: { title: 'Ссылка отозвана', text: 'Попросите администратора платформы создать новую ссылку.' },
  used: { title: 'Ссылка уже использована', text: 'По ней уже зарегистрирован владелец. Если это были вы — войдите со своей почтой и паролем.' },
  unavailable: { title: 'Ссылка больше не действует', text: 'Магазин изменился после создания ссылки. Попросите администратора платформы создать новую.' },
  busy: { title: 'Магазин сейчас занят', text: 'По этой ссылке или с этим магазином прямо сейчас выполняется другая операция. Подождите несколько минут и обновите страницу.' },
};

const DEAD_BY_CODE: Record<string, InvitePreviewStatus> = {
  invite_invalid: 'invalid',
  invite_expired: 'expired',
  invite_revoked: 'revoked',
  invite_used: 'used',
  invite_unavailable: 'unavailable',
};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/** Keeps the page and its address out of search engines; the token itself lives in the URL fragment only. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

/**
 * The buyer's page (/admin/register#<token>). Opens only with a link token: without a valid one it explains why and
 * offers nothing. The token is read from the fragment, removed from the address bar at once and kept only in memory.
 * The shop is never chosen here — the server knows it from the link. After a successful registration the browser signs
 * in with the password just chosen (a normal Supabase Auth session; no e-mail is involved) and opens the shop's admin.
 */
export function OwnerRegistrationPage() {
  useNoIndex();
  const navigate = useNavigate();
  const { session } = useSession();
  const [token] = useState(() => readInviteToken(window.location.hash));
  useEffect(() => {
    // The secret must not stay in the address bar, the history or a shared screenshot.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const preview = useQuery({
    queryKey: ['owner-invite', 'preview'],
    queryFn: () => ownerRegistrationApi.preview(token!),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const [view, setView] = useState<'register' | 'signin'>('register');
  const [dead, setDead] = useState<InvitePreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  /** A previous attempt ended without an answer: it may have been completed on the server. */
  const [uncertain, setUncertain] = useState(false);
  /** The "apply to the signed-in account" button; the forms are locked by react-hook-form's isSubmitting. */
  const [claiming, setClaiming] = useState(false);

  const registerForm = useForm<RegistrationInput>({ resolver: zodResolver(registrationSchema), defaultValues: { email: '', password: '', repeat: '' } });
  const signInForm = useForm<SignInInput>({ resolver: zodResolver(signInSchema), defaultValues: { email: '', password: '' } });

  const open = (slug: string) => navigate(`/admin/shops/${slug}`, { replace: true });

  /** One place for every failure of a register / claim call. */
  async function handleFailure(e: unknown, credentials?: { email: string; password: string }): Promise<void> {
    const code = e instanceof OwnerRegistrationError ? e.code : '';
    if (code === 'account_exists') {
      signInForm.setValue('email', registerForm.getValues('email'));
      setView('signin');
      setError(ownerRegistrationErrorText(e));
      return;
    }
    const status = DEAD_BY_CODE[code];
    if (status === 'used' && uncertain && credentials) {
      // The earlier attempt probably succeeded and only the answer was lost: the buyer's own password proves it.
      try {
        await signIn(credentials.email, credentials.password);
        navigate('/admin/shops', { replace: true });
        return;
      } catch {
        /* not our account: fall through to the plain "already used" message */
      }
    }
    if (status) {
      setDead(status);
      return;
    }
    if (isUncertainOutcome(e)) setUncertain(true);
    setError(ownerRegistrationErrorText(e));
  }

  /** The account is signed in with the password it was just created with. A failure here must not lose the account. */
  async function finishRegistration(slug: string, credentials: { email: string; password: string }) {
    try {
      await signIn(credentials.email, credentials.password);
    } catch {
      setAccountReady(true);
      return;
    }
    open(slug);
  }

  // react-hook-form keeps `isSubmitting` true until the returned promise settles, which locks the form (and its button)
  // against a double submit; a second request would anyway be refused by the server (one registration per link).
  const onRegister = registerForm.handleSubmit(async (v) => {
    setError(null);
    try {
      const done = await ownerRegistrationApi.register(token!, { email: v.email, password: v.password, passwordConfirm: v.repeat });
      await finishRegistration(done.shop.slug, { email: v.email, password: v.password });
    } catch (e) {
      await handleFailure(e, { email: v.email, password: v.password });
    }
  });

  /** `credentials` omitted: the account that is signed in already. */
  async function claim(credentials?: SignInInput): Promise<void> {
    setError(null);
    setClaiming(true);
    try {
      if (credentials) {
        try {
          await signIn(credentials.email, credentials.password);
        } catch {
          setError('Неверная почта или пароль.');
          return;
        }
      }
      const access = (await supabase.auth.getSession()).data.session?.access_token;
      if (!access) throw new OwnerRegistrationError(401, 'auth_required');
      const done = await ownerRegistrationApi.claim(token!, access);
      open(done.shop.slug);
    } catch (e) {
      await handleFailure(e);
    } finally {
      setClaiming(false);
    }
  }

  if (token === null) return <DeadCard status="invalid" />;
  if (preview.isPending) return <PageSpinner />;
  if (preview.isError) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <ErrorState title="Не удалось проверить ссылку" description="Проверьте подключение и попробуйте ещё раз." onRetry={() => void preview.refetch()} />
      </main>
    );
  }
  const status = dead ?? preview.data.status;
  if (status !== 'active') return <DeadCard status={status} />;

  if (accountReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm" data-testid="owner-reg-created">
          <CardHeader>
            <CardTitle>Аккаунт создан</CardTitle>
            <CardDescription>Вы владелец магазина, но войти автоматически не удалось. Войдите со своей почтой и паролем.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/admin">Войти</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const shop = preview.data.shop;
  const { errors: regErrors, isSubmitting: registering } = registerForm.formState;
  const { errors: inErrors, isSubmitting: signingIn } = signInForm.formState;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4" data-testid="owner-reg-page">
      <Card className="w-full max-w-sm">
        <CardHeader>
          {shop && (
            <div className="mb-2 flex items-center gap-3" data-testid="owner-reg-shop">
              <ShopLogo name={shop.name} path={shop.logo_path} className="size-10 rounded-lg text-sm" />
              <p className="min-w-0 truncate font-medium">{shop.name}</p>
            </div>
          )}
          <CardTitle>{view === 'register' ? 'Регистрация владельца магазина' : 'Войдите в свой аккаунт'}</CardTitle>
          <CardDescription>
            {view === 'register'
              ? `Вы станете владельцем магазина${shop ? ` «${shop.name}»` : ''} и сразу попадёте в его админку. Подтверждать почту не нужно.`
              : 'Ссылка применится к этому аккаунту, и вы станете владельцем магазина.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {session && view === 'register' && (
            <Alert data-testid="owner-reg-session">
              <AlertDescription>
                <p>
                  Вы уже вошли как <b>{session.user.email}</b>.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={claiming} onClick={() => void claim()} data-testid="owner-reg-claim-session">
                    Применить ссылку к этому аккаунту
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void signOut()}>
                    Выйти и зарегистрировать новый
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {view === 'register' ? (
            <form noValidate className="space-y-4" onSubmit={onRegister} data-testid="owner-reg-form">
              <div className="space-y-1.5">
                <Label htmlFor="owner-email">Электронная почта</Label>
                <Input
                  id="owner-email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  aria-invalid={!!regErrors.email}
                  aria-describedby={regErrors.email ? 'owner-email-error' : 'owner-email-hint'}
                  data-testid="owner-reg-email"
                  {...registerForm.register('email')}
                />
                {regErrors.email ? (
                  <FieldError id="owner-email-error" message={regErrors.email.message} />
                ) : (
                  <p id="owner-email-hint" className="text-xs text-muted-foreground">
                    Это ваш логин. Почту мы не проверяем — введите её без ошибок: на неё придёт письмо, если вы забудете пароль.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="owner-password">Пароль</Label>
                <Input
                  id="owner-password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!regErrors.password}
                  aria-describedby={regErrors.password ? 'owner-password-error' : 'owner-password-hint'}
                  data-testid="owner-reg-password"
                  {...registerForm.register('password')}
                />
                {regErrors.password ? (
                  <FieldError id="owner-password-error" message={regErrors.password.message} />
                ) : (
                  <p id="owner-password-hint" className="text-xs text-muted-foreground">
                    Не короче {MIN_PASSWORD_LENGTH} символов.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="owner-repeat">Повторите пароль</Label>
                <Input
                  id="owner-repeat"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!regErrors.repeat}
                  aria-describedby={regErrors.repeat ? 'owner-repeat-error' : undefined}
                  data-testid="owner-reg-repeat"
                  {...registerForm.register('repeat')}
                />
                <FieldError id="owner-repeat-error" message={regErrors.repeat?.message} />
              </div>
              {error && (
                <Alert variant="destructive" data-testid="owner-reg-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={registering} data-testid="owner-reg-submit">
                {registering ? 'Регистрируем…' : 'Зарегистрироваться'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Уже есть аккаунт?{' '}
                <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => { setError(null); setView('signin'); }} data-testid="owner-reg-to-signin">
                  Войти и применить ссылку
                </button>
              </p>
            </form>
          ) : (
            <form noValidate className="space-y-4" onSubmit={signInForm.handleSubmit((v) => claim(v))} data-testid="owner-reg-signin-form">
              <div className="space-y-1.5">
                <Label htmlFor="claim-email">Электронная почта</Label>
                <Input id="claim-email" type="email" inputMode="email" autoComplete="username" aria-invalid={!!inErrors.email} data-testid="owner-claim-email" {...signInForm.register('email')} />
                <FieldError id="claim-email-error" message={inErrors.email?.message} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-password">Пароль</Label>
                <Input id="claim-password" type="password" autoComplete="current-password" aria-invalid={!!inErrors.password} data-testid="owner-claim-password" {...signInForm.register('password')} />
                <FieldError id="claim-password-error" message={inErrors.password?.message} />
                <p className="text-xs text-muted-foreground">
                  Забыли пароль? <Link to="/admin/forgot-password" className="underline underline-offset-2">Восстановить</Link> и вернитесь к ссылке.
                </p>
              </div>
              {error && (
                <Alert variant="destructive" data-testid="owner-reg-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={signingIn || claiming} data-testid="owner-claim-submit">
                {signingIn ? 'Входим…' : 'Войти и стать владельцем'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => { setError(null); setView('register'); }}>
                  Зарегистрировать новый аккаунт
                </button>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function DeadCard({ status }: { status: string }) {
  const info = DEAD[status] ?? DEAD.invalid!;
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="owner-reg-dead" data-status={status}>
        <CardHeader>
          <CardTitle>{info.title}</CardTitle>
          <CardDescription>{info.text}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link to="/admin">Войти по паролю</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
