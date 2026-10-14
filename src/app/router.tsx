import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router';
import { PageSpinner } from '@/components/state-views';
import { CartPage } from '@/features/storefront/pages/CartPage';
import { CatalogPage } from '@/features/storefront/pages/CatalogPage';
import { HomePage } from '@/features/storefront/pages/HomePage';
import { ProductPage } from '@/features/storefront/pages/ProductPage';
import { ProfilePage } from '@/features/storefront/pages/ProfilePage';
import { StorefrontLayout } from '@/features/storefront/StorefrontLayout';
import { LaunchRedirect, NotFoundPage } from './LaunchRedirect';

// The admin is a separate chunk: Mini App buyers never download it.
const AdminRoutes = lazy(() => import('@/features/admin/AdminRoutes'));

export const router = createBrowserRouter([
  { path: '/', element: <LaunchRedirect /> },
  {
    path: '/s/:slug',
    element: <StorefrontLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'catalog', element: <CatalogPage /> },
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
