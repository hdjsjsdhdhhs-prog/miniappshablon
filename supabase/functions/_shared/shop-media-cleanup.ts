// Removal of one shop's Storage objects for a DEMO deletion (platform-admin → demo-delete / demo-delete-resume).
// Runs with the service role inside the Edge Function, AFTER the SQL step that deleted the shop's data and blocked it.
//
// Safety rules:
//   * object names come only from the SQL (platform_demo_delete_objects: bucket shop-media, exact prefix "<shop_id>/");
//     every name is re-checked here against the same prefix — one unexpected name stops the cleanup, nothing is
//     removed outside the shop's own folder;
//   * each batch is retried (backoff) before giving up; a failure is returned as text, never thrown, so the SQL
//     finalize step records it and the deletion stays resumable;
//   * removing an already removed object is harmless (Storage ignores missing names): repeats are idempotent.

export type ListObjects = (limit: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
export type RemoveObjects = (paths: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface CleanupResult {
  removed: number;
  /** null when the listing came back empty (nothing left under the prefix). */
  error: string | null;
}

export const CLEANUP_LIMITS = { listLimit: 1000, batch: 100, attempts: 3, rounds: 50, backoffMs: 250 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True only for a non-empty object name strictly inside "<shopId>/" (no traversal, no empty segments). */
export function isInsideShopPrefix(name: unknown, shopId: string): name is string {
  if (typeof name !== 'string' || !UUID.test(shopId)) return false;
  const prefix = `${shopId}/`;
  if (!name.startsWith(prefix) || name.length === prefix.length) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function removeShopMedia(
  list: ListObjects,
  remove: RemoveObjects,
  shopId: string,
  limits: { listLimit: number; batch: number; attempts: number; rounds: number; backoffMs: number } = CLEANUP_LIMITS,
): Promise<CleanupResult> {
  let removed = 0;
  for (let round = 0; round < limits.rounds; round += 1) {
    const listed = await list(limits.listLimit);
    if (listed.error) return { removed, error: `list_failed: ${listed.error.code ?? listed.error.message}`.slice(0, 300) };
    const names = Array.isArray(listed.data) ? (listed.data as unknown[]) : null;
    if (!names) return { removed, error: 'list_failed: unexpected response' };
    if (names.length === 0) return { removed, error: null };
    if (!names.every((n) => isInsideShopPrefix(n, shopId))) return { removed, error: 'unexpected_object_name' };

    let removedThisRound = 0;
    for (let i = 0; i < names.length; i += limits.batch) {
      const batch = names.slice(i, i + limits.batch) as string[];
      let lastError: string | null = null;
      for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
        const res = await remove(batch);
        if (!res.error) {
          lastError = null;
          removedThisRound += Array.isArray(res.data) ? res.data.length : 0;
          break;
        }
        lastError = res.error.message;
        if (attempt < limits.attempts) await sleep(limits.backoffMs * 2 ** (attempt - 1));
      }
      if (lastError !== null) return { removed: removed + removedThisRound, error: `remove_failed: ${lastError}`.slice(0, 300) };
    }
    removed += removedThisRound;
    // Storage answered "ok" but removed nothing that is still listed: stop instead of looping.
    if (removedThisRound === 0) return { removed, error: 'remove_failed: objects were not removed' };
  }
  return { removed, error: 'remove_failed: too many objects, resume the deletion' };
}
