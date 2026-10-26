import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/domain/query-keys';
import { useSession } from './auth';
import { fetchIsPlatformAdmin } from './functions-api';

/** Cosmetic only: decides whether the platform section is shown. The server re-checks every platform action. */
export function useIsPlatformAdmin() {
  const { session } = useSession();
  const userId = session?.user.id ?? '';
  return useQuery({ queryKey: queryKeys.adminIsPlatformAdmin(userId), queryFn: fetchIsPlatformAdmin, enabled: !!userId, staleTime: 60_000 });
}
