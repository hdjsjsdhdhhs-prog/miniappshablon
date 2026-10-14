import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { PageSpinner } from '@/components/state-views';
import { useSession } from './auth';
import { AdminShopLayout } from './AdminShopLayout';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductEditPage } from './pages/ProductEditPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ShopsPage } from './pages/ShopsPage';

function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <PageSpinner />;
  if (!session) return <Navigate to="/admin" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export default function AdminRoutes() {
  return (
    <div className="admin-theme min-h-dvh bg-background text-foreground">
      <Routes>
        <Route index element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="shops" element={<ShopsPage />} />
          <Route path="shops/:slug" element={<AdminShopLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="products/:productId" element={<ProductEditPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}
