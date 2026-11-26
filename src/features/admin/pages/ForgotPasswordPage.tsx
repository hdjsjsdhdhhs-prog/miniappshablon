import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { RECOVERY_REDIRECT_PATH, recoveryErrorText, RESEND_AFTER_SEC } from '../password-recovery';

const schema = z.object({
  email: z.string().trim().min(1, 'Введите электронную почту').pipe(z.email('Введите корректный адрес электронной почты')),
});

/**
 * «Забыли пароль?»: the standard Supabase Auth recovery (resetPasswordForEmail). The answer is the same whether or not an
 * account exists, so the page cannot be used to find out who is registered. Only this flow sends e-mail: registration by
 * a link sends none.
 */
export function ForgotPasswordPage() {
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '' } });
  const { errors, isSubmitting } = form.formState;
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="forgot-password">
        <CardHeader>
          <CardTitle>Восстановление пароля</CardTitle>
          <CardDescription>Введите почту, с которой вы регистрировались. Мы отправим на неё ссылку для создания нового пароля.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            noValidate
            className="space-y-4"
            onSubmit={form.handleSubmit(async (v) => {
              setError(null);
              const { error: e } = await supabase.auth.resetPasswordForEmail(v.email, {
                redirectTo: `${window.location.origin}${RECOVERY_REDIRECT_PATH}`,
              });
              if (e) {
                setError(recoveryErrorText(e));
                // A refusal by the rate limit also starts the wait: pressing again only repeats it.
                if (e.status === 429) setLeft(RESEND_AFTER_SEC);
                return;
              }
              setSentTo(v.email);
              setLeft(RESEND_AFTER_SEC);
            })}
          >
            <div className="space-y-1.5">
              <Label htmlFor="recover-email">Электронная почта</Label>
              <Input
                id="recover-email"
                type="email"
                inputMode="email"
                autoComplete="username"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'recover-email-error' : undefined}
                data-testid="forgot-email"
                {...form.register('email')}
              />
              {errors.email && (
                <p id="recover-email-error" className="text-sm text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>
            {sentTo && (
              <Alert data-testid="forgot-sent">
                <AlertDescription>
                  Если аккаунт с адресом <b>{sentTo}</b> существует, мы отправили на него письмо со ссылкой. Ссылка действует недолго и работает один раз.
                  Проверьте и папку «Спам».
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" data-testid="forgot-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={isSubmitting || left > 0} data-testid="forgot-submit">
              {isSubmitting ? 'Отправляем…' : left > 0 ? `Отправить ещё раз через ${left} с` : sentTo ? 'Отправить письмо ещё раз' : 'Восстановить пароль'}
            </Button>
          </form>
          <Button asChild variant="ghost" className="w-full">
            <Link to="/admin">Вернуться ко входу</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
