import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  getFirebaseServices,
  isFirebaseConfigured,
  type FirebaseClientServices,
} from './firebaseApp';

export interface NavUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface NativeGoogleSignInResult {
  idToken: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
}

export interface NativeGoogleAuthPlugin {
  signIn(options?: { serverClientId?: string }): Promise<NativeGoogleSignInResult>;
  signOut(): Promise<void>;
}

export const NativeGoogleAuth = registerPlugin<NativeGoogleAuthPlugin>('NativeGoogleAuth');

const NATIVE_FALLBACK_ERROR_CODES = new Set([
  'NO_CREDENTIAL',
  'UNAVAILABLE',
  'MISSING_WEB_CLIENT_ID',
  'UNIMPLEMENTED',
]);

function mapFirebaseUser(user: User | null): NavUser | null {
  if (!user) return null;
  const fallbackEmail =
    user.email ||
    (Array.isArray(user.providerData)
      ? user.providerData.find((p) => Boolean(p?.email))?.email || null
      : null);
  return {
    uid: user.uid,
    email: fallbackEmail,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

export function isCapacitorNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).Capacitor?.isNativePlatform?.() || Capacitor.isNativePlatform?.());
}

export function isAndroidNativePlatform(): boolean {
  if (!isCapacitorNativePlatform()) return false;
  const cap = (typeof window !== 'undefined' ? (window as any).Capacitor : undefined) as
    | { getPlatform?: () => string }
    | undefined;
  const platform =
    typeof cap?.getPlatform === 'function' ? cap.getPlatform() : Capacitor.getPlatform?.();
  if (platform) return platform === 'android';
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

async function signInWithAndroidNativeAccount(
  services: FirebaseClientServices
): Promise<NavUser | null> {
  try {
    const result = await NativeGoogleAuth.signIn({
      ...(services.googleWebClientId ? { serverClientId: services.googleWebClientId } : {}),
    });
    if (!result?.idToken) {
      throw new Error('לא התקבל אסימון זיהוי מחשבון Google במכשיר');
    }
    const credential = GoogleAuthProvider.credential(result.idToken);
    const firebaseCred = await signInWithCredential(services.auth, credential);
    const mapped = mapFirebaseUser(firebaseCred.user);
    if (!mapped) throw new Error('לא התקבלו פרטי משתמש מ-Google');
    return mapped;
  } catch (err: any) {
    const code = String(err?.code || '').toUpperCase();
    const message = String(err?.message || '');
    if (code === 'CANCELLED') {
      throw new Error('ההתחברות עם Google בוטלה');
    }
    if (
      NATIVE_FALLBACK_ERROR_CODES.has(code) ||
      /not implemented|unimplemented/i.test(message)
    ) {
      console.warn('[Auth] Native Android Google Sign-In unavailable, falling back to popup:', err);
      return null;
    }
    throw err;
  }
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

    if (isAndroidNativePlatform()) {
      const nativeUser = await signInWithAndroidNativeAccount(services);
      if (nativeUser) {
        return nativeUser;
      }
    }

    try {
      const cred = await signInWithPopup(services.auth, services.googleProvider);
      const mapped = mapFirebaseUser(cred.user);
      if (!mapped) throw new Error('לא התקבלו פרטי משתמש מ-Google');
      return mapped;
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        throw new Error('ההתחברות עם Google בוטלה');
      }
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        if (isCapacitorNativePlatform()) {
          throw new Error('לא ניתן לפתוח את חלון ההתחברות של Google כרגע — נסה שוב');
        }
        await signInWithRedirect(services.auth, services.googleProvider);
        throw new Error('מפנה להתחברות עם חשבון Google...');
      }
      if (code === 'auth/unauthorized-domain') {
        throw new Error('הדומיין אינו מורשה ב-Firebase Auth — הוסף אותו ב-Authorized domains');
      }
      throw err;
    }
  }

  static async signOut(): Promise<void> {
    const services = getFirebaseServices();
    if (isAndroidNativePlatform()) {
      await NativeGoogleAuth.signOut().catch(() => {});
    }
    if (!services) return;
    await firebaseSignOut(services.auth);
  }
}
