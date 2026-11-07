import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { PageSpinner } from '@/components/state-views';
import { useSession } from './auth';
import { AdminShopLayout } from './AdminShopLayout';
import { BotConnectionPage } from './pages/BotConnectionPage';
import { useAssurance } from './mfa';
import { MfaPage } from './pages/MfaPage';
import { useIsPlatformAdmin } from './use-platform-admin';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrdersPage } from './pages/OrdersPage';
import { PlatformShopsPage } from './pages/PlatformShopsPage';
import { ProductEditPage } from './pages/ProductEditPage';
import { ProductsPage } from './pages/ProductsPage';
import { SetPasswordPage } from './pages/SetPasswordPage';
import { SettingsPage } from './pages/SettingsPage';
import { ShopsPage } from './pages/ShopsPage';

function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();
  const isAdmin = useIsPlatformAdmin();
  const aal = useAssurance();
  if (loading) return <PageSpinner />;
  if (!session) return <Navigate to="/admin" replace state={{ from: location.pathname }} />;
  // A platform admin works only in an aal2 (MFA) session: until then the only page is /admin/mfa. The database
  // enforces the same on its own (20261102090000); this redirect just shows the way.
  if (isAdmin.isPending || (isAdmin.data && aal.isPending)) return <PageSpinner />;
  if (isAdmin.data && aal.data?.currentLevel !== 'aal2' && location.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

const ADMIN_THEME_CLASSES = ['admin-theme', 'dark'];

export default function AdminRoutes() {
  // Portalled UI (Radix dialogs/selects) and the global Toaster render outside this wrapper: scope the
  // admin tokens on <body> too while the admin is mounted.
  useEffect(() => {
    document.body.classList.add(...ADMIN_THEME_CLASSES);
    return () => document.body.classList.remove(...ADMIN_THEME_CLASSES);
  }, []);

  return (
    <div className="admin-theme dark min-h-dvh bg-background text-foreground">
      <Routes>
        <Route index element={<LoginPage />} />
        <Route path="set-password" element={<SetPasswordPage />} />
        <Route element={<RequireAuth />}>
          <Route path="shops" element={<ShopsPage />} />
          <Route path="shops/:slug" element={<AdminShopLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="products/:productId" element={<ProductEditPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="bot" element={<BotConnectionPage />} />
          </Route>
          <Route path="platform" element={<PlatformShopsPage />} />
          <Route path="mfa" element={<MfaPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}
