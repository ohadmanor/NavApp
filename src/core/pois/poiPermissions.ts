import type { PoiRecord } from '../db/NavDatabase';
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

export function isPrivatePoi(poi: Pick<PoiRecord, 'visibility'> | null | undefined): boolean {
  return poi?.visibility === 'private';
}

export function isOwnedPrivatePoi(
  poi: Pick<PoiRecord, 'visibility' | 'ownership' | 'ownerUid' | 'createdByUid'> | null | undefined,
  user: Pick<NavUser, 'uid'> | null | undefined
): boolean {
  if (!poi || !isPrivatePoi(poi) || !user?.uid) return false;
  if (poi.ownership === 'shared') return false;
  const owner = poi.ownerUid || poi.createdByUid;
  return Boolean(owner && owner === user.uid);
}

export function isSharedWithMePoi(
  poi: Pick<PoiRecord, 'visibility' | 'ownership' | 'ownerUid' | 'createdByUid'> | null | undefined,
  user: Pick<NavUser, 'uid'> | null | undefined
): boolean {
  if (!poi || !isPrivatePoi(poi)) return false;
  if (poi.ownership === 'shared') return true;
  if (!user?.uid) return false;
  const owner = poi.ownerUid || poi.createdByUid;
  return Boolean(owner && owner !== user.uid);
}

/**
 * Only authenticated (signed-in) users can add new POIs or edit global POI categories.
 */
export function canUserAddOrEditPoi(user: Pick<NavUser, 'uid'> | null | undefined): boolean {
  return Boolean(user && typeof user.uid === 'string' && user.uid.trim().length > 0);
}

export function canUserEditPoiCategory(
  user: Pick<NavUser, 'uid'> | null | undefined,
  poi?: Pick<PoiRecord, 'visibility' | 'ownership' | 'ownerUid' | 'createdByUid'> | null
): boolean {
  if (!canUserAddOrEditPoi(user)) return false;
  if (poi && isPrivatePoi(poi)) {
    return isOwnedPrivatePoi(poi, user);
  }
  return true;
}

export function canUserShareOrPromotePoi(
  user: Pick<NavUser, 'uid'> | null | undefined,
  poi: Pick<PoiRecord, 'visibility' | 'ownership' | 'ownerUid' | 'createdByUid'> | null | undefined
): boolean {
  return isOwnedPrivatePoi(poi, user);
}

/**
 * Global/bundled POI deletion is restricted to POI_DELETE_ADMIN_EMAILS.
 * Private POIs owned by the signed-in user can be deleted by their owner.
 */
export function canUserDeletePoi(
  user: Pick<NavUser, 'uid' | 'email'> | null | undefined,
  poi?: Pick<PoiRecord, 'visibility' | 'ownership' | 'ownerUid' | 'createdByUid'> | null
): boolean {
  if (!canUserAddOrEditPoi(user)) return false;
  if (poi && isPrivatePoi(poi)) {
    return isOwnedPrivatePoi(poi, user);
  }
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
