-- Intentionally empty. Tenant data is imported by the idempotent tenant pipeline
-- (pnpm tenant:seed --slug <slug>), which also uploads images to Storage.
select 1;
