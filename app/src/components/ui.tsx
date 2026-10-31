/** Éléments d'interface communs, au style MenuMalin (maquettes Claude Design). */

import { LinearGradient } from "expo-linear-gradient";
import { Stack, usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { CARD_SHADOW, PRIMARY_GRADIENT, PRIMARY_GRADIENT_STOPS, useColors } from "../lib/theme";
import { Icon, type IconName } from "./icons";

export type NavTab = "accueil" | "courses" | "budget" | "profil";

/**
 * Écran : fond crème, contenu défilant ; `title` règle la bande verte du haut ; `nav` affiche la barre du bas
 * (Accueil, Courses, Budget, Profil) ; `footer` s'affiche juste au-dessus (minuteurs, bouton fixe).
 */
export function Screen({ title, headerRight, children, footer, nav, scroll = true, padded = true }: {
  title?: string; headerRight?: () => ReactNode; children: ReactNode; footer?: ReactNode; nav?: NavTab; scroll?: boolean; padded?: boolean;
}) {
  const c = useColors();
  const content = [padded ? styles.content : styles.bare];
  const body = scroll
    ? <ScrollView contentContainerStyle={content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={[content, { flex: 1 }]}>{children}</View>;
  return (
    <SafeAreaView edges={nav ? ["left", "right"] : ["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      {title !== undefined && <Stack.Screen options={{ title, headerRight }} />}
      {body}
      {footer}
      {nav && <BottomNav active={nav} />}
    </SafeAreaView>
  );
}

const TABS: Array<{ tab: NavTab; label: string; path: "/" | "/courses" | "/budget" | "/parametres"; icon: IconName; active: IconName }> = [
  { tab: "accueil", label: "Accueil", path: "/", icon: "home", active: "homeFilled" },
  { tab: "courses", label: "Courses", path: "/courses", icon: "cart", active: "cartFilled" },
  { tab: "budget", label: "Budget", path: "/budget", icon: "budget", active: "budgetFilled" },
  { tab: "profil", label: "Profil", path: "/parametres", icon: "profile", active: "profileFilled" },
];

/** Barre de navigation du bas : onglet actif en vert. */
export function BottomNav({ active }: { active: NavTab }) {
  const c = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={[styles.nav, { backgroundColor: c.nav, borderTopColor: c.navLine, paddingBottom: insets.bottom }]}>
      {TABS.map((t) => {
        const on = t.tab === active;
        const color = on ? c.navActive : c.text;
        return (
          <Pressable key={t.tab} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.label}
            onPress={() => {
              if (pathname === t.path) return;
              if (t.path === "/") router.dismissTo("/");
              else router.navigate(t.path);
            }}
            style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.6 : 1 }]}>
            <Icon name={on ? t.active : t.icon} size={24} color={color} />
            <Text style={[styles.tabLabel, { color, fontWeight: on ? "700" : "400" }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Bouton icône de la bande verte (retour, partager, favoris…). */
export function HeaderIcon({ name, label, onPress, color = "#FFFFFF", size = 24 }: { name: IconName; label: string; onPress: () => void; color?: string; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
      <Icon name={name} size={size} color={color} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW, style]}>{children}</View>;
}

/** Titre de plat ou d'écran (26,5). */
export function H1({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h1, { color: useColors().text }, style]}>{children}</Text>;
}

/** Titre de section ou de carte (16, gras). */
export function H2({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h2, { color: useColors().text }, style]}>{children}</Text>;
}

/** En-tête de section : icône, titre, action éventuelle à droite (« Recettes › »). */
export function SectionTitle({ icon, title, action, onAction }: { icon: IconName; title: string; action?: string; onAction?: () => void }) {
  const c = useColors();
  return (
    <View style={styles.section}>
      <Icon name={icon} size={21} color={c.text} />
      <Text style={[styles.h2, { color: c.text, flex: 1 }]} accessibilityRole="header">{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="link" hitSlop={8} style={({ pressed }) => [styles.sectionAction, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={{ color: c.primary, fontSize: 14, fontWeight: "500" }}>{action}</Text>
          <Icon name="chevronRight" width={9} height={14} color={c.primary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Body({ children, style, onPress, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; onPress?: () => void; numberOfLines?: number }) {
  const c = useColors();
  return (
    <Text onPress={onPress} accessibilityRole={onPress ? "link" : undefined} numberOfLines={numberOfLines}
      style={[styles.body, { color: c.text }, onPress ? { textDecorationLine: "underline", textDecorationColor: c.border } : null, style]}>
      {children}
    </Text>
  );
}

export function Muted({ children, style, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return <Text numberOfLines={numberOfLines} style={[styles.muted, { color: useColors().muted }, style]}>{children}</Text>;
}

/** Message d'erreur : pastille rose avec icône. */
export function ErrorText({ children }: { children: ReactNode }) {
  const c = useColors();
  if (!children) return null;
  return (
    <View accessibilityRole="alert" style={[styles.alert, { backgroundColor: c.dangerSoft }]}>
      <Icon name="alert" size={24} color={c.danger} />
      <Text style={[styles.body, { color: c.danger, flex: 1 }]}>{children}</Text>
    </View>
  );
}

/** Lien souligné discret (« Annuler ce menu », « Passer ce repas »). */
export function TextLink({ title, onPress, color, disabled }: { title: string; onPress: () => void; color?: string; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" hitSlop={6}
      style={({ pressed }) => ({ minHeight: 40, justifyContent: "center", opacity: pressed || disabled ? 0.6 : 1 })}>
      <Text style={{ color: color ?? c.muted, fontSize: 14.2, textDecorationLine: "underline" }}>{title}</Text>
    </Pressable>
  );
}

export function Button({ title, onPress, kind = "primary", disabled, busy, style, icon }: {
  title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; icon?: IconName;
}) {
  const c = useColors();
  const color = kind === "primary" ? c.primaryText : kind === "danger" ? c.danger : c.text;
  const inner = busy ? <ActivityIndicator color={color} /> : (
    <View style={styles.buttonInner}>
      {icon ? <Icon name={icon} size={22} color={color} /> : null}
      <Text style={[styles.buttonText, { color, fontSize: kind === "primary" ? 16.4 : 16 }]}>{title}</Text>
    </View>
  );
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, busy }} onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => [styles.button, kind === "primary" ? styles.primaryShadow : {
        backgroundColor: kind === "danger" ? c.dangerSoft : c.card, borderWidth: 1.5, borderColor: kind === "danger" ? c.dangerSoft : c.border,
      }, { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}>
      {kind === "primary" ? (
        <LinearGradient colors={PRIMARY_GRADIENT} locations={PRIMARY_GRADIENT_STOPS} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.gradient}>
          {inner}
        </LinearGradient>
      ) : inner}
    </Pressable>
  );
}

/** Puce à toucher (repas à cocher, avis, filtres) : beige au repos, vert doux bordé de vert quand elle est choisie. */
export function Chip({ label, active, onPress, icon, style }: { label: string; active?: boolean; onPress?: () => void; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: active ? c.chipActive : c.chip, borderColor: active ? c.primary : "transparent", opacity: pressed ? 0.8 : 1 }, style]}>
      {icon ? <Icon name={icon} size={22} color={c.text} /> : null}
      <Text style={{ color: c.text, fontSize: 15.5, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

/** Puce d'information (temps, protéine, nombre de personnes). */
export function Pill({ icon, children, style }: { icon?: IconName; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.pill, { backgroundColor: c.chip }, style]}>
      {icon ? <Icon name={icon} size={22} color={c.text} /> : null}
      <Text style={{ color: c.text, fontSize: 16, fontWeight: "500" }}>{children}</Text>
    </View>
  );
}

/** Étiquette (« avec vos courses », « 2 à acheter », « idée Mistral »). */
export function Tag({ label, tone = "green", icon }: { label: string; tone?: "green" | "orange" | "plain"; icon?: IconName }) {
  const c = useColors();
  const background = tone === "green" ? c.greenSoft : c.chip;
  const color = tone === "green" ? c.greenInk : tone === "orange" ? c.orangeInk : c.text;
  return (
    <View style={[styles.tag, { backgroundColor: background }]}>
      {icon ? <Icon name={icon} size={16} color={color} /> : null}
      <Text style={{ color, fontSize: 15, fontWeight: "500" }}>{label}</Text>
    </View>
  );
}

/** Champ de saisie : contour taupe, coins de 13. */
export function Field({ style, multiline, ...props }: TextInputProps) {
  const c = useColors();
  return (
    <TextInput placeholderTextColor={c.muted} multiline={multiline} {...props}
      style={[styles.field, { borderColor: c.field, color: c.text, backgroundColor: c.card }, multiline && { minHeight: 76, paddingTop: 12, textAlignVertical: "top" }, style]} />
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Loading({ label }: { label?: string }) {
  const c = useColors();
  return (
    <View style={[styles.loading, { backgroundColor: c.background }]}>
      <ActivityIndicator color={c.primary} size="large" />
      {label ? <Muted style={{ marginTop: 12 }}>{label}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 20, gap: 12 },
  bare: { paddingBottom: 20 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  h1: { fontSize: 26.5, lineHeight: 30, fontWeight: "700" },
  h2: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
  section: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 40, paddingHorizontal: 1 },
  sectionAction: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  body: { fontSize: 16, lineHeight: 21.6 },
  muted: { fontSize: 14.2, lineHeight: 18 },
  alert: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 13, alignItems: "flex-start" },
  button: { minHeight: 48, borderRadius: 24, overflow: "hidden", justifyContent: "center" },
  primaryShadow: { shadowColor: "#3C501E", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  gradient: { minHeight: 48, justifyContent: "center", paddingHorizontal: 18 },
  buttonInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 12 },
  buttonText: { fontWeight: "600" },
  chip: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: 13, borderWidth: 1.5, paddingHorizontal: 12 },
  pill: { height: 38, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 13, paddingHorizontal: 11 },
  tag: { height: 28, flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 14, paddingHorizontal: 10, alignSelf: "flex-start" },
  field: { minHeight: 52, borderRadius: 13, borderWidth: 1.5, paddingHorizontal: 14, fontSize: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  nav: { flexDirection: "row", justifyContent: "space-around", borderTopWidth: 1, paddingTop: 3 },
  tab: { width: 72, height: 50, alignItems: "center", justifyContent: "center", gap: 2 },
  tabLabel: { fontSize: 11, lineHeight: 14 },
});
