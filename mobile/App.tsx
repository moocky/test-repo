import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { LANGUAGES, byCode, deviceSupported, resolveLanguage, type Language } from "./src/languages";
import { LanguagePicker } from "./src/components/LanguagePicker";
import { MicButton } from "./src/components/MicButton";
import { FaceToFace } from "./src/components/FaceToFace";
import { RateLimitError, speechTranslate } from "./src/api";
import { CLOUD_CONFIGURED } from "./src/config";
import {
  NeedsCloudError,
  deviceEngineAvailable,
  deviceProblem,
  effectiveEngine,
  ensureLanguagePacks,
  languagePacksMissing,
  translateText,
  type Engine,
} from "./src/engine";
import { enqueueSpeech, hasDeviceVoice, onSpeakingChange, setServerVoiceAllowed, speak, stopSpeaking } from "./src/speech";
import { loadHistory, loadSettings, saveHistory, saveSettings, type Entry, type Settings } from "./src/storage";
import { colors } from "./src/theme";
import { useLiveTranscription, type Segment } from "./src/useLiveTranscription";
import { useHeadphones } from "./src/useHeadphones";
import { deviceRecognitionAvailable, useDeviceRecognition } from "./src/useDeviceRecognition";

type Side = "A" | "B";
type SegTranslation = { translation: string; detectedLanguage: string | null; detectedLanguageCode: string | null };
type Turn = { side: Side; source: Language | null; target: Language; speakLive: boolean; engine: Engine };
const other = (side: Side): Side => (side === "A" ? "B" : "A");

export default function App() {
  return (
    <SafeAreaProvider>
      <Translator />
    </SafeAreaProvider>
  );
}

function Translator() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<Entry[]>([]);
  const [picker, setPicker] = useState<Side | null>(null);
  const [recordingSide, setRecordingSide] = useState<Side | null>(null);
  const [busySide, setBusySide] = useState<Side | null>(null);
  const [typed, setTyped] = useState("");
  const startedAt = useRef(0);

  // Live translation of finished sentences while the speaker is still talking.
  const [liveTranslations, setLiveTranslations] = useState<{ id: string; text: string | null }[]>([]);
  const turn = useRef<Turn | null>(null);
  const segPromises = useRef(new Map<string, Promise<SegTranslation>>());
  const speakChain = useRef<Promise<void>>(Promise.resolve());

  const translateSegment = (seg: Segment, previous: Segment[]) => {
    const t = turn.current;
    if (!t || segPromises.current.has(seg.id)) return;
    setLiveTranslations((l) => [...l, { id: seg.id, text: null }]);
    const context = previous.map((p) => p.text.trim()).slice(-3);
    const promise = translateText(t.engine, seg.text.trim(), t.source, t.target, context).then((r) => {
      // Lock in the speaker's language as soon as the first sentence is understood.
      markDetected(t.side, r.detectedLanguage, r.detectedLanguageCode);
      return {
        translation: r.translation,
        detectedLanguage: r.detectedLanguage ?? null,
        detectedLanguageCode: r.detectedLanguageCode ?? null,
      };
    });
    segPromises.current.set(seg.id, promise);
    promise
      .then((r) => setLiveTranslations((l) => l.map((x) => (x.id === seg.id ? { ...x, text: r.translation } : x))))
      .catch(() => setLiveTranslations((l) => l.map((x) => (x.id === seg.id ? { ...x, text: "⚠︎" } : x))));
    if (t.speakLive) {
      // Keep spoken order = spoken order of the sentences, even if translations finish out of order.
      speakChain.current = speakChain.current.then(() =>
        promise.then((r) => void enqueueSpeech(r.translation, t.target)).catch(() => {}),
      );
    }
  };

  const recordingSideRef = useRef<Side | null>(null);
  const stopRef = useRef<(side: Side) => void>(() => {});
  const liveOpts = {
    onFinal: translateSegment,
    // Server reached the max session length: wrap up exactly as if the user tapped stop.
    onMaxDuration: () => recordingSideRef.current && stopRef.current(recordingSideRef.current),
  };
  const cloudLive = useLiveTranscription(liveOpts);
  const deviceLive = useDeviceRecognition(liveOpts);
  const engine: Engine = effectiveEngine(settings?.engine ?? "cloud");
  /** The recogniser that the current turn uses (fixed per turn even if the engine is switched meanwhile). */
  const turnEngine = useRef<Engine>(engine);
  const live = (recordingSideRef.current ? turnEngine.current : engine) === "device" ? deviceLive : cloudLive;
  setServerVoiceAllowed(engine === "cloud");

  // On-device: fetch the offline language packs for the chosen pair before they're needed.
  const [packs, setPacks] = useState<"idle" | "checking" | "downloading" | "ready" | "error">("idle");
  useEffect(() => {
    if (engine !== "device" || !deviceEngineAvailable || !settings) return setPacks("idle");
    const langs = [byCode(settings.langA), byCode(settings.langB)].filter((l): l is Language => !!l && deviceSupported(l));
    let cancelled = false;
    setPacks("checking");
    languagePacksMissing(langs)
      .then((missing) => {
        if (cancelled) return;
        if (missing) setPacks("downloading");
        return ensureLanguagePacks(langs);
      })
      .then(() => !cancelled && setPacks("ready"))
      .catch(() => !cancelled && setPacks("error"));
    return () => {
      cancelled = true;
    };
  }, [engine, settings?.langA, settings?.langB]);

  // Echo guard: through the loudspeaker the mic would hear the translation and transcribe it,
  // so the mic is muted while the app speaks. With headphones there is no echo → keep it open.
  const headphones = useHeadphones();
  const onHeadphones = headphones.detectable ? headphones.connected : !!settings?.manualHeadphones;
  /**
   * Live speaking in effect right now: the user's own choice, or automatically while headphones
   * are connected. Derived, not saved, so unplugging returns to the user's setting.
   */
  const liveSpeakAuto = !!settings?.autoSpeak && !settings.liveSpeak && settings.liveSpeakWithHeadphones && onHeadphones;
  const liveSpeakActive = !!settings?.autoSpeak && (settings.liveSpeak || liveSpeakAuto);
  const onHeadphonesRef = useRef(onHeadphones);
  onHeadphonesRef.current = onHeadphones;
  const speakingNow = useRef(false);
  useEffect(
    () =>
      onSpeakingChange((speaking) => {
        speakingNow.current = speaking;
        live.setMuted(speaking && !onHeadphonesRef.current);
      }),
    [live.setMuted],
  );
  // Re-evaluate immediately if headphones are plugged in / removed mid-sentence.
  useEffect(() => {
    live.setMuted(speakingNow.current && !onHeadphones);
  }, [onHeadphones, live.setMuted]);

  useEffect(() => {
    loadSettings().then(setSettings);
    loadHistory().then(setHistory);
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...(s as Settings), ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  /**
   * A side in auto mode adopts the language it was just heard speaking. Returns the resolved language.
   * Ignored when it equals the other side's language (most likely the wrong mic was tapped).
   */
  const markDetected = useCallback((side: Side, name?: string | null, iso?: string | null) => {
    const lang = resolveLanguage(name, iso);
    if (!lang) return null;
    setSettings((s) => {
      if (!s) return s;
      const auto = side === "A" ? s.autoA : s.autoB;
      const otherCode = side === "A" ? s.langB : s.langA;
      const current = side === "A" ? s.langA : s.langB;
      const detected = side === "A" ? s.detectedA : s.detectedB;
      if (!auto || lang.code === otherCode || (detected && lang.code === current)) return s;
      const next = side === "A" ? { ...s, langA: lang.code, detectedA: true } : { ...s, langB: lang.code, detectedB: true };
      saveSettings(next);
      return next;
    });
    return lang;
  }, []);

  const addEntry = useCallback((e: Entry) => {
    setHistory((h) => {
      const next = [e, ...h];
      saveHistory(next);
      return next;
    });
  }, []);

  if (!settings) return <View style={styles.root} />;

  const langA = byCode(settings.langA) ?? LANGUAGES[0];
  const langB = byCode(settings.langB) ?? LANGUAGES[1];
  const langsFor = (side: Side): [Language, Language] => (side === "A" ? [langA, langB] : [langB, langA]);
  /** Auto-detect needs the cloud engine; on-device, a side keeps its last (or chosen) language. */
  const isAuto = (side: Side) => engine === "cloud" && (side === "A" ? settings.autoA : settings.autoB);
  /** False while a side is in auto mode and hasn't spoken yet – nothing can be translated *into* it. */
  const isKnown = (side: Side) => !isAuto(side) || (side === "A" ? settings.detectedA : settings.detectedB);
  const waitForOther = () =>
    Alert.alert(
      "Language not detected yet",
      "The other person's language is set to auto-detect. Let them speak first, or pick their language.",
    );

  async function startRecording(side: Side) {
    if (!isKnown(other(side))) return waitForOther();
    const [source, target] = langsFor(side);
    if (engine === "device") {
      const problem = !deviceEngineAvailable || !deviceRecognitionAvailable
        ? "On-device mode needs a development build of the app (it isn't available in Expo Go or on the web)."
        : deviceProblem(source, target);
      if (problem) return Alert.alert("Not available on-device", problem);
    } else {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone needed", "Allow microphone access in Settings to translate speech.");
        return;
      }
    }
    await stopSpeaking();
    // The on-device recogniser configures the audio session itself.
    if (engine === "cloud") await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    segPromises.current = new Map();
    speakChain.current = Promise.resolve();
    setLiveTranslations([]);
    const auto = isAuto(side);
    // On-device, the recogniser can't be muted while the phone speaks, so live speaking is only
    // safe with headphones; through the loudspeaker the whole translation is spoken after "stop".
    const speakLive = liveSpeakActive && (engine === "cloud" || onHeadphones);
    turn.current = { side, source: auto ? null : source, target, speakLive, engine };
    turnEngine.current = engine;
    try {
      if (engine === "device") {
        await deviceLive.start(source.code, { echoCancellation: !onHeadphones });
      } else {
        // Auto mode: no language hint, so speech-to-text identifies the language itself.
        await cloudLive.start(auto ? null : source.stt);
      }
    } catch (e) {
      (engine === "device" ? deviceLive : cloudLive).cancel();
      Alert.alert("Microphone error", e instanceof Error ? e.message : String(e));
      return;
    }
    startedAt.current = Date.now();
    recordingSideRef.current = side;
    setRecordingSide(side);
  }

  async function stopAndTranslate(side: Side) {
    if (recordingSideRef.current !== side) return; // already stopping (e.g. tap + server max length)
    recordingSideRef.current = null;
    setRecordingSide(null);
    const tooShort = Date.now() - startedAt.current < 500;
    setBusySide(side);
    const [source, target] = langsFor(side);
    try {
      const heard = await live.stop();
      // Route playback back to the loudspeaker on iOS.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (tooShort) return;

      let r: {
        transcript: string;
        translation: string;
        detectedLanguage: string | null;
        detectedLanguageCode: string | null;
        audioBase64?: string;
      };
      const src = isAuto(side) ? null : source;
      let spokenLive = false;
      if (heard.transcript) {
        // Most sentences were already translated while speaking; translate whatever is left
        // (the last sentence, or any segment still partial when the stream closed).
        heard.segments.forEach((seg, i) => translateSegment(seg, heard.segments.slice(0, i)));
        const parts = await Promise.all(heard.segments.map((seg) => segPromises.current.get(seg.id)!));
        r = {
          transcript: heard.transcript,
          translation: parts.map((p) => p.translation).join(" "),
          detectedLanguage: parts.find((p) => p.detectedLanguage)?.detectedLanguage ?? null,
          detectedLanguageCode: parts.find((p) => p.detectedLanguageCode)?.detectedLanguageCode ?? null,
        };
        spokenLive = !!turn.current?.speakLive;
      } else if (turnEngine.current === "device" && heard.errorMessage) {
        throw new Error(`Speech recognition: ${heard.errorMessage}`);
      } else if (heard.rateLimited) {
        throw new RateLimitError(heard.errorMessage ?? "Too many requests. Please wait a moment.");
      } else if (heard.liveFailed && heard.fileUri) {
        // Live stream dropped: send the recorded file through the batch pipeline.
        const needServerVoice = settings!.autoSpeak && !(await hasDeviceVoice(target));
        r = await speechTranslate(heard.fileUri, src, target, needServerVoice);
      } else {
        r = { transcript: "", translation: "", detectedLanguage: null, detectedLanguageCode: null };
      }
      if (!r.transcript) {
        Alert.alert("Didn't catch that", "No speech was recognised. Try again a little closer to the mic.");
        return;
      }
      const heardIn = markDetected(side, r.detectedLanguage, r.detectedLanguageCode);
      addEntry({
        id: `${Date.now()}`,
        side,
        sourceCode: src ? source.code : (heardIn?.code ?? null),
        detected: r.detectedLanguage,
        targetCode: target.code,
        transcript: r.transcript,
        translation: r.translation,
        at: Date.now(),
      });
      setLiveTranslations([]);
      setBusySide(null); // the entry is on screen; don't keep the spinner during playback
      if (settings!.autoSpeak && !spokenLive) await speak(r.translation, target, r.audioBase64);
    } catch (e) {
      Alert.alert(
        e instanceof RateLimitError ? "Slow down" : e instanceof NeedsCloudError ? "Not available on-device" : "Translation failed",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      turn.current = null;
      setLiveTranslations([]);
      setBusySide(null);
    }
  }

  stopRef.current = stopAndTranslate;
  const onMic = (side: Side) => (recordingSide === side ? stopAndTranslate(side) : startRecording(side));

  async function onSendTyped() {
    const text = typed.trim();
    if (!text) return;
    if (!isKnown("B")) return waitForOther();
    setTyped("");
    setBusySide("A");
    try {
      const autoA = isAuto("A");
      const r = await translateText(engine, text, autoA ? null : langA, langB);
      const typedIn = markDetected("A", r.detectedLanguage, r.detectedLanguageCode);
      addEntry({
        id: `${Date.now()}`,
        side: "A",
        sourceCode: autoA ? (typedIn?.code ?? null) : langA.code,
        detected: r.detectedLanguage,
        targetCode: langB.code,
        transcript: text,
        translation: r.translation,
        at: Date.now(),
      });
      if (settings!.autoSpeak) await speak(r.translation, langB);
    } catch (e) {
      Alert.alert(
        e instanceof RateLimitError ? "Slow down" : e instanceof NeedsCloudError ? "Not available on-device" : "Translation failed",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setBusySide(null);
    }
  }

  const clearHistory = () =>
    Alert.alert("Clear conversation?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => (setHistory([]), saveHistory([])) },
    ]);

  const languagePicker = (
    <LanguagePicker
      visible={picker !== null}
      selected={picker === "A" ? langA.code : langB.code}
      onClose={() => setPicker(null)}
      onSelect={(l) => updateSettings(picker === "A" ? { langA: l.code, autoA: false } : { langB: l.code, autoB: false })}
      auto={picker !== null && isAuto(picker)}
      unavailable={engine === "device" ? (l) => !deviceSupported(l) : undefined}
      unavailableLabel="cloud only"
      onSelectAuto={engine === "device" ? undefined : () => {
        if (picker === null) return;
        // Both sides unknown = nothing to translate into. One side needs a known language.
        if (!isKnown(other(picker))) {
          Alert.alert("Pick one language", "Both sides can't be auto-detect before either has spoken. Choose a language for the other side first.");
          return;
        }
        updateSettings(picker === "A" ? { autoA: true, detectedA: false } : { autoB: true, detectedB: false });
      }}
      flipped={settings.faceToFace && picker === "B"}
    />
  );

  if (settings.faceToFace) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" hidden />
        <FaceToFace
          langA={langA}
          langB={langB}
          history={history}
          liveText={live.liveText}
          liveTranslations={liveTranslations}
          connected={live.connected}
          headphones={onHeadphones}
          autoA={isAuto("A")}
          autoB={isAuto("B")}
          knownA={isKnown("A")}
          knownB={isKnown("B")}
          recordingSide={recordingSide}
          busySide={busySide}
          onMic={onMic}
          onPickLanguage={setPicker}
          onReplay={(e) => {
            const t = byCode(e.targetCode);
            if (t) speak(e.translation, t).catch(() => {});
          }}
          onExit={() => updateSettings({ faceToFace: false })}
        />
        {languagePicker}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* Language bar */}
        <View style={styles.langBar}>
          <LangButton lang={langA} auto={settings.autoA} known={isKnown("A")} color={colors.accent} onPress={() => setPicker("A")} />
          <Pressable
            onPress={() =>
              updateSettings({
                langA: langB.code,
                langB: langA.code,
                autoA: settings.autoB,
                autoB: settings.autoA,
                detectedA: settings.detectedB,
                detectedB: settings.detectedA,
              })
            }
            style={styles.swap}
            accessibilityLabel="Swap languages"
          >
            <Text style={styles.swapText}>⇄</Text>
          </Pressable>
          <LangButton lang={langB} auto={settings.autoB} known={isKnown("B")} color={colors.accentB} onPress={() => setPicker("B")} />
        </View>

        <Pressable onPress={() => updateSettings({ faceToFace: true })} style={styles.f2fBtn}>
          <Text style={styles.f2fText}>👥  Face-to-face mode</Text>
        </Pressable>

        <EngineBar
          engine={engine}
          packs={packs}
          onChange={(e) => updateSettings({ engine: e })}
        />

        <View style={styles.toggles}>
          <Toggle label="Speak translation" value={settings.autoSpeak} onChange={(v) => updateSettings({ autoSpeak: v })} />
          {settings.autoSpeak && (
            <Toggle
              label="Speak each sentence while talking"
              value={settings.liveSpeak}
              onChange={(v) => updateSettings({ liveSpeak: v })}
            />
          )}
          {settings.autoSpeak && !settings.liveSpeak && (
            <Toggle
              label="…automatically with headphones 🎧"
              value={settings.liveSpeakWithHeadphones}
              onChange={(v) => updateSettings({ liveSpeakWithHeadphones: v })}
            />
          )}
          {!headphones.detectable && (
            <Toggle
              label="I'm wearing headphones"
              value={settings.manualHeadphones}
              onChange={(v) => updateSettings({ manualHeadphones: v })}
            />
          )}
          <HeadphoneStatus
            on={onHeadphones}
            name={headphones.route?.headphones ? headphones.route.name : null}
            liveSpeak={liveSpeakActive}
            auto={liveSpeakAuto}
            onEnableLiveSpeak={() => updateSettings({ autoSpeak: true, liveSpeak: true })}
          />
        </View>

        {/* Conversation */}
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          data={history}
          inverted
          keyExtractor={(e) => e.id}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Tap a microphone and speak.{"\n"}Your words are transcribed, translated and spoken aloud.
            </Text>
          }
          renderItem={({ item }) => <Bubble entry={item} />}
        />
        {history.length > 0 && (
          <Pressable onPress={clearHistory} style={styles.clear}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        )}

        {/* Live transcript while speaking */}
        {(recordingSide || (busySide && live.liveText)) && (
          <LiveCard
            text={live.liveText}
            listening={!!recordingSide}
            connected={live.connected}
            lang={recordingSide ? langsFor(recordingSide)[0] : langsFor(busySide!)[0]}
            auto={isAuto(recordingSide ?? busySide!)}
            known={isKnown(recordingSide ?? busySide!)}
            translations={liveTranslations}
            target={recordingSide ? langsFor(recordingSide)[1] : langsFor(busySide!)[1]}
            color={(recordingSide ?? busySide) === "A" ? colors.accent : colors.accentB}
          />
        )}

        {/* Typed input */}
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, langA.rtl && { textAlign: "right", writingDirection: "rtl" }]}
            placeholder={`Type in ${langA.name}…`}
            placeholderTextColor={colors.muted}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={onSendTyped}
            returnKeyType="send"
          />
          <Pressable onPress={onSendTyped} style={styles.send} disabled={!typed.trim()}>
            <Text style={styles.sendText}>➤</Text>
          </Pressable>
        </View>

        {/* Mic controls */}
        <View style={styles.mics}>
          <MicButton
            label={langA.native}
            color={colors.accent}
            recording={recordingSide === "A"}
            busy={busySide === "A"}
            disabled={recordingSide === "B" || busySide === "B"}
            onPress={() => onMic("A")}
          />
          <MicButton
            label={langB.native}
            color={colors.accentB}
            recording={recordingSide === "B"}
            busy={busySide === "B"}
            disabled={recordingSide === "A" || busySide === "A"}
            onPress={() => onMic("B")}
          />
        </View>
      </KeyboardAvoidingView>

      {languagePicker}
    </SafeAreaView>
  );
}

/** Engine choice (only when a server is configured) and on-device status. */
function EngineBar(props: { engine: Engine; packs: string; onChange: (e: Engine) => void }) {
  const { engine, packs, onChange } = props;
  const deviceReady = deviceEngineAvailable && deviceRecognitionAvailable;
  const status =
    engine === "cloud"
      ? "☁️ Best quality · 116 languages · auto-detect"
      : !deviceReady
        ? "⚠️ On-device mode needs a development build (not in Expo Go / web)"
        : packs === "downloading"
          ? "⬇️ Downloading offline language packs (~30 MB each)…"
          : packs === "error"
            ? "⚠️ Couldn't download language packs – check the connection"
            : packs === "ready"
              ? "📱 Free · offline-ready · ~60 languages"
              : "📱 Free · ~60 languages";
  return (
    <View style={styles.engineWrap}>
      {CLOUD_CONFIGURED && (
        <View style={styles.segment}>
          {(["device", "cloud"] as const).map((e) => (
            <Pressable
              key={e}
              onPress={() => onChange(e)}
              style={[styles.segmentBtn, engine === e && styles.segmentOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: engine === e }}
            >
              <Text style={[styles.segmentText, engine === e && styles.segmentTextOn]}>
                {e === "device" ? "📱 On-device · free" : "☁️ Cloud"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text style={styles.engineStatus}>{status}</Text>
    </View>
  );
}

function HeadphoneStatus(props: {
  on: boolean;
  name: string | null;
  liveSpeak: boolean;
  /** Live speaking is on only because headphones are connected. */
  auto: boolean;
  onEnableLiveSpeak: () => void;
}) {
  const { on, name, liveSpeak, auto, onEnableLiveSpeak } = props;
  if (!on) {
    return liveSpeak ? (
      <Text style={styles.hpHint}>🔈 Loudspeaker: the mic pauses while a translation is spoken (prevents echo).</Text>
    ) : null;
  }
  return (
    <View style={styles.hpRow}>
      <Text style={styles.hpText} numberOfLines={2}>
        🎧 {name || "Headphones"}
        {liveSpeak ? (auto ? " · speaking live (auto)" : " · mic stays on while translations play") : ""}
      </Text>
      {!liveSpeak && (
        <Pressable onPress={onEnableLiveSpeak} hitSlop={8}>
          <Text style={styles.hpAction}>Speak live</Text>
        </Pressable>
      )}
    </View>
  );
}

function LiveCard(props: {
  text: string;
  listening: boolean;
  connected: boolean;
  lang: Language;
  /** Speaker's side is in auto-detect mode; `known` = its language was already detected. */
  auto: boolean;
  known: boolean;
  translations: { id: string; text: string | null }[];
  target: Language;
  color: string;
}) {
  const { text, listening, connected, lang, auto, known, translations, target, color } = props;
  const detecting = auto && !known;
  const status = !listening ? "Translating…" : connected ? "Listening…" : "Connecting…";
  return (
    <View style={[styles.live, { borderColor: color }]}>
      <View style={styles.liveHeader}>
        <View style={[styles.liveDot, { backgroundColor: listening ? colors.danger : color }]} />
        <Text style={styles.liveStatus}>
          {status} · {detecting ? "🔍 detecting language" : auto ? `${lang.name} 🔍` : lang.name}
        </Text>
      </View>
      <Text
        style={[styles.liveText, !detecting && lang.rtl && { textAlign: "right", writingDirection: "rtl" }, !text && { color: colors.muted }]}
        numberOfLines={6}
      >
        {text || "Start speaking…"}
      </Text>
      {translations.length > 0 && (
        <View style={styles.liveTr}>
          <Text style={styles.liveTrLabel}>{target.name}</Text>
          <Text
            style={[styles.liveTrText, target.rtl && { textAlign: "right", writingDirection: "rtl" }]}
            numberOfLines={6}
          >
            {translations.map((t) => t.text ?? "…").join(" ")}
          </Text>
        </View>
      )}
    </View>
  );
}

function LangButton(props: { lang: Language; auto: boolean; known: boolean; color: string; onPress: () => void }) {
  const { lang, auto, known, color, onPress } = props;
  return (
    <Pressable onPress={onPress} style={[styles.langBtn, { borderColor: color }]}>
      <Text style={styles.langName} numberOfLines={1}>
        {auto && !known ? "🔍 Auto-detect" : lang.native}
      </Text>
      <Text style={styles.langSub} numberOfLines={1}>
        {!auto ? lang.name : known ? `${lang.name} · detected` : "Speak to detect"} ▾
      </Text>
    </Pressable>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function Bubble({ entry }: { entry: Entry }) {
  const target = byCode(entry.targetCode);
  const source = entry.sourceCode ? byCode(entry.sourceCode) : undefined;
  const isA = entry.side === "A";
  const rtl = (l?: Language) => (l?.rtl ? ({ textAlign: "right", writingDirection: "rtl" } as const) : null);
  return (
    <View style={[styles.bubble, isA ? styles.bubbleA : styles.bubbleB]}>
      <Text style={styles.meta}>
        {source?.name ?? `${entry.detected ?? "Detected"} (auto)`} → {target?.name}
      </Text>
      <Text style={[styles.transcript, rtl(source)]} selectable>{entry.transcript}</Text>
      <Text style={[styles.translation, rtl(target)]} selectable>{entry.translation}</Text>
      {target && (
        <Pressable onPress={() => speak(entry.translation, target).catch(() => {})} hitSlop={10} style={styles.replay}>
          <Text style={styles.replayText}>🔊 Play</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, },
  langBar: { flexDirection: "row", alignItems: "center", padding: 12, gap: 8 },
  langBtn: { flex: 1, backgroundColor: colors.card, borderRadius: 14, borderWidth: 2, padding: 10 },
  langName: { color: colors.text, fontSize: 17, fontWeight: "700" },
  langSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  swap: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.cardAlt, alignItems: "center", justifyContent: "center" },
  swapText: { color: colors.text, fontSize: 22 },
  f2fBtn: { marginHorizontal: 12, marginBottom: 8, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.cardAlt, alignItems: "center" },
  f2fText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  engineWrap: { marginHorizontal: 12, marginBottom: 6, gap: 4 },
  segment: { flexDirection: "row", backgroundColor: colors.card, borderRadius: 10, padding: 3 },
  segmentBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
  segmentOn: { backgroundColor: colors.cardAlt },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  segmentTextOn: { color: colors.text },
  engineStatus: { color: colors.muted, fontSize: 12, paddingHorizontal: 4 },
  hpRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 4 },
  hpText: { color: colors.accentB, fontSize: 13, flex: 1 },
  hpAction: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  hpHint: { color: colors.muted, fontSize: 12, paddingVertical: 4 },
  toggles: { paddingHorizontal: 16, gap: 4 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleLabel: { color: colors.muted, fontSize: 14 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40, lineHeight: 22, transform: [{ scaleY: -1 }] },
  bubble: { borderRadius: 16, padding: 12, maxWidth: "88%" },
  bubbleA: { backgroundColor: colors.card, alignSelf: "flex-start", borderLeftWidth: 3, borderLeftColor: colors.accent },
  bubbleB: { backgroundColor: colors.cardAlt, alignSelf: "flex-end", borderRightWidth: 3, borderRightColor: colors.accentB },
  meta: { color: colors.muted, fontSize: 11, marginBottom: 4 },
  transcript: { color: colors.muted, fontSize: 14, marginBottom: 6 },
  translation: { color: colors.text, fontSize: 18, fontWeight: "500" },
  replay: { marginTop: 8, alignSelf: "flex-start" },
  replayText: { color: colors.accent, fontSize: 13 },
  clear: { alignSelf: "center", paddingVertical: 4 },
  clearText: { color: colors.muted, fontSize: 12 },
  inputRow: { flexDirection: "row", paddingHorizontal: 12, gap: 8, alignItems: "center" },
  input: { flex: 1, backgroundColor: colors.card, color: colors.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#fff", fontSize: 18 },
  live: { marginHorizontal: 12, marginBottom: 8, padding: 12, borderRadius: 14, borderWidth: 1.5, backgroundColor: colors.card },
  liveHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveStatus: { color: colors.muted, fontSize: 12 },
  liveText: { color: colors.muted, fontSize: 16, lineHeight: 23 },
  liveTr: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted },
  liveTrLabel: { color: colors.muted, fontSize: 11, marginBottom: 2 },
  liveTrText: { color: colors.text, fontSize: 19, lineHeight: 27, fontWeight: "500" },
  mics: { flexDirection: "row", paddingVertical: 16, paddingHorizontal: 24 },
});
