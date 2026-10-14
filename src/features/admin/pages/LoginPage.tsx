import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn, useSession } from '../auth';

const schema = z.object({
  email: z.email('Введите email'),
  password: z.string().min(1, 'Введите пароль'),
});

export function LoginPage() {
  const { session, loading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  if (loading) return <PageSpinner />;
  if (session) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/admin/shops'} replace />;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Вход для владельцев</CardTitle>
          <CardDescription>Учётные записи выдаёт администратор платформы. Регистрации нет.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="space-y-4"
            onSubmit={form.handleSubmit(async (v) => {
              setError(null);
              try {
                await signIn(v.email, v.password);
                navigate('/admin/shops', { replace: true });
              } catch {
                setError('Неверный email или пароль.');
              }
            })}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" aria-invalid={!!errors.email} {...form.register('email')} />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Пароль</Label>
              <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register('password')} />
              {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Входим…' : 'Войти'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
