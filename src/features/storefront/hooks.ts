import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/domain/query-keys';
import {
  fetchCategories,
  fetchFeatured,
  fetchProduct,
  fetchProductsPage,
  fetchShopBySlug,
  NotFoundError,
} from './api';

const retry = (count: number, err: unknown) => !(err instanceof NotFoundError) && count < 2;

export function useShopQuery(slug: string) {
  return useQuery({ queryKey: queryKeys.shop(slug), queryFn: () => fetchShopBySlug(slug), retry, staleTime: 60_000 });
}

export function useCategories(shopId: string) {
  return useQuery({ queryKey: queryKeys.categories(shopId), queryFn: () => fetchCategories(shopId), staleTime: 60_000 });
}

export function useFeatured(shopId: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.featured(shopId), queryFn: () => fetchFeatured(shopId), enabled, staleTime: 30_000 });
}

export function useProducts(shopId: string, params: { categoryId: string | null; search: string }) {
  return useInfiniteQuery({
    queryKey: queryKeys.products(shopId, params),
    queryFn: ({ pageParam }) => fetchProductsPage(shopId, params, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextPage,
    staleTime: 15_000,
  });
}

export function useProduct(shopId: string, productId: string) {
  return useQuery({
    queryKey: queryKeys.product(shopId, productId),
    queryFn: () => fetchProduct(shopId, productId),
    retry,
    // Stock and price must be fresh on the product page.
    staleTime: 0,
  });
}
