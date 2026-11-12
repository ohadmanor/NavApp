import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const USERS_COLLECTION = 'users';

export interface AppDirectoryUser {
  uid: string;
  email: string;
  emailLower: string;
  displayName: string;
  displayNameLower: string;
  photoURL: string | null;
  lastActiveAt: string;
}

const registeredSignatures = new Map<string, string>();

export function resetDirectorySessionForTesting(): void {
  registeredSignatures.clear();
}

function mapDocToDirectoryUser(data: Record<string, any>): AppDirectoryUser | null {
  if (!data?.uid && !data?.email) return null;
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  const displayName =
    typeof data.displayName === 'string' && data.displayName.trim()
      ? data.displayName.trim()
      : email.split('@')[0] || 'משתמש NavApp';
  return {
    uid: String(data.uid || ''),
    email,
    emailLower: String(data.emailLower || email.toLowerCase()),
    displayName,
    displayNameLower: String(data.displayNameLower || displayName.toLowerCase()),
    photoURL: typeof data.photoURL === 'string' ? data.photoURL : null,
    lastActiveAt: String(data.lastActiveAt || new Date().toISOString()),
  };
}

export class UserDirectoryService {
  static async registerCurrentUser(
    user: NavUser,
    options?: { force?: boolean }
  ): Promise<boolean> {
    if (!user?.uid) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    const email = (user.email || '').trim();
    const displayName = (user.displayName || email.split('@')[0] || 'משתמש NavApp').trim();
    const sig = `${email.toLowerCase()}|${displayName.toLowerCase()}|${user.photoURL || ''}`;
    if (!options?.force && registeredSignatures.get(user.uid) === sig) {
      return true;
    }

    const services = getFirebaseServices();
    if (!services) return false;

    const record: AppDirectoryUser = {
      uid: user.uid,
      email,
      emailLower: email.toLowerCase(),
      displayName,
      displayNameLower: displayName.toLowerCase(),
      photoURL: user.photoURL || null,
      lastActiveAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(services.firestore, USERS_COLLECTION, user.uid), record, { merge: true });
      registeredSignatures.set(user.uid, sig);
      return true;
    } catch (err) {
      console.warn('[UserDirectoryService] registerCurrentUser warning:', err);
      return false;
    }
  }

  static async searchUsers(
    queryText: string,
    excludeUid?: string
  ): Promise<AppDirectoryUser[]> {
    const normalized = queryText.trim().toLowerCase();
    if (!normalized) return [];

    const services = getFirebaseServices();
    if (!services) return [];

    const colRef = collection(services.firestore, USERS_COLLECTION);
    const byUid = new Map<string, AppDirectoryUser>();

    const collectSnap = (snap: Awaited<ReturnType<typeof getDocs>>) => {
      snap.forEach((docSnap) => {
        const mapped = mapDocToDirectoryUser(docSnap.data() as Record<string, any>);
        if (!mapped || !mapped.uid) return;
        if (excludeUid && mapped.uid === excludeUid) return;
        if (!byUid.has(mapped.uid)) {
          byUid.set(mapped.uid, mapped);
        }
      });
    };

    try {
      if (normalized.includes('@')) {
        const exactSnap = await getDocs(
          query(colRef, where('emailLower', '==', normalized), limit(10))
        );
        collectSnap(exactSnap);

        if (byUid.size === 0) {
          const prefixSnap = await getDocs(
            query(
              colRef,
              where('emailLower', '>=', normalized),
              where('emailLower', '<=', `${normalized}\uf8ff`),
              limit(10)
            )
          );
          collectSnap(prefixSnap);
        }
      } else {
        const [nameRes, emailRes] = await Promise.allSettled([
          getDocs(
            query(
              colRef,
              where('displayNameLower', '>=', normalized),
              where('displayNameLower', '<=', `${normalized}\uf8ff`),
              limit(10)
            )
          ),
          getDocs(
            query(
              colRef,
              where('emailLower', '>=', normalized),
              where('emailLower', '<=', `${normalized}\uf8ff`),
              limit(10)
            )
          ),
        ]);
        if (nameRes.status === 'fulfilled') collectSnap(nameRes.value);
        if (emailRes.status === 'fulfilled') collectSnap(emailRes.value);
      }
    } catch (err) {
      console.warn('[UserDirectoryService] searchUsers warning:', err);
      return [];
    }

    return Array.from(byUid.values()).slice(0, 10);
  }
}
