import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LANGUAGES, type Language } from "../languages";
import { colors } from "../theme";

type Props = {
  visible: boolean;
  selected: string;
  onSelect: (lang: Language) => void;
  onClose: () => void;
  /** Rotate 180° so the person sitting opposite can read it (face-to-face mode). */
  flipped?: boolean;
  /** Show an "Auto-detect" choice at the top; `auto` marks it as the current selection. */
  auto?: boolean;
  onSelectAuto?: () => void;
  /** Languages the current engine can't handle: shown greyed out with this badge, not selectable. */
  unavailable?: (l: Language) => boolean;
  unavailableLabel?: string;
};

export function LanguagePicker(props: Props) {
  const { visible, selected, onSelect, onClose, flipped, auto, onSelectAuto, unavailable, unavailableLabel } = props;
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? LANGUAGES.filter(
          (l) => l.name.toLowerCase().includes(q) || l.native.toLowerCase().includes(q) || l.code.toLowerCase().startsWith(q),
        )
      : LANGUAGES;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [query]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={[styles.container, flipped && { transform: [{ rotate: "180deg" }] }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose language · {LANGUAGES.length}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>
        <TextInput
          style={styles.search}
          placeholder="Search…  חיפוש…  Buscar…"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
        />
        <FlatList
          data={items}
          keyExtractor={(l) => l.code}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            onSelectAuto && !query ? (
              <Pressable
                style={[styles.row, auto && styles.rowSelected]}
                onPress={() => {
                  onSelectAuto();
                  onClose();
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>🔍 Auto-detect</Text>
                  <Text style={styles.native}>Identified from speech, any of the {LANGUAGES.length} languages</Text>
                </View>
              </Pressable>
            ) : undefined
          }
          renderItem={({ item }) => {
            const off = unavailable?.(item) ?? false;
            return (
            <Pressable
              disabled={off}
              style={[styles.row, !auto && item.code === selected && styles.rowSelected, off && styles.rowOff]}
              onPress={() => {
                onSelect(item);
                setQuery("");
                onClose();
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.native}>{item.native}</Text>
              </View>
              {off ? (
                <Text style={styles.badgeOff}>{unavailableLabel ?? "unavailable"}</Text>
              ) : (
                !item.stt && !unavailable && <Text style={styles.badge}>speech beta</Text>
              )}
            </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  close: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  search: {
    margin: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 16,
  },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16 },
  rowSelected: { backgroundColor: colors.card },
  rowOff: { opacity: 0.4 },
  badgeOff: { color: colors.muted, fontSize: 11, borderColor: colors.muted, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  name: { color: colors.text, fontSize: 16 },
  native: { color: colors.muted, fontSize: 14, marginTop: 2 },
  badge: { color: colors.warn, fontSize: 11, borderColor: colors.warn, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
});
