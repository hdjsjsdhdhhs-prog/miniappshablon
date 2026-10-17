import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, useLocation, useParams } from 'react-router';
import { PageSpinner } from '@/components/state-views';
import { CartPage } from '@/features/storefront/pages/CartPage';
import { HomePage } from '@/features/storefront/pages/HomePage';
import { ProductPage } from '@/features/storefront/pages/ProductPage';
import { ProfilePage } from '@/features/storefront/pages/ProfilePage';
import { StorefrontLayout } from '@/features/storefront/StorefrontLayout';
import { LaunchRedirect, NotFoundPage } from './LaunchRedirect';

// The admin is a separate chunk: Mini App buyers never download it.
const AdminRoutes = lazy(() => import('@/features/admin/AdminRoutes'));

/** The catalog lives on the shop home now; old `/catalog?category=…&q=…` links keep their filters. */
function CatalogRedirect() {
  const { slug = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={{ pathname: `/s/${slug}/`, search }} replace />;
}

export const router = createBrowserRouter([
  { path: '/', element: <LaunchRedirect /> },
  {
    path: '/s/:slug',
    element: <StorefrontLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'catalog', element: <CatalogRedirect /> },
      { path: 'product/:productId', element: <ProductPage /> },
      { path: 'cart', element: <CartPage /> },
      { path: 'profile', element: <ProfilePage /> },
    ],
  },
  {
    path: '/admin/*',
    element: (
      <Suspense fallback={<PageSpinner />}>
        <AdminRoutes />
      </Suspense>
    ),
  },
  { path: '*', element: <NotFoundPage /> },
]);
