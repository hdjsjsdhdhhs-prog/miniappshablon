import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { passwordIssue } from '@/domain/password';
import { openedByRecoveryLink, supabase } from '@/lib/supabase';
import { useSession } from '../auth';

/** Error from the e-mail link (e.g. "#error=access_denied&error_code=otp_expired"), read once on load. */
function linkError(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('error_code') ?? params.get('error');
}

/**
 * The link of a password-recovery e-mail carries "type=recovery" in the fragment (implicit flow). supabase-js removes
 * the fragment while it signs the user in, so the flag was taken at start-up (lib/supabase.ts); the fragment itself is
 * still checked for a page that is rendered before that.
 */
function isRecoveryLink(): boolean {
  return openedByRecoveryLink || new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type') === 'recovery';
}

/**
 * Landing page of the e-mail links of Supabase Auth: the owner invitation AND the password recovery
 * (/admin/set-password — one address, already in the Auth redirect allow-list). Supabase Auth signs the user in from
 * the one-time link; here they choose their own password and continue to their shops. The page grants nothing by
 * itself: it only changes the password of the session the link created. A platform admin who arrives here is still
 * aal1 and goes on to the MFA step — recovery never replaces the second factor.
 */
export function SetPasswordPage() {
  const { session, loading } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [initialError] = useState(linkError);
  const [recovery] = useState(isRecoveryLink);

  if (loading) return <PageSpinner />;

  if (!session) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm" data-testid="set-password-invalid">
          <CardHeader>
            <CardTitle>Ссылка недействительна</CardTitle>
            <CardDescription>
              {initialError === 'otp_expired'
                ? 'Срок действия ссылки истёк.'
                : 'Ссылка уже использована или повреждена.'}{' '}
              Ссылка из письма работает один раз. Запросите новое письмо для восстановления пароля; если это было приглашение — попросите
              администратора платформы отправить новое.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild className="w-full" data-testid="set-password-request-new">
              <Link to="/admin/forgot-password">Запросить новое письмо</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to="/admin">Войти по паролю</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="set-password">
        <CardHeader>
          <CardTitle>{recovery ? 'Новый пароль' : 'Установите пароль'}</CardTitle>
          <CardDescription>
            Учётная запись {session.user.email}.{' '}
            {recovery ? 'Придумайте новый пароль — им вы будете входить в админку.' : 'Пароль понадобится для входа в админку магазина.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const issue = passwordIssue(password);
              if (issue) return setError(issue);
              if (password !== repeat) return setError('Пароли не совпадают.');
              setSaving(true);
              const { error: e2 } = await supabase.auth.updateUser({ password });
              setSaving(false);
              if (e2) {
                if (e2.code === 'same_password') return setError('Новый пароль должен отличаться от прежнего.');
                return setError(/weak|short|length/i.test(e2.message) ? 'Пароль слишком простой. Выберите другой.' : 'Не удалось сохранить пароль. Повторите попытку.');
              }
              // Drop the tokens from the address bar and history.
              window.history.replaceState(null, '', '/admin/set-password');
              // A forgotten password may have been seen by someone else: end every OTHER session of this account.
              if (recovery) await supabase.auth.signOut({ scope: 'others' }).catch(() => undefined);
              toast.success('Пароль сохранён');
              navigate('/admin/shops', { replace: true });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Новый пароль</Label>
              <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repeat-password">Повторите пароль</Label>
              <Input id="repeat-password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={saving} data-testid="set-password-submit">
              {saving ? 'Сохраняем…' : 'Сохранить и войти'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
