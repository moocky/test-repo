import { Pressable, StyleSheet, Text, View } from "react-native";
import { useKeepAwake } from "expo-keep-awake";
import { byCode, type Language } from "../languages";
import type { Entry } from "../storage";
import { colors } from "../theme";
import { MicButton } from "./MicButton";

type Side = "A" | "B";

type Props = {
  langA: Language;
  langB: Language;
  history: Entry[]; // newest first
  liveText: string;
  liveTranslations: { id: string; text: string | null }[];
  connected: boolean;
  headphones: boolean;
  recordingSide: Side | null;
  busySide: Side | null;
  onMic: (side: Side) => void;
  onPickLanguage: (side: Side) => void;
  onReplay: (entry: Entry) => void;
  onExit: () => void;
};

/**
 * Phone lies flat between two people. Bottom half faces person A, top half is rotated 180°
 * and faces person B. Each half shows, in its own language, what the other person said.
 */
export function FaceToFace(props: Props) {
  useKeepAwake(); // the screen must not dim mid-conversation
  const { langA, langB, onExit } = props;
  return (
    <View style={styles.root}>
      <Half {...props} side="B" me={langB} other={langA} color={colors.accentB} flipped />
      <View style={styles.divider}>
        <Text style={styles.dividerText} numberOfLines={1}>
          {props.headphones ? "🎧  " : ""}{langA.native} ⇄ {langB.native}
        </Text>
        <Pressable onPress={onExit} style={styles.exit} hitSlop={10} accessibilityLabel="Exit face-to-face mode">
          <Text style={styles.exitText}>✕</Text>
        </Pressable>
      </View>
      <Half {...props} side="A" me={langA} other={langB} color={colors.accent} />
    </View>
  );
}

function Half(
  props: Props & { side: Side; me: Language; other: Language; color: string; flipped?: boolean },
) {
  const { side, me, other, color, flipped, history, recordingSide, busySide } = props;
  const otherSide: Side = side === "A" ? "B" : "A";
  // Text is centred in this mode; only the writing direction changes for RTL scripts.
  const rtl = (l?: Language) => (l?.rtl ? ({ writingDirection: "rtl" } as const) : null);

  const iSpeak = recordingSide === side || busySide === side;
  const theySpeak = recordingSide === otherSide || busySide === otherSide;
  const lastFromThem = history.find((e) => e.side === otherSide);
  const lastFromMe = history.find((e) => e.side === side);

  let main: React.ReactNode;
  if (theySpeak) {
    // Other person is talking: show their words, translated into my language, as they come in.
    const text = props.liveTranslations.map((t) => t.text ?? "…").join(" ");
    main = (
      <>
        <Text style={styles.status}>
          {recordingSide === otherSide ? `${other.native} …` : "…"}
        </Text>
        <Text style={[styles.big, rtl(me), !text && styles.placeholder]} numberOfLines={7} adjustsFontSizeToFit>
          {text || "• • •"}
        </Text>
      </>
    );
  } else if (iSpeak) {
    // I'm talking: show what the app hears, so I can check it.
    main = (
      <>
        <Text style={styles.status}>{recordingSide === side ? (props.connected ? "🎙" : "…") : "⟳"}</Text>
        <Text style={[styles.mine, rtl(me), !props.liveText && styles.placeholder]} numberOfLines={7}>
          {props.liveText || "…"}
        </Text>
      </>
    );
  } else if (lastFromThem) {
    main = (
      <Pressable onPress={() => props.onReplay(lastFromThem)} style={{ alignSelf: "stretch" }}>
        <Text style={[styles.big, rtl(me)]} numberOfLines={7} adjustsFontSizeToFit>
          {lastFromThem.translation}
        </Text>
        <Text style={[styles.original, rtl(byCode(lastFromThem.sourceCode ?? "") ?? undefined)]} numberOfLines={2}>
          {lastFromThem.transcript}  🔊
        </Text>
      </Pressable>
    );
  } else {
    main = <Text style={[styles.hint, rtl(me)]}>{me.native} · 🎤</Text>;
  }

  return (
    <View style={[styles.half, flipped && styles.flipped, { borderColor: color }]}>
      <Pressable onPress={() => props.onPickLanguage(side)} style={[styles.langChip, { borderColor: color }]}>
        <Text style={styles.langChipText}>{me.native} ▾</Text>
      </Pressable>

      <View style={styles.content}>{main}</View>

      {lastFromMe && !iSpeak && !theySpeak && (
        <Text style={[styles.echo, rtl(me)]} numberOfLines={1}>
          ↳ {lastFromMe.transcript}
        </Text>
      )}

      <View style={styles.micRow}>
        <MicButton
          label={me.native}
          color={color}
          recording={recordingSide === side}
          busy={busySide === side}
          disabled={theySpeak}
          onPress={() => props.onMic(side)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  half: { flex: 1, padding: 16, borderTopWidth: 0, borderBottomWidth: 3 },
  flipped: { transform: [{ rotate: "180deg" }] },
  langChip: { alignSelf: "center", borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  langChipText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  content: { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 8 },
  status: { color: colors.muted, fontSize: 14, marginBottom: 6, alignSelf: "center" },
  big: { color: colors.text, fontSize: 30, lineHeight: 40, fontWeight: "600", textAlign: "center", alignSelf: "stretch" },
  mine: { color: colors.muted, fontSize: 22, lineHeight: 30, textAlign: "center", alignSelf: "stretch" },
  original: { color: colors.muted, fontSize: 14, marginTop: 10, textAlign: "center" },
  placeholder: { color: colors.muted },
  hint: { color: colors.muted, fontSize: 22 },
  echo: { color: colors.muted, fontSize: 12, textAlign: "center", marginBottom: 4 },
  micRow: { flexDirection: "row", justifyContent: "center" },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    backgroundColor: colors.card,
  },
  dividerText: { color: colors.muted, fontSize: 12, flex: 1, textAlign: "center", marginLeft: 36 },
  exit: { width: 36, alignItems: "center" },
  exitText: { color: colors.text, fontSize: 18 },
});
