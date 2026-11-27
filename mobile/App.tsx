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
import { LANGUAGES, byCode, type Language } from "./src/languages";
import { LanguagePicker } from "./src/components/LanguagePicker";
import { MicButton } from "./src/components/MicButton";
import { FaceToFace } from "./src/components/FaceToFace";
import { speechTranslate, textTranslate } from "./src/api";
import { enqueueSpeech, hasDeviceVoice, onSpeakingChange, speak, stopSpeaking } from "./src/speech";
import { loadHistory, loadSettings, saveHistory, saveSettings, type Entry, type Settings } from "./src/storage";
import { colors } from "./src/theme";
import { useLiveTranscription, type Segment } from "./src/useLiveTranscription";

type Side = "A" | "B";
type SegTranslation = { translation: string; detectedLanguage: string | null };
type Turn = { source: Language | null; target: Language; speakLive: boolean };

export default function App() {
  return (
    <SafeAreaProvider>
      <Translator />
    </SafeAreaProvider>
  );
}

function Translator() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autoDetect, setAutoDetect] = useState(false);
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
    const promise = textTranslate(seg.text.trim(), t.source, t.target, context).then((r) => ({
      translation: r.translation,
      detectedLanguage: r.detectedLanguage ?? null,
    }));
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

  const live = useLiveTranscription({ onFinal: translateSegment });

  // Half-duplex echo guard: don't feed the phone's own voice back into the recogniser.
  useEffect(() => onSpeakingChange((speaking) => live.setMuted(speaking)), [live.setMuted]);

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

  async function startRecording(side: Side) {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Microphone needed", "Allow microphone access in Settings to translate speech.");
      return;
    }
    await stopSpeaking();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const [source, target] = langsFor(side);
    segPromises.current = new Map();
    speakChain.current = Promise.resolve();
    setLiveTranslations([]);
    turn.current = { source: autoDetect ? null : source, target, speakLive: settings!.autoSpeak && settings!.liveSpeak };
    try {
      await live.start(autoDetect ? null : source.stt);
    } catch (e) {
      live.cancel();
      Alert.alert("Microphone error", e instanceof Error ? e.message : String(e));
      return;
    }
    startedAt.current = Date.now();
    setRecordingSide(side);
  }

  async function stopAndTranslate(side: Side) {
    setRecordingSide(null);
    const tooShort = Date.now() - startedAt.current < 500;
    setBusySide(side);
    const [source, target] = langsFor(side);
    try {
      const heard = await live.stop();
      // Route playback back to the loudspeaker on iOS.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (tooShort) return;

      let r: { transcript: string; translation: string; detectedLanguage: string | null; audioBase64?: string };
      const src = autoDetect ? null : source;
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
        };
        spokenLive = !!turn.current?.speakLive;
      } else if (heard.liveFailed && heard.fileUri) {
        // Live stream dropped: send the recorded file through the batch pipeline.
        const needServerVoice = settings!.autoSpeak && !(await hasDeviceVoice(target));
        r = await speechTranslate(heard.fileUri, src, target, needServerVoice);
      } else {
        r = { transcript: "", translation: "", detectedLanguage: null };
      }
      if (!r.transcript) {
        Alert.alert("Didn't catch that", "No speech was recognised. Try again a little closer to the mic.");
        return;
      }
      addEntry({
        id: `${Date.now()}`,
        side,
        sourceCode: autoDetect ? null : source.code,
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
      Alert.alert("Translation failed", e instanceof Error ? e.message : String(e));
    } finally {
      turn.current = null;
      setLiveTranslations([]);
      setBusySide(null);
    }
  }

  const onMic = (side: Side) => (recordingSide === side ? stopAndTranslate(side) : startRecording(side));

  async function onSendTyped() {
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    setBusySide("A");
    try {
      const r = await textTranslate(text, autoDetect ? null : langA, langB);
      addEntry({
        id: `${Date.now()}`,
        side: "A",
        sourceCode: autoDetect ? null : langA.code,
        detected: r.detectedLanguage,
        targetCode: langB.code,
        transcript: text,
        translation: r.translation,
        at: Date.now(),
      });
      if (settings!.autoSpeak) await speak(r.translation, langB);
    } catch (e) {
      Alert.alert("Translation failed", e instanceof Error ? e.message : String(e));
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
      onSelect={(l) => updateSettings(picker === "A" ? { langA: l.code } : { langB: l.code })}
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
          <LangButton lang={langA} color={colors.accent} onPress={() => setPicker("A")} />
          <Pressable
            onPress={() => updateSettings({ langA: langB.code, langB: langA.code })}
            style={styles.swap}
            accessibilityLabel="Swap languages"
          >
            <Text style={styles.swapText}>⇄</Text>
          </Pressable>
          <LangButton lang={langB} color={colors.accentB} onPress={() => setPicker("B")} />
        </View>

        <Pressable onPress={() => updateSettings({ faceToFace: true })} style={styles.f2fBtn}>
          <Text style={styles.f2fText}>👥  Face-to-face mode</Text>
        </Pressable>

        <View style={styles.toggles}>
          <Toggle label="Auto-detect spoken language" value={autoDetect} onChange={setAutoDetect} />
          <Toggle label="Speak translation" value={settings.autoSpeak} onChange={(v) => updateSettings({ autoSpeak: v })} />
          {settings.autoSpeak && (
            <Toggle
              label="Speak each sentence while talking"
              value={settings.liveSpeak}
              onChange={(v) => updateSettings({ liveSpeak: v })}
            />
          )}
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
            autoDetect={autoDetect}
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

function LiveCard(props: {
  text: string;
  listening: boolean;
  connected: boolean;
  lang: Language;
  autoDetect: boolean;
  translations: { id: string; text: string | null }[];
  target: Language;
  color: string;
}) {
  const { text, listening, connected, lang, autoDetect, translations, target, color } = props;
  const status = !listening ? "Translating…" : connected ? "Listening…" : "Connecting…";
  return (
    <View style={[styles.live, { borderColor: color }]}>
      <View style={styles.liveHeader}>
        <View style={[styles.liveDot, { backgroundColor: listening ? colors.danger : color }]} />
        <Text style={styles.liveStatus}>
          {status} · {autoDetect ? "auto-detect" : lang.name}
        </Text>
      </View>
      <Text
        style={[styles.liveText, !autoDetect && lang.rtl && { textAlign: "right", writingDirection: "rtl" }, !text && { color: colors.muted }]}
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

function LangButton({ lang, color, onPress }: { lang: Language; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.langBtn, { borderColor: color }]}>
      <Text style={styles.langName} numberOfLines={1}>{lang.native}</Text>
      <Text style={styles.langSub} numberOfLines={1}>{lang.name} ▾</Text>
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
