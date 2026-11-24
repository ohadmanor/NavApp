package com.navapp.outdoor.israel;

import android.app.Activity;
import android.content.Intent;
import android.os.CancellationSignal;
import android.text.TextUtils;
import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.tasks.Task;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native Android Google Sign-In bridge using Jetpack Credential Manager (Google Identity)
 * with legacy Play Services GoogleSignIn fallback so users pick an existing phone Google account
 * in one tap instead of typing credentials inside a sandboxed WebView.
 */
@CapacitorPlugin(name = "NativeGoogleAuth")
public class NativeGoogleAuthPlugin extends Plugin {
    private static final String CODE_CANCELLED = "CANCELLED";
    private static final String CODE_NO_CREDENTIAL = "NO_CREDENTIAL";
    private static final String CODE_UNAVAILABLE = "UNAVAILABLE";
    private static final String CODE_MISSING_CLIENT_ID = "MISSING_WEB_CLIENT_ID";
    private static final String CODE_NATIVE_ERROR = "NATIVE_ERROR";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private GoogleSignInClient legacySignInClient;

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        executor.shutdownNow();
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            call.reject("Android activity is not available for Google Sign-In.", CODE_UNAVAILABLE);
            return;
        }

        String serverClientId = resolveServerClientId(call.getString("serverClientId"));
        if (TextUtils.isEmpty(serverClientId)) {
            call.reject(
                "Missing Google Web Client ID for Android native sign-in.",
                CODE_MISSING_CLIENT_ID
            );
            return;
        }

        CredentialManager credentialManager = CredentialManager.create(activity);
        GetSignInWithGoogleOption signInOption =
            new GetSignInWithGoogleOption.Builder(serverClientId).build();
        GetCredentialRequest request =
            new GetCredentialRequest.Builder().addCredentialOption(signInOption).build();

        activity.runOnUiThread(() ->
            credentialManager.getCredentialAsync(
                activity,
                request,
                new CancellationSignal(),
                executor,
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(@NonNull GetCredentialResponse result) {
                        handleCredentialResult(call, result);
                    }

                    @Override
                    public void onError(@NonNull GetCredentialException e) {
                        if (e instanceof GetCredentialCancellationException) {
                            call.reject("ההתחברות עם Google בוטלה", CODE_CANCELLED);
                            return;
                        }
                        if (shouldFallbackToGoogleIdOptionOrLegacy(e)) {
                            tryGoogleIdOptionThenLegacy(
                                activity,
                                credentialManager,
                                serverClientId,
                                call
                            );
                            return;
                        }
                        call.reject(describeCredentialError(e), CODE_NATIVE_ERROR);
                    }
                }
            )
        );
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        CredentialManager credentialManager = CredentialManager.create(activity);
        credentialManager.clearCredentialStateAsync(
            new ClearCredentialStateRequest(),
            new CancellationSignal(),
            executor,
            new CredentialManagerCallback<Void, ClearCredentialException>() {
                @Override
                public void onResult(Void unused) {
                    signOutLegacyClient(activity, call);
                }

                @Override
                public void onError(@NonNull ClearCredentialException e) {
                    signOutLegacyClient(activity, call);
                }
            }
        );
    }

    private void tryGoogleIdOptionThenLegacy(
        Activity activity,
        CredentialManager credentialManager,
        String serverClientId,
        PluginCall call
    ) {
        GetGoogleIdOption googleIdOption = new GetGoogleIdOption.Builder()
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .setServerClientId(serverClientId)
            .build();
        GetCredentialRequest request =
            new GetCredentialRequest.Builder().addCredentialOption(googleIdOption).build();

        activity.runOnUiThread(() ->
            credentialManager.getCredentialAsync(
                activity,
                request,
                new CancellationSignal(),
                executor,
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(@NonNull GetCredentialResponse result) {
                        handleCredentialResult(call, result);
                    }

                    @Override
                    public void onError(@NonNull GetCredentialException e) {
                        if (e instanceof GetCredentialCancellationException) {
                            call.reject("ההתחברות עם Google בוטלה", CODE_CANCELLED);
                            return;
                        }
                        if (shouldFallbackToGoogleIdOptionOrLegacy(e)) {
                            launchLegacyGoogleSignIn(activity, serverClientId, call);
                            return;
                        }
                        call.reject(describeCredentialError(e), CODE_NATIVE_ERROR);
                    }
                }
            )
        );
    }

    private void launchLegacyGoogleSignIn(
        Activity activity,
        String serverClientId,
        PluginCall call
    ) {
        activity.runOnUiThread(() -> {
            try {
                GoogleSignInOptions gso = new GoogleSignInOptions.Builder(
                    GoogleSignInOptions.DEFAULT_SIGN_IN
                )
                    .requestIdToken(serverClientId)
                    .requestEmail()
                    .build();
                legacySignInClient = GoogleSignIn.getClient(activity, gso);
                // Sign out previous Play Services selection quietly so the device account picker appears cleanly
                legacySignInClient
                    .signOut()
                    .addOnCompleteListener(activity, ignored -> {
                        try {
                            Intent signInIntent = legacySignInClient.getSignInIntent();
                            startActivityForResult(call, signInIntent, "handleLegacySignInResult");
                        } catch (Throwable err) {
                            call.reject(
                                err.getMessage() != null
                                    ? err.getMessage()
                                    : "Legacy Google Sign-In unavailable.",
                                CODE_UNAVAILABLE
                            );
                        }
                    });
            } catch (Throwable err) {
                call.reject(
                    err.getMessage() != null
                        ? err.getMessage()
                        : "Native Google Sign-In unavailable.",
                    CODE_UNAVAILABLE
                );
            }
        });
    }

    @ActivityCallback
    public void handleLegacySignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result != null ? result.getData() : null;
        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data);
        try {
            GoogleSignInAccount account = task.getResult(ApiException.class);
            String idToken = account != null ? account.getIdToken() : null;
            if (TextUtils.isEmpty(idToken)) {
                call.reject("לא התקבל אסימון זיהוי מחשבון Google.", CODE_NATIVE_ERROR);
                return;
            }
            JSObject payload = new JSObject();
            payload.put("idToken", idToken);
            if (account.getEmail() != null) payload.put("email", account.getEmail());
            if (account.getDisplayName() != null) {
                payload.put("displayName", account.getDisplayName());
            }
            if (account.getPhotoUrl() != null) {
                payload.put("photoUrl", account.getPhotoUrl().toString());
            }
            call.resolve(payload);
        } catch (ApiException apiErr) {
            int code = apiErr.getStatusCode();
            if (
                code == GoogleSignInStatusCodes.SIGN_IN_CANCELLED ||
                code == CommonStatusCodes.CANCELED
            ) {
                call.reject("ההתחברות עם Google בוטלה", CODE_CANCELLED);
                return;
            }
            if (
                code == GoogleSignInStatusCodes.SIGN_IN_FAILED ||
                code == CommonStatusCodes.RESOLUTION_REQUIRED
            ) {
                call.reject(apiErr.getMessage(), CODE_UNAVAILABLE);
                return;
            }
            call.reject(
                "Google Sign-In failed (" + code + "): " + apiErr.getMessage(),
                CODE_UNAVAILABLE
            );
        }
    }

    private void handleCredentialResult(PluginCall call, GetCredentialResponse result) {
        Credential credential = result.getCredential();
        if (
            credential instanceof CustomCredential &&
            GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())
        ) {
            try {
                GoogleIdTokenCredential googleCred =
                    GoogleIdTokenCredential.createFrom(credential.getData());
                String idToken = googleCred.getIdToken();
                if (TextUtils.isEmpty(idToken)) {
                    call.reject("Google ID token was empty.", CODE_NATIVE_ERROR);
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("idToken", idToken);
                payload.put("email", googleCred.getId());
                if (googleCred.getDisplayName() != null) {
                    payload.put("displayName", googleCred.getDisplayName());
                }
                if (googleCred.getProfilePictureUri() != null) {
                    payload.put("photoUrl", googleCred.getProfilePictureUri().toString());
                }
                call.resolve(payload);
            } catch (Exception parseErr) {
                call.reject(parseErr.getMessage(), CODE_NATIVE_ERROR);
            }
            return;
        }
        call.reject("Unsupported Google credential type returned.", CODE_UNAVAILABLE);
    }

    private void signOutLegacyClient(Activity activity, PluginCall call) {
        try {
            GoogleSignInClient client = legacySignInClient;
            if (client == null) {
                String serverClientId = resolveServerClientId(null);
                if (!TextUtils.isEmpty(serverClientId)) {
                    GoogleSignInOptions gso = new GoogleSignInOptions.Builder(
                        GoogleSignInOptions.DEFAULT_SIGN_IN
                    )
                        .requestIdToken(serverClientId)
                        .requestEmail()
                        .build();
                    client = GoogleSignIn.getClient(activity, gso);
                }
            }
            if (client != null) {
                client.signOut().addOnCompleteListener(activity, ignored -> call.resolve());
                return;
            }
        } catch (Throwable ignored) {
            // Ignore sign-out errors if legacy client is unused
        }
        call.resolve();
    }

    @Nullable
    private String resolveServerClientId(@Nullable String explicitClientId) {
        if (explicitClientId != null && !explicitClientId.trim().isEmpty()) {
            return explicitClientId.trim();
        }
        int resId = getContext()
            .getResources()
            .getIdentifier("default_web_client_id", "string", getContext().getPackageName());
        if (resId != 0) {
            String value = getContext().getString(resId);
            if (!TextUtils.isEmpty(value)) {
                return value.trim();
            }
        }
        return null;
    }

    private static boolean shouldFallbackToGoogleIdOptionOrLegacy(GetCredentialException e) {
        return (
            e instanceof NoCredentialException ||
            e instanceof GetCredentialProviderConfigurationException ||
            e instanceof GetCredentialUnsupportedException
        );
    }

    private static String describeCredentialError(GetCredentialException e) {
        String msg = e.getMessage();
        return msg != null && !msg.trim().isEmpty()
            ? msg
            : "Native Google Sign-In failed.";
    }
}
