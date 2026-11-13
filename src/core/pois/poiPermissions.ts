import type { NavUser } from '../firebase/AuthService';

/**
 * Email addresses (normalized lowercase) authorized to delete global POIs
 * or mark bundled POIs as deleted globally.
 */
export const POI_DELETE_ADMIN_EMAILS: readonly string[] = [
  'ohad.manor@gmail.com',
  'nabibesk@gmail.com',
];

/**
 * Legacy per-user POI overrides & locally created POIs from this account
 * are automatically migrated into the global POI store on sign-in.
 */
export const LEGACY_POI_MIGRATION_SOURCE_EMAIL = 'ohad.manor@gmail.com';

export function normalizeUserEmail(email: string | null | undefined): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Only authenticated (signed-in) users can add new POIs or edit POI categories globally.
 */
export function canUserAddOrEditPoi(user: Pick<NavUser, 'uid'> | null | undefined): boolean {
  return Boolean(user && typeof user.uid === 'string' && user.uid.trim().length > 0);
}

/**
 * ONLY ohad.manor@gmail.com and nabibesk@gmail.com can delete POIs globally.
 */
export function canUserDeletePoi(
  user: Pick<NavUser, 'uid' | 'email'> | null | undefined
): boolean {
  if (!canUserAddOrEditPoi(user)) return false;
  const email = normalizeUserEmail(user?.email);
  return Boolean(email && POI_DELETE_ADMIN_EMAILS.includes(email));
}

/**
 * Returns true if the signed-in user is the designated migration source account
 * whose legacy per-user POI overrides/POIs should be promoted to the global store.
 */
export function isLegacyPoiMigrationSourceUser(
  user: Pick<NavUser, 'uid' | 'email'> | null | undefined
): boolean {
  if (!canUserAddOrEditPoi(user)) return false;
  return normalizeUserEmail(user?.email) === LEGACY_POI_MIGRATION_SOURCE_EMAIL;
}
