import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useSession } from '../auth';

/** Matches [auth] minimum_password_length (supabase/config.toml); the server enforces it as well. */
export const MIN_PASSWORD_LENGTH = 10;

/** Error from the invitation link (e.g. "#error=access_denied&error_code=otp_expired"), read once on load. */
function linkError(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('error_code') ?? params.get('error');
}

/**
 * Landing page of the owner invitation (/admin/set-password). Supabase Auth signs the invited user in from the
 * link; here they choose their own password and continue to their shops. The page grants nothing by itself.
 */
export function SetPasswordPage() {
  const { session, loading } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [initialError] = useState(linkError);

  if (loading) return <PageSpinner />;

  if (!session) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm" data-testid="set-password-invalid">
          <CardHeader>
            <CardTitle>Ссылка недействительна</CardTitle>
            <CardDescription>
              {initialError === 'otp_expired'
                ? 'Срок действия приглашения истёк.'
                : 'Приглашение уже использовано или ссылка повреждена.'}{' '}
              Попросите администратора платформы отправить новое приглашение.
            </CardDescription>
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

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="set-password">
        <CardHeader>
          <CardTitle>Установите пароль</CardTitle>
          <CardDescription>
            Учётная запись {session.user.email}. Пароль понадобится для входа в админку магазина.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              if (password.length < MIN_PASSWORD_LENGTH) return setError(`Пароль — не короче ${MIN_PASSWORD_LENGTH} символов.`);
              if (password !== repeat) return setError('Пароли не совпадают.');
              setSaving(true);
              const { error: e2 } = await supabase.auth.updateUser({ password });
              setSaving(false);
              if (e2) return setError(/weak|short|length/i.test(e2.message) ? 'Пароль слишком простой. Выберите другой.' : 'Не удалось сохранить пароль. Повторите попытку.');
              // Drop the tokens from the address bar and history.
              window.history.replaceState(null, '', '/admin/set-password');
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
