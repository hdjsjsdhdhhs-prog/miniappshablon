/**
 * Approved SHA-256 of every reviewed migration in `supabase/migrations` (see migration-integrity.ts).
 *
 * STATIC, REVIEWED DATA. Nothing reads files or computes hashes here, and no tool rewrites this file:
 * a value changes only by a deliberate, reviewed edit.
 *
 * Hash = SHA-256 (lowercase hex) of the file's canonical bytes: valid UTF-8, every CRLF replaced by LF, nothing else
 * changed (BOM, whitespace, comments, trailing newlines are all hashed as-is). That is the content Git stores, so the
 * value is the same for a Windows checkout (core.autocrlf=true → CRLF) and a Linux checkout (LF).
 *
 * Exactly one entry per file of APPLIED_BASELINE_MIGRATION_FILES then MIGRATION_STAGES (migration-plan.ts), in the
 * same order; the names are checked against that manifest at import time, so neither list can drift.
 *
 * Adding a migration (no step is automatic):
 *   1. create the SQL file in supabase/migrations;
 *   2. add its exact name to its stage in MIGRATION_STAGES (migration-plan.ts);
 *   3. compute its canonical hash: `pnpm check:migration-integrity hash supabase/migrations/<file>.sql`;
 *   4. review the SQL, then append `{ file, sha256 }` below by hand;
 *   5. `pnpm check:migration-integrity` and `pnpm test` must pass.
 * Editing an already reviewed migration is a new review: its hash here must be replaced by hand in the same change.
 */
export const MIGRATION_INTEGRITY_MANIFEST = [
  // Baseline: reviewed prerequisite for all release stages.
  { file: '20261014090000_core_schema.sql', sha256: '33bdfc91c2e77e5cf0263c840d03fd870ce65800c2044984ebaa1fe6b625213f' },
  { file: '20261014090100_access_control.sql', sha256: '5b5fee09f3aca0f7996b8099c1e741cfd9550abf671af31ccfea6150e2a767ab' },
  { file: '20261014090200_order_functions.sql', sha256: '44edc600c0fb29042f45003c3e15830200968a854f14d27518658f115cc8e289' },
  { file: '20261014090300_storage.sql', sha256: '021382123393c0017e31e6e1787b46d20f5a8a28607aab4d8b0363af66e7a47e' },
  { file: '20261014090400_fix_create_order_locking.sql', sha256: 'd623b6b7b8a1fd733fb0984c0d6bb9917e1929b555df068861b92f1f77f6e66c' },
  { file: '20261014090500_fix_theme_validation_nulls.sql', sha256: '3e8df1b132d90ad77f8b9f0fcfc41b8f65d6cd22b4ba861e55df47806b577b35' },
  { file: '20261017090000_harden_function_privileges.sql', sha256: '7f4594db66b1cd4c81008b95045e3dace2a64bdd6ef94ea516c090b62ab51af9' },
  {
    file: '20261025090000_telegram_notifications_and_platform_admin.sql',
    sha256: '3ac9cbd181216bd4a91af64dbcddb2897c040178fd15cf13d13441eb97c5c1d2',
  },
  { file: '20261025090100_notification_secret_cleanup.sql', sha256: 'bd2814d5766a26b2c5100cf270c97926d34db75160a2758948cefc068baad0c3' },
  { file: '20261026090000_fulfillment_and_demo_lifecycle.sql', sha256: 'b1047074d5457504c5fd07b14328ab35d30483f30f468e1d9589dc68e8e119c1' },
  { file: '20261026100000_admin_catalog_delete.sql', sha256: '902c0037dd81d5663cd27806dd8efb31ec234c67cccd81dda850db7b89dc6bc0' },
  // Stage 3A.
  { file: '20261030090000_owner_change_security.sql', sha256: 'e821f2ddcef98c0e3c7864cccab6aaf6648f4cf57d0e400cc062e3a55b979750' },
  { file: '20261030090100_checkout_demo_guard_and_limits.sql', sha256: '8ca9bc74b69f02fe18e0288b77dac805c31af938ba6b4ad81858be20d8c5ee26' },
  { file: '20261031090000_handover_reservation.sql', sha256: 'f1cc03d6c8940c6a32632278de199d4632825785e229a4aa603a0ac0d6f6cbec' },
  {
    file: '20261101090000_handover_invite_cooldown_and_stale_release.sql',
    sha256: '0f874ea1dd388a852142fee1e276819f05f07182f56980f061d8ad6115e6dfb8',
  },
  {
    file: '20261101100000_handover_cancel_keeps_live_reservation.sql',
    sha256: '99beaa3bbfaba535042ceb9e1460f79d2bca6708dd7a90f4c5522eb1ce1eacb5',
  },
  // Stage 3B.
  { file: '20261102090000_platform_admin_mfa.sql', sha256: 'e90e47222b295f75940482aa55b9e9278a22115ec1f617dace057b2d64d9c8c5' },
  { file: '20261102090100_stock_status_projection.sql', sha256: '2ae259986bb867b749b2d2d2c21b2b9a9b9885ee925434bdf7c5fcd94e5d785e' },
  { file: '20261102090200_demo_shop_deletion.sql', sha256: '6d94c3121bd07b082787f3147e0ca27c87db3daa6f770bee0e0d79df8b8d32fd' },
  { file: '20261102090300_platform_admin_mfa_recovery.sql', sha256: 'faff2111c634d5d439224f0c3bfc35be501a3d4f0714069aad3fe7961fdc2d46' },
] as const satisfies readonly MigrationIntegrityEntry[];

export interface MigrationIntegrityEntry {
  readonly file: string;
  readonly sha256: string;
}
