import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNative: true,
  platform: 'android',
  nativeSignIn: vi.fn(),
  nativeSignOut: vi.fn(),
  getFirebaseServices: vi.fn(),
  googleCredential: vi.fn((idToken: string) => ({ providerId: 'google.com', idToken })),
  signInWithCredential: vi.fn(),
  signInWithPopup: vi.fn(),
  firebaseSignOut: vi.fn(),
  setPersistence: vi.fn(),
}));

vi.mock('@capacitor/core', async () => {
  const actual = await vi.importActual<typeof import('@capacitor/core')>('@capacitor/core');
  return {
    ...actual,
    Capacitor: {
      isNativePlatform: () => mocks.isNative,
      getPlatform: () => mocks.platform,
    },
    registerPlugin: (name: string) => {
      if (name === 'NativeGoogleAuth') {
        return {
          signIn: mocks.nativeSignIn,
          signOut: mocks.nativeSignOut,
        };
      }
      return actual.registerPlugin(name);
    },
  };
});

vi.mock('../firebase/firebaseApp', () => ({
  getFirebaseServices: () => mocks.getFirebaseServices(),
  isFirebaseConfigured: () => Boolean(mocks.getFirebaseServices()),
}));

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth');
  class MockGoogleAuthProvider {
    static credential = mocks.googleCredential;
    setCustomParameters = vi.fn();
  }
  return {
    ...actual,
    GoogleAuthProvider: MockGoogleAuthProvider,
    signInWithCredential: mocks.signInWithCredential,
    signInWithPopup: mocks.signInWithPopup,
    signOut: mocks.firebaseSignOut,
    setPersistence: mocks.setPersistence,
  };
});

import {
  AuthService,
  isAndroidNativePlatform,
  isCapacitorNativePlatform,
} from '../firebase/AuthService';

describe('Native Android Google Sign-In', () => {
  const mockFirebaseUser = {
    uid: 'user-123',
    email: 'hiker@example.com',
    displayName: 'Hiker',
    photoURL: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isNative = true;
    mocks.platform = 'android';
    vi.stubGlobal('window', {
      Capacitor: {
        isNativePlatform: () => mocks.isNative,
        getPlatform: () => mocks.platform,
      },
    });
    mocks.getFirebaseServices.mockReturnValue({
      auth: { currentUser: null },
      googleProvider: { providerId: 'google.com' },
      googleWebClientId: 'mock-web-client.apps.googleusercontent.com',
    });
    mocks.setPersistence.mockResolvedValue(undefined);
    mocks.nativeSignOut.mockResolvedValue(undefined);
    mocks.firebaseSignOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects Android Capacitor native platform', () => {
    expect(isCapacitorNativePlatform()).toBe(true);
    expect(isAndroidNativePlatform()).toBe(true);

    mocks.platform = 'ios';
    expect(isAndroidNativePlatform()).toBe(false);

    mocks.isNative = false;
    mocks.platform = 'android';
    expect(isCapacitorNativePlatform()).toBe(false);
    expect(isAndroidNativePlatform()).toBe(false);
  });

  it('uses NativeGoogleAuth -> signInWithCredential on Android without opening popup', async () => {
    mocks.nativeSignIn.mockResolvedValue({ idToken: 'tok-123' });
    mocks.signInWithCredential.mockResolvedValue({ user: mockFirebaseUser });

    const user = await AuthService.signInWithGmail();

    expect(mocks.nativeSignIn).toHaveBeenCalledWith({
      serverClientId: 'mock-web-client.apps.googleusercontent.com',
    });
    expect(mocks.googleCredential).toHaveBeenCalledWith('tok-123');
    expect(mocks.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(user).toMatchObject({
      uid: 'user-123',
      email: 'hiker@example.com',
      displayName: 'Hiker',
    });
  });

  it('surfaces Hebrew cancellation error without falling back to popup when user cancels', async () => {
    mocks.nativeSignIn.mockRejectedValue({ code: 'CANCELLED', message: 'User cancelled' });

    await expect(AuthService.signInWithGmail()).rejects.toThrow('ההתחברות עם Google בוטלה');
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
  });

  it.each(['NO_CREDENTIAL', 'UNAVAILABLE', 'MISSING_WEB_CLIENT_ID', 'UNIMPLEMENTED'])(
    'falls back to signInWithPopup when native sign-in fails with %s',
    async (code) => {
      mocks.nativeSignIn.mockRejectedValue({ code, message: `Native error: ${code}` });
      mocks.signInWithPopup.mockResolvedValue({ user: mockFirebaseUser });

      const user = await AuthService.signInWithGmail();

      expect(mocks.nativeSignIn).toHaveBeenCalledTimes(1);
      expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);
      expect(user.uid).toBe('user-123');
    }
  );

  it('clears native Google credential state on signOut when running on Android native', async () => {
    await AuthService.signOut();

    expect(mocks.nativeSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('registers NativeGoogleAuthPlugin in MainActivity and declares Credential Manager deps in build.gradle', () => {
    const mainActivity = fs.readFileSync(
      'devops/mobile/android/app/src/main/java/com/navapp/outdoor/israel/MainActivity.java',
      'utf-8'
    );
    const buildGradle = fs.readFileSync('devops/mobile/android/app/build.gradle', 'utf-8');
    const pluginJava = fs.readFileSync(
      'devops/mobile/android/app/src/main/java/com/navapp/outdoor/israel/NativeGoogleAuthPlugin.java',
      'utf-8'
    );

    expect(mainActivity).toContain('registerPlugin(NativeGoogleAuthPlugin.class)');
    expect(buildGradle).toContain('androidx.credentials:credentials:');
    expect(buildGradle).toContain('androidx.credentials:credentials-play-services-auth:');
    expect(buildGradle).toContain('com.google.android.libraries.identity.googleid:googleid:');
    expect(buildGradle).toContain('com.google.android.gms:play-services-auth:');
    expect(pluginJava).toContain('@CapacitorPlugin(name = "NativeGoogleAuth")');
  });
});
