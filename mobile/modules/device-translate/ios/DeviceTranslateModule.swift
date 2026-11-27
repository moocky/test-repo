import ExpoModulesCore
import MLKitTranslate

public final class DeviceTranslateModule: Module {
  // One translator per language pair, reused across calls (creating one is expensive).
  private var translators: [String: Translator] = [:]

  private func language(_ tag: String) -> TranslateLanguage? {
    let lang = TranslateLanguage(rawValue: tag)
    return TranslateLanguage.allLanguages().contains(lang) ? lang : nil
  }

  private func translator(from: TranslateLanguage, to: TranslateLanguage) -> Translator {
    let key = "\(from.rawValue)>\(to.rawValue)"
    if let existing = translators[key] {
      return existing
    }
    let created = Translator.translator(options: TranslatorOptions(sourceLanguage: from, targetLanguage: to))
    translators[key] = created
    return created
  }

  public func definition() -> ModuleDefinition {
    Name("DeviceTranslate")

    Function("supportedLanguages") { () -> [String] in
      return TranslateLanguage.allLanguages().map { $0.rawValue }
    }

    /// Translate, downloading the language models first if needed.
    AsyncFunction("translate") { (text: String, from: String, to: String, promise: Promise) in
      if from == to {
        promise.resolve(text)
        return
      }
      guard let src = self.language(from), let dst = self.language(to) else {
        promise.reject("ERR_UNSUPPORTED_LANGUAGE", "On-device translation does not support \(from) → \(to)")
        return
      }
      let translator = self.translator(from: src, to: dst)
      let conditions = ModelDownloadConditions(allowsCellularAccess: true, allowsBackgroundDownloading: true)
      translator.downloadModelIfNeeded(with: conditions) { error in
        if let error = error {
          promise.reject("ERR_DOWNLOAD", error.localizedDescription)
          return
        }
        translator.translate(text) { result, error in
          if let error = error {
            promise.reject("ERR_TRANSLATE", error.localizedDescription)
          } else {
            promise.resolve(result ?? "")
          }
        }
      }
    }

    AsyncFunction("isModelDownloaded") { (tag: String) -> Bool in
      guard let lang = self.language(tag) else { return false }
      return ModelManager.modelManager().isModelDownloaded(TranslateRemoteModel.translateRemoteModel(language: lang))
    }

    /// Download one language's model by preparing an English ↔ language translator.
    AsyncFunction("downloadModel") { (tag: String, wifiOnly: Bool, promise: Promise) in
      guard let lang = self.language(tag) else {
        promise.reject("ERR_UNSUPPORTED_LANGUAGE", "On-device translation does not support \(tag)")
        return
      }
      if lang == .english {
        promise.resolve(true) // English is built in
        return
      }
      let translator = self.translator(from: .english, to: lang)
      let conditions = ModelDownloadConditions(allowsCellularAccess: !wifiOnly, allowsBackgroundDownloading: true)
      translator.downloadModelIfNeeded(with: conditions) { error in
        if let error = error {
          promise.reject("ERR_DOWNLOAD", error.localizedDescription)
        } else {
          promise.resolve(true)
        }
      }
    }
  }
}
