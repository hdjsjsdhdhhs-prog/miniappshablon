import { ShieldCheckIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryKeys } from '@/domain/query-keys';
import { signOut, useSession } from '../auth';
import { enrollTotp, listTotpFactors, MFA_REQUIRED_TEXT, useAssurance, verifyTotp } from '../mfa';
import { useIsPlatformAdmin } from '../use-platform-admin';

const RECOVERY_TEXT =
  'Нет доступа к приложению-аутентификатору? Обратитесь к оператору платформы: после проверки личности он сбросит ваш фактор, и вы настроите новый. Обходного входа без кода нет.';

function CodeForm({ factorId, onVerified, submitLabel }: { factorId: string; onVerified: () => void; submitLabel: string }) {
  const [code, setCode] = useState('');
  const verify = useMutation({ mutationFn: () => verifyTotp(factorId, code), onSuccess: onVerified });
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{6}$/.test(code.trim())) verify.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">Код из приложения</Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          data-testid="mfa-code"
        />
      </div>
      {verify.isError && (
        <Alert variant="destructive">
          <AlertDescription data-testid="mfa-error">Код не подошёл или устарел. Введите текущий код из приложения.</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={code.length !== 6 || verify.isPending} data-testid="mfa-submit">
        {verify.isPending ? 'Проверяем…' : submitLabel}
      </Button>
    </form>
  );
}

/** Enrollment: QR + secret, then the first code. Until that code is verified the session stays aal1 (no access). */
function Enroll({ onVerified, label }: { onVerified: () => void; label: string }) {
  const enroll = useMutation({ mutationFn: enrollTotp });
  if (!enroll.data) {
    return (
      <div className="space-y-3">
        {enroll.isError && (
          <Alert variant="destructive">
            <AlertDescription>Не удалось начать настройку. Повторите попытку.</AlertDescription>
          </Alert>
        )}
        <Button className="w-full" onClick={() => enroll.mutate()} disabled={enroll.isPending} data-testid="mfa-enroll">
          {enroll.isPending ? 'Готовим…' : label}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="mfa-enrollment">
      <p className="text-sm text-muted-foreground">
        Отсканируйте QR-код приложением-аутентификатором (Google Authenticator, 1Password, Aegis и т. п.) или введите ключ вручную.
      </p>
      <img src={enroll.data.qrCode} alt="QR-код для приложения-аутентификатора" className="mx-auto size-44 rounded-lg bg-white p-2" />
      <p className="text-center font-mono text-xs break-all select-all" data-testid="mfa-secret">
        {enroll.data.secret}
      </p>
      <CodeForm factorId={enroll.data.factorId} onVerified={onVerified} submitLabel="Подтвердить и включить" />
    </div>
  );
}

/**
 * /admin/mfa — mandatory for platform admins (RequireAuth sends them here while their session is aal1):
 * first sign-in → enroll + verify; later sign-ins → enter the current code. At aal2: factors and a backup factor.
 */
export function MfaPage() {
  const { session } = useSession();
  const isAdmin = useIsPlatformAdmin();
  const aal = useAssurance();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [addingBackup, setAddingBackup] = useState(false);
  const factors = useQuery({ queryKey: queryKeys.adminMfaFactors(session?.user.id ?? ''), queryFn: listTotpFactors, enabled: !!session });

  if (isAdmin.isPending || aal.isPending || factors.isPending) return <PageSpinner />;
  if (isAdmin.data === false) return <Navigate to="/admin/shops" replace />;
  if (aal.isError || factors.isError) return <ErrorState onRetry={() => void factors.refetch()} />;

  const from = (location.state as { from?: string } | null)?.from;
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['admin'] });
    navigate(from && from !== '/admin/mfa' ? from : '/admin/platform', { replace: true });
  };
  const verified = factors.data.filter((f) => f.status === 'verified');
  const isAal2 = aal.data.currentLevel === 'aal2';

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="mfa-page">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheckIcon aria-hidden /> Двухфакторная защита
          </CardTitle>
          <CardDescription>{MFA_REQUIRED_TEXT}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isAal2 ? (
            <>
              <p className="text-sm" data-testid="mfa-status">
                Включена. Подключено аутентификаторов: {verified.length}.
              </p>
              {addingBackup ? (
                <Enroll
                  label="Добавить резервный аутентификатор"
                  onVerified={() => {
                    setAddingBackup(false);
                    void factors.refetch();
                  }}
                />
              ) : (
                <Button variant="outline" className="w-full" onClick={() => setAddingBackup(true)} data-testid="mfa-add-backup">
                  Добавить резервный аутентификатор
                </Button>
              )}
              <Button className="w-full" onClick={() => void done()} data-testid="mfa-continue">
                Перейти к магазинам платформы
              </Button>
            </>
          ) : verified.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">Введите шестизначный код из приложения-аутентификатора.</p>
              <CodeForm factorId={verified[0]!.id} onVerified={() => void done()} submitLabel="Войти" />
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Подключите приложение-аутентификатор. До подтверждения кода раздел платформы и данные магазинов недоступны.
              </p>
              <Enroll label="Настроить аутентификатор" onVerified={() => void done()} />
            </>
          )}
          <p className="text-xs text-muted-foreground" data-testid="mfa-recovery">
            {RECOVERY_TEXT}
          </p>
          <Button
            variant="ghost"
            className="w-full"
            onClick={async () => {
              await signOut();
              navigate('/admin', { replace: true });
            }}
          >
            Выйти
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
