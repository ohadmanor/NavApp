import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { getFirebaseServices, isFirebaseConfigured } from './firebaseApp';

export interface NavUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

function mapFirebaseUser(user: User | null): NavUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

export class AuthService {
  static isAvailable(): boolean {
    return isFirebaseConfigured();
  }

  static getCurrentUser(): NavUser | null {
    const services = getFirebaseServices();
    return services ? mapFirebaseUser(services.auth.currentUser) : null;
  }

  static subscribeAuth(listener: (user: NavUser | null) => void): () => void {
    const services = getFirebaseServices();
    if (!services) {
      listener(null);
      return () => {};
    }

    // Complete any pending redirect sign-in silently
    void getRedirectResult(services.auth).catch(() => {});

    return onAuthStateChanged(services.auth, (user) => {
      listener(mapFirebaseUser(user));
    });
  }

  static async signInWithGmail(): Promise<NavUser> {
    const services = getFirebaseServices();
    if (!services) {
      throw new Error(
        'Firebase אינו מוגדר עדיין בקובץ הסביבה (.env). הגדר VITE_FIREBASE_API_KEY ו-VITE_FIREBASE_APP_ID.'
      );
    }

    try {
      const cred = await signInWithPopup(services.auth, services.googleProvider);
      const mapped = mapFirebaseUser(cred.user);
      if (!mapped) throw new Error('לא התקבלו פרטי משתמש מ-Google');
      return mapped;
    } catch (err: any) {
      const code = String(err?.code || '');
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        await signInWithRedirect(services.auth, services.googleProvider);
        throw new Error('מפנה להתחברות עם חשבון Google...');
      }
      throw err;
    }
  }

  static async signOut(): Promise<void> {
    const services = getFirebaseServices();
    if (!services) return;
    await firebaseSignOut(services.auth);
  }
}
