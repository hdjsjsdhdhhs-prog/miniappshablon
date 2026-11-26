import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type * as Api from './api';
import { AdminShopLayout } from './AdminShopLayout';

vi.mock('@/features/admin/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  fetchAdminShop: vi.fn(async () => ({ id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor', mode: 'live', is_demo: false })),
}));

describe('AdminShopLayout', () => {
  it('puts «Бонусы и промокоды» between «Уведомления» and «Подключение бота» and keeps the order of the existing tabs', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/admin/shops/noir-vapor']}>
          <Routes>
            <Route path="/admin/shops/:slug" element={<AdminShopLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Разделы магазина' });
    const tabs = [...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(tabs).toEqual([
      ['Обзор', '/admin/shops/noir-vapor'],
      ['Товары', '/admin/shops/noir-vapor/products'],
      ['Категории', '/admin/shops/noir-vapor/categories'],
      ['Заказы', '/admin/shops/noir-vapor/orders'],
      ['Оформление', '/admin/shops/noir-vapor/settings'],
      ['Уведомления', '/admin/shops/noir-vapor/notifications'],
      // «Бонусы и промокоды» sits between «Уведомления» and «Подключение бота», directly to the left of the latter.
      ['Бонусы и промокоды', '/admin/shops/noir-vapor/loyalty'],
      ['Подключение бота', '/admin/shops/noir-vapor/bot'],
      // «Рассылка» sits right after (to the right of) «Подключение бота».
      ['Рассылка', '/admin/shops/noir-vapor/broadcast'],
    ]);
  });
});
