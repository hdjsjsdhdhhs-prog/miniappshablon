import { ArrowSquareOutIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/domain/query-keys';
import { ShopLogo } from '@/features/storefront/components/ShopLogo';
import { useSession } from '../auth';
import { AdminTopBar } from '../components/AdminTopBar';
import { ShopModeBadge } from '../components/ShopQuickLinks';
import { ShopSearchInput } from '../components/ShopSearchInput';
import { CopyLinkButton } from '../components/CopyLinkButton';
import { CreateDemoDialog } from '../components/CreateDemoDialog';
import { DeleteDemoDialog } from '../components/DeleteDemoDialog';
import { DeleteShopDialog } from '../components/DeleteShopDialog';
import { MFA_REQUIRED_TEXT } from '../mfa';
import { HandoverDialog } from '../components/HandoverDialog';
import { OwnerLinkDialog } from '../components/OwnerLinkDialog';
import { TransferShopDialog } from '../components/TransferShopDialog';
import { OWNER_INVITE_STATUS } from '../owner-invite-status';
import { AdminApiError, platformApi, publicShopUrl, type PlatformShop } from '../functions-api';
import { matchesShopSearch, storefrontPath } from '../shop-search';
import { useIsPlatformAdmin } from '../use-platform-admin';

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : null);

const dateTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/** One line about the shop's owner registration link: status, term, and — once used — who registered and when. */
function OwnerInviteLine({ invite }: { invite: NonNullable<PlatformShop['owner_invite']> }) {
  const status = OWNER_INVITE_STATUS[invite.status];
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="platform-shop-invite" data-status={invite.status}>
      Ссылка владельца: <Badge variant={status.variant}>{status.label}</Badge>
      {invite.status === 'active' && <span>до {dateTime(invite.expires_at)}</span>}
      {invite.status === 'used' && invite.used_at && (
        <span data-testid="platform-shop-invite-used">
          {invite.used_email} · {dateTime(invite.used_at)}
        </span>
      )}
      {invite.stale && <span className="text-destructive">владелец изменился — создайте новую</span>}
    </p>
  );
}

function NotificationBadge({ n }: { n: PlatformShop['notifications'] }) {
  if (!n) return <span className="text-muted-foreground">не настроены</span>;
  if (!n.enabled) return <span className="text-muted-foreground">выключены</span>;
  return n.status === 'ok' ? <span className="text-emerald-400">подключены</span> : <span className="text-destructive">ошибка</span>;
}

/** "Все магазины платформы": every shop regardless of who owns it. Platform admins only (checked on the server). */
export function PlatformShopsPage() {
  const { session } = useSession();
  const isAdmin = useIsPlatformAdmin();
  const shops = useQuery({
    queryKey: queryKeys.platformShops(session?.user.id ?? ''),
    queryFn: platformApi.list,
    enabled: isAdmin.data === true,
    retry: (count, err) => !(err instanceof AdminApiError && err.status === 403) && count < 2,
  });
  const [query, setQuery] = useState('');
  const [transferring, setTransferring] = useState<PlatformShop | null>(null);
  const [handingOver, setHandingOver] = useState<PlatformShop | null>(null);
  // Owner registration link: the shop whose dialog is open (by id, so it follows list refreshes) and the tokens issued in
  // this browser session. A token lives only here, in memory; the server keeps just its hash and cannot show it again.
  const [linkShopId, setLinkShopId] = useState<string | null>(null);
  const [issued, setIssued] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<PlatformShop | null>(null);
  const [creating, setCreating] = useState(false);
  const visible = useMemo(
    () => (shops.data ?? []).filter((s) => matchesShopSearch(query, s.name, s.slug, ...s.members.map((m) => m.email))),
    [shops.data, query],
  );
  const linkShop = linkShopId ? (shops.data ?? []).find((s) => s.id === linkShopId) ?? null : null;
  const mfaRequired = shops.error instanceof AdminApiError && shops.error.code === 'mfa_required';
  const denied = isAdmin.data === false || (shops.error instanceof AdminApiError && shops.error.status === 403 && !mfaRequired);

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4">
      <AdminTopBar />
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Все магазины платформы</h1>
          {shops.data && (
            <p className="text-sm text-muted-foreground" data-testid="platform-summary">
              Всего: {shops.data.length} · live: {shops.data.filter((s) => s.mode === 'live').length} · preview:{' '}
              {shops.data.filter((s) => s.mode === 'preview').length} · DEMO: {shops.data.filter((s) => s.is_demo).length}
            </p>
          )}
        </div>
        <ShopSearchInput value={query} onChange={setQuery} placeholder="Название, slug или email владельца" />
        {shops.data && (
          <Button onClick={() => setCreating(true)} data-testid="platform-create-demo">
            <PlusIcon aria-hidden /> Создать DEMO-магазин
          </Button>
        )}
      </div>

      {denied ? (
        <EmptyState title="Нет доступа" description="Этот раздел доступен только администратору платформы." />
      ) : mfaRequired ? (
        <EmptyState
          title="Нужна двухфакторная аутентификация"
          description={MFA_REQUIRED_TEXT}
          action={
            <Button asChild>
              <Link to="/admin/mfa">Подтвердить вход кодом</Link>
            </Button>
          }
        />
      ) : isAdmin.isPending || shops.isPending ? (
        <PageSpinner />
      ) : shops.isError ? (
        <ErrorState onRetry={() => void shops.refetch()} />
      ) : visible.length === 0 ? (
        <EmptyState title="Ничего не найдено" description={query.trim() ? `Нет магазинов по запросу «${query.trim()}».` : 'Магазинов пока нет.'} />
      ) : (
        <ul className="divide-y rounded-lg border bg-card" data-testid="platform-shops">
          {visible.map((s) => {
            const owners = s.members.filter((m) => m.role === 'owner');
            return (
              <li key={s.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center" data-testid="platform-shop">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <ShopLogo name={s.name} path={s.logo_path} className="size-10 shrink-0 rounded-lg text-sm" />
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{s.name}</span>
                      <ShopModeBadge mode={s.mode} />
                      {s.is_demo && <Badge variant="outline">DEMO</Badge>}
                      {s.status === 'deleting' ? (
                        <Badge variant="destructive" data-testid="platform-shop-deleting" title={s.deletion?.last_error ?? undefined}>
                          Удаляется: файлы не очищены
                        </Badge>
                      ) : (
                        s.status !== 'active' && <Badge variant="destructive">{s.status}</Badge>
                      )}
                      {s.pending_handover && !s.pending_handover.expired && (
                        <Badge variant="secondary" data-testid="platform-handover-pending" title={s.pending_handover.last_error ?? undefined}>
                          Ждёт подтверждения: {s.pending_handover.email}
                        </Badge>
                      )}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground" data-testid="platform-shop-url">
                      {publicShopUrl(s.slug)}
                    </p>
                    <p className="text-sm" data-testid="platform-shop-owner">
                      Владелец:{' '}
                      {owners.length ? owners.map((o) => o.email ?? o.user_id).join(', ') : <span className="text-muted-foreground">не назначен</span>}
                    </p>
                    {s.owner_invite && <OwnerInviteLine invite={s.owner_invite} />}
                    <p className="text-xs text-muted-foreground">
                      Создан {date(s.created_at)}
                      {s.last_transfer_at && ` · передан ${date(s.last_transfer_at)}`} · уведомления: <NotificationBadge n={s.notifications} />
                    </p>
                    {!s.delivery_enabled && !s.pickup_enabled && (
                      <p className="text-xs text-destructive">Способы получения выключены — заказы не принимаются.</p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <CopyLinkButton url={publicShopUrl(s.slug)} label="Ссылка" testId="platform-copy-link" />
                  <Button asChild size="sm" variant="ghost">
                    <a href={storefrontPath(s.slug)} target="_blank" rel="noreferrer">
                      Витрина <ArrowSquareOutIcon aria-hidden />
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/admin/shops/${s.slug}`}>Админка</Link>
                  </Button>
                  {s.status !== 'deleting' && (
                    // Works for a DEMO shop and for a shop that already has an owner (it is then handed over again).
                    <Button size="sm" variant="outline" onClick={() => setLinkShopId(s.id)} data-testid="platform-owner-link">
                      Ссылка владельцу
                    </Button>
                  )}
                  {s.status === 'deleting' ? (
                    <Button size="sm" variant="destructive" onClick={() => setDeleting(s)} data-testid="platform-demo-delete-resume">
                      Продолжить удаление
                    </Button>
                  ) : s.is_demo ? (
                    <>
                      <Button size="sm" onClick={() => setHandingOver(s)} data-testid="platform-handover">
                        Передать клиенту
                      </Button>
                      {/* Only DEMO shops (is_demo, whatever the mode); the server refuses any other shop. */}
                      <Button size="sm" variant="destructive" onClick={() => setDeleting(s)} data-testid="platform-demo-delete">
                        <TrashIcon aria-hidden /> Удалить DEMO
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => setTransferring(s)} data-testid="platform-transfer">
                        Передать
                      </Button>
                      {/* Any LIVE shop: with or without an owner. The server asks for a fresh TOTP code and the slug. */}
                      <Button size="sm" variant="destructive" onClick={() => setDeleting(s)} data-testid="platform-shop-delete">
                        <TrashIcon aria-hidden /> Удалить магазин
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {transferring && <TransferShopDialog shop={transferring} open onOpenChange={(o) => !o && setTransferring(null)} />}
      {handingOver && <HandoverDialog shop={handingOver} open onOpenChange={(o) => !o && setHandingOver(null)} />}
      {linkShop && (
        <OwnerLinkDialog
          shop={linkShop}
          open
          onOpenChange={(o) => !o && setLinkShopId(null)}
          issuedToken={issued[linkShop.id] ?? null}
          onIssued={(token) =>
            setIssued((prev) => {
              const next = { ...prev };
              if (token) next[linkShop.id] = token;
              else delete next[linkShop.id];
              return next;
            })
          }
        />
      )}
      {/* DEMO: slug only (unchanged). Any other shop: slug + a fresh TOTP code, both checked by the server. */}
      {deleting &&
        (deleting.is_demo ? (
          <DeleteDemoDialog shop={deleting} open onOpenChange={(o) => !o && setDeleting(null)} />
        ) : (
          <DeleteShopDialog shop={deleting} open onOpenChange={(o) => !o && setDeleting(null)} />
        ))}
      {creating && shops.data && <CreateDemoDialog shops={shops.data} open onOpenChange={setCreating} />}
    </main>
  );
}
