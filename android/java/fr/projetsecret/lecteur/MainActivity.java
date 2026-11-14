package fr.projetsecret.lecteur;

import android.app.NativeActivity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowInsets;

import java.util.Locale;

/**
 * Pont minimal entre Android et le code Rust (toute la logique est en Rust).
 *
 * NativeActivity ne permet pas, depuis le code natif, de recevoir les résultats
 * d'activité (sélecteur de fichiers), les nouveaux intents ou les insets système.
 * Cette classe se contente de mémoriser ces informations ; le code Rust les lit
 * via JNI à chaque image.
 */
public class MainActivity extends NativeActivity {
    private static final int REQ_OPEN = 4242;

    private final Object lock = new Object();
    private String pendingUri;
    private volatile int insetLeft, insetTop, insetRight, insetBottom;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        queueIntent(getIntent());
        try {
            View decor = getWindow().getDecorView();
            decor.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    readInsets(insets);
                    return v.onApplyWindowInsets(insets);
                }
            });
            decor.requestApplyInsets();
        } catch (Throwable t) {
            // ignoré : le code Rust utilise alors une marge par défaut
        }
    }

    private void readInsets(WindowInsets insets) {
        if (insets == null) return;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets i = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            insetLeft = i.left;
            insetTop = i.top;
            insetRight = i.right;
            insetBottom = i.bottom;
        } else {
            insetLeft = insets.getSystemWindowInsetLeft();
            insetTop = insets.getSystemWindowInsetTop();
            insetRight = insets.getSystemWindowInsetRight();
            insetBottom = insets.getSystemWindowInsetBottom();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        queueIntent(intent);
    }

    private void queueIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            try {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            } catch (Throwable t) {
                uri = null;
            }
        }
        if (uri != null) {
            synchronized (lock) {
                pendingUri = uri.toString();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Throwable t) {
                // certains fournisseurs ne proposent pas de permission persistante
            }
            synchronized (lock) {
                pendingUri = uri.toString();
            }
        }
    }

    // ---------------------------------------------------------------------
    // Méthodes appelées depuis Rust (JNI)
    // ---------------------------------------------------------------------

    /** Renvoie (et consomme) l'URI du document à ouvrir, ou null. */
    public String takePendingUri() {
        synchronized (lock) {
            String u = pendingUri;
            pendingUri = null;
            return u;
        }
    }

    /** Ouvre le sélecteur de documents du système (Mes fichiers, Drive, OneDrive...). */
    public void openDocumentPicker() {
        runOnUiThread(new Runnable() { @Override public void run() {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
                        "application/vnd.ms-word.document.macroEnabled.12",
                        "application/msword",
                        "application/vnd.oasis.opendocument.text",
                        "application/vnd.oasis.opendocument.text-template",
                        "application/rtf",
                        "text/rtf",
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
                        "application/vnd.ms-excel.sheet.macroEnabled.12",
                        "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
                        "application/vnd.ms-excel",
                        "application/vnd.oasis.opendocument.spreadsheet",
                        "application/vnd.oasis.opendocument.spreadsheet-template",
                        "text/csv",
                        "text/comma-separated-values",
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
                        "application/vnd.openxmlformats-officedocument.presentationml.template",
                        "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
                        "application/vnd.ms-powerpoint",
                        "application/vnd.oasis.opendocument.presentation",
                        "application/vnd.oasis.opendocument.presentation-template",
                        "application/octet-stream",
                        "application/zip"
                });
                startActivityForResult(i, REQ_OPEN);
            } catch (Throwable t) {
                // aucun sélecteur disponible
            }
        }});
    }

    /** Ouvre l'URI en lecture et renvoie un descripteur de fichier détaché (ou -1). */
    public int openFd(String uri) {
        try {
            ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(Uri.parse(uri), "r");
            if (pfd == null) return -1;
            return pfd.detachFd();
        } catch (Throwable t) {
            return -1;
        }
    }

    /** Nom affichable du document (ex. « Rapport.docx »). */
    public String displayName(String uri) {
        Uri u = Uri.parse(uri);
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) return name;
            }
        } catch (Throwable t) {
            // ignoré
        }
        String last = u.getLastPathSegment();
        if (last == null) return "Document";
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    /** Insets système en pixels : gauche, haut, droite, bas. */
    public int[] getInsets() {
        return new int[]{insetLeft, insetTop, insetRight, insetBottom};
    }

    /** Langue de l'appareil, ex. « fr-FR ». */
    public String localeTag() {
        try {
            return Locale.getDefault().toLanguageTag();
        } catch (Throwable t) {
            return "fr-FR";
        }
    }

    /** Ferme l'application (le processus est ensuite terminé côté Rust). */
    public void exitApp() {
        runOnUiThread(new Runnable() { @Override public void run() {
            try {
                finishAndRemoveTask();
            } catch (Throwable t) {
                finish();
            }
        }});
    }
}
