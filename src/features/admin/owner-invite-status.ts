import type { OwnerInvite } from './functions-api';

/** How the platform admin's screens name the four states of an owner registration link. */
export const OWNER_INVITE_STATUS: Record<OwnerInvite['status'], { label: string; variant: 'secondary' | 'default' | 'outline' | 'destructive' }> = {
  active: { label: 'Активна', variant: 'secondary' },
  used: { label: 'Использована', variant: 'default' },
  expired: { label: 'Истекла', variant: 'outline' },
  revoked: { label: 'Отозвана', variant: 'destructive' },
};
