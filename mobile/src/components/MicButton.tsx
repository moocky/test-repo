import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

type Props = {
  label: string;
  color: string;
  recording: boolean;
  busy: boolean;
  disabled?: boolean;
  onPress: () => void;
};

export function MicButton({ label, color, recording, busy, disabled, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.wrap, { opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={recording ? `Stop recording ${label}` : `Speak ${label}`}
    >
      <View style={[styles.circle, { backgroundColor: recording ? colors.danger : color }]}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.icon}>{recording ? "■" : "🎤"}</Text>
        )}
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {recording ? "Tap to stop" : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", flex: 1 },
  circle: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 30, color: "#fff" },
  label: { color: colors.text, marginTop: 8, fontSize: 14, fontWeight: "600", maxWidth: 150 },
});
