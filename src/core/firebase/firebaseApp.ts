import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { getFirestore, type Firestore } from 'firebase/firestore';

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export function getFirebaseConfigFromEnv(): FirebaseClientConfig {
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : {}) || {};
  const projectId = String(env.VITE_FIREBASE_PROJECT_ID || 'navapp-israel-topo').trim();
  return {
    apiKey: String(env.VITE_FIREBASE_API_KEY || '').trim(),
    authDomain: String(env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`).trim(),
    projectId,
    storageBucket: String(
      env.VITE_FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`
    ).trim(),
    messagingSenderId: String(env.VITE_FIREBASE_MESSAGING_SENDER_ID || '').trim(),
    appId: String(env.VITE_FIREBASE_APP_ID || '').trim(),
  };
}

export function isFirebaseConfigured(): boolean {
  const cfg = getFirebaseConfigFromEnv();
  return Boolean(cfg.apiKey && cfg.projectId && cfg.appId);
}

export interface FirebaseClientServices {
  app: FirebaseApp;
  auth: Auth;
  storage: FirebaseStorage;
  firestore: Firestore;
  googleProvider: GoogleAuthProvider;
}

let cachedServices: FirebaseClientServices | null = null;

export function getFirebaseServices(): FirebaseClientServices | null {
  if (!isFirebaseConfigured()) {
    return null;
  }
  if (cachedServices) {
    return cachedServices;
  }

  const cfg = getFirebaseConfigFromEnv();
  const app = getApps().length > 0 ? getApp() : initializeApp(cfg);
  const auth = getAuth(app);
  const storage = getStorage(app);
  storage.maxUploadRetryTime = 8000;
  storage.maxOperationRetryTime = 8000;
  const firestore = getFirestore(app);
  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });

  cachedServices = { app, auth, storage, firestore, googleProvider };
  return cachedServices;
}
