package fr.foyer.menus

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Process
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * Affiche l'erreur qui a arrêté l'application, au lieu du simple « s'arrête systématiquement » d'Android.
 * Tourne dans un processus à part (":erreur" dans le manifeste) : il survit à l'arrêt du processus principal.
 */
class ErreurActivity : Activity() {

  companion object {
    private const val FICHIER = "derniere-erreur.txt"

    /** À appeler en premier dans Application.onCreate du processus principal. */
    fun installer(context: Context) {
      val app = context.applicationContext
      Thread.setDefaultUncaughtExceptionHandler { thread, erreur ->
        try {
          val trace = StringWriter().also { erreur.printStackTrace(PrintWriter(it)) }.toString()
          val version = app.packageManager.getPackageInfo(app.packageName, 0).versionName
          File(app.filesDir, FICHIER).writeText(
            "Menus du foyer $version, Android ${android.os.Build.VERSION.RELEASE} " +
              "(${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}), fil ${thread.name}\n\n$trace"
          )
          app.startActivity(Intent(app, ErreurActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        } catch (_: Throwable) {
        }
        Process.killProcess(Process.myPid())
        exitProcess(10)
      }
    }

    /** Vrai dans le processus de cet écran, où React Native ne doit pas être chargé. */
    fun estProcessusErreur(): Boolean =
      try {
        File("/proc/self/cmdline").readText().trimEnd('\u0000').endsWith(":erreur")
      } catch (_: Throwable) {
        false
      }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val texte = File(filesDir, FICHIER).let { if (it.exists()) it.readText() else "Aucune erreur enregistrée." }
    val marge = (16 * resources.displayMetrics.density).toInt()

    val titre = TextView(this).apply {
      text = "L'application s'est arrêtée. Copiez ce message et envoyez-le pour correction."
      textSize = 16f
      setPadding(0, 0, 0, marge)
    }
    val detail = TextView(this).apply {
      text = texte
      textSize = 11f
      typeface = Typeface.MONOSPACE
      setTextIsSelectable(true)
    }
    val copier = Button(this).apply {
      text = "Copier le message"
      setOnClickListener {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Erreur", texte))
        Toast.makeText(this@ErreurActivity, "Message copié", Toast.LENGTH_SHORT).show()
      }
    }
    val relancer = Button(this).apply {
      text = "Relancer l'application"
      setOnClickListener {
        startActivity(Intent(this@ErreurActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
      }
    }

    val colonne = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(marge, marge * 3, marge, marge)
      addView(titre)
      addView(copier, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(relancer, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(detail)
    }
    setContentView(ScrollView(this).apply { addView(colonne) })
  }
}
