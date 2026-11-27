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
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { LANGUAGES, byCode, type Language } from "./src/languages";
import { LanguagePicker } from "./src/components/LanguagePicker";
import { MicButton } from "./src/components/MicButton";
import { speechTranslate, textTranslate } from "./src/api";
import { hasDeviceVoice, speak, stopSpeaking } from "./src/speech";
import { loadHistory, loadSettings, saveHistory, saveSettings, type Entry, type Settings } from "./src/storage";
import { colors } from "./src/theme";

type Side = "A" | "B";

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

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

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
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAt.current = Date.now();
    setRecordingSide(side);
  }

  async function stopAndTranslate(side: Side) {
    setRecordingSide(null);
    await recorder.stop();
    // Route playback back to the loudspeaker on iOS.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (!uri || Date.now() - startedAt.current < 500) return;

    const [source, target] = langsFor(side);
    setBusySide(side);
    try {
      const needServerVoice = settings!.autoSpeak && !(await hasDeviceVoice(target));
      const r = await speechTranslate(uri, autoDetect ? null : source, target, needServerVoice);
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
      if (settings!.autoSpeak) await speak(r.translation, target, r.audioBase64);
    } catch (e) {
      Alert.alert("Translation failed", e instanceof Error ? e.message : String(e));
    } finally {
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

        <View style={styles.toggles}>
          <Toggle label="Auto-detect spoken language" value={autoDetect} onChange={setAutoDetect} />
          <Toggle label="Speak translation" value={settings.autoSpeak} onChange={(v) => updateSettings({ autoSpeak: v })} />
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

      <LanguagePicker
        visible={picker !== null}
        selected={picker === "A" ? langA.code : langB.code}
        onClose={() => setPicker(null)}
        onSelect={(l) => updateSettings(picker === "A" ? { langA: l.code } : { langB: l.code })}
      />
    </SafeAreaView>
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
  mics: { flexDirection: "row", paddingVertical: 16, paddingHorizontal: 24 },
});
