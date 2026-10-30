/** Éléments d'interface communs. */

import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "../lib/theme";

export function Screen({ title, headerRight, children, scroll = true }: {
  title?: string; headerRight?: () => ReactNode; children: ReactNode; scroll?: boolean;
}) {
  const c = useColors();
  const body = scroll
    ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={[styles.content, { flex: 1 }]}>{children}</View>;
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      {title !== undefined && <Stack.Screen options={{ title, headerRight }} />}
      {body}
    </SafeAreaView>
  );
}

/** Bouton icône de la barre de titre (par exemple la roue crantée des paramètres). */
export function HeaderIcon({ name, label, onPress }: { name: ComponentProps<typeof Ionicons>["name"]; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={12}
      style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}>
      <Ionicons name={name} size={26} color={c.text} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, style]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={[styles.h1, { color: useColors().text }]}>{children}</Text>;
}

export function H2({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h2, { color: useColors().text }, style]}>{children}</Text>;
}

export function Body({ children, style, onPress }: { children: ReactNode; style?: StyleProp<TextStyle>; onPress?: () => void }) {
  const c = useColors();
  return (
    <Text onPress={onPress} accessibilityRole={onPress ? "link" : undefined}
      style={[styles.body, { color: c.text }, onPress ? { textDecorationLine: "underline", textDecorationColor: c.border } : null, style]}>
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, { color: useColors().muted }, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={[styles.body, { color: useColors().danger }]}>{children}</Text>;
}

export function Button({ title, onPress, kind = "primary", disabled, busy, style }: {
  title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const background = kind === "primary" ? c.primary : kind === "danger" ? c.danger : c.chip;
  const color = kind === "secondary" ? c.text : c.primaryText;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? c.chipActive : c.chip }]}>
      <Text style={{ color: active ? c.chipActiveText : c.text, fontSize: 15, fontWeight: active ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Loading({ label }: { label?: string }) {
  const c = useColors();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={c.primary} size="large" />
      {label ? <Muted style={{ marginTop: 12 }}>{label}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  h1: { fontSize: 26, fontWeight: "700" },
  h2: { fontSize: 19, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 14, lineHeight: 20 },
  button: { minHeight: 50, borderRadius: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});
