package expo.modules.devicetranslate

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DeviceTranslateModule : Module() {
  // One translator per language pair, reused across calls (creating one is expensive).
  private val translators = mutableMapOf<String, Translator>()

  private fun translatorFor(from: String, to: String): Translator? {
    val src = TranslateLanguage.fromLanguageTag(from) ?: return null
    val dst = TranslateLanguage.fromLanguageTag(to) ?: return null
    return translators.getOrPut("$src>$dst") {
      Translation.getClient(TranslatorOptions.Builder().setSourceLanguage(src).setTargetLanguage(dst).build())
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceTranslate")

    Function("supportedLanguages") {
      TranslateLanguage.getAllLanguages()
    }

    /** Translate, downloading the language models first if needed. */
    AsyncFunction("translate") { text: String, from: String, to: String, promise: Promise ->
      if (from == to) {
        promise.resolve(text)
        return@AsyncFunction
      }
      val translator = translatorFor(from, to)
      if (translator == null) {
        promise.reject("ERR_UNSUPPORTED_LANGUAGE", "On-device translation does not support $from → $to", null)
        return@AsyncFunction
      }
      translator.downloadModelIfNeeded(DownloadConditions.Builder().build())
        .continueWithTask { task ->
          if (!task.isSuccessful) throw task.exception ?: Exception("Model download failed")
          translator.translate(text)
        }
        .addOnSuccessListener { promise.resolve(it) }
        .addOnFailureListener { promise.reject("ERR_TRANSLATE", it.message ?: "Translation failed", it) }
    }

    AsyncFunction("isModelDownloaded") { language: String, promise: Promise ->
      val lang = TranslateLanguage.fromLanguageTag(language)
      if (lang == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      RemoteModelManager.getInstance()
        .isModelDownloaded(TranslateRemoteModel.Builder(lang).build())
        .addOnSuccessListener { promise.resolve(it) }
        .addOnFailureListener { promise.resolve(false) }
    }

    AsyncFunction("downloadModel") { language: String, wifiOnly: Boolean, promise: Promise ->
      val lang = TranslateLanguage.fromLanguageTag(language)
      if (lang == null) {
        promise.reject("ERR_UNSUPPORTED_LANGUAGE", "On-device translation does not support $language", null)
        return@AsyncFunction
      }
      val conditions = DownloadConditions.Builder().apply { if (wifiOnly) requireWifi() }.build()
      RemoteModelManager.getInstance()
        .download(TranslateRemoteModel.Builder(lang).build(), conditions)
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.reject("ERR_DOWNLOAD", it.message ?: "Download failed", it) }
    }

    OnDestroy {
      translators.values.forEach { it.close() }
      translators.clear()
    }
  }
}
