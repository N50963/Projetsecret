/**
 * Fenêtre de rappel de l'accueil (cloche) : panneau qui monte du bas de l'écran, au style MenuMalin. Menus du jour (ou
 * prochain menu), minuteurs en cours, liste de courses ; chaque ligne mène à l'écran concerné.
 */

import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { dayLabel, mealLabel, minutes } from "../lib/format";
import { pictureOf } from "../lib/images";
import { clock } from "../lib/steps";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { stopTimer, useTimers } from "../lib/timers";
import type { WeekSlot } from "../modules/planning";
import { Icon, type IconName } from "./icons";

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.sectionHead}>
        <Icon name={icon} size={20} color={c.text} />
        <Text style={[styles.sectionTitle, { color: c.text }]} accessibilityRole="header">{title}</Text>
      </View>
      {children}
    </View>
  );
}

export function ReminderSheet({ visible, onClose, today, menus, toBuy, onOpenRecipe, onOpenShopping }: {
  visible: boolean; onClose: () => void; today: string; menus: WeekSlot[]; toBuy: number;
  onOpenRecipe: (recipeId: string) => void; onOpenShopping: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { timers, now } = useTimers();
  const todays = menus.filter((s) => s.date === today);
  const next = todays.length ? null : menus[0] ?? null;
  const shown = todays.length ? todays : next ? [next] : [];

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Fermer les rappels" />
      <View style={[styles.sheet, { backgroundColor: c.background, paddingBottom: 16 + insets.bottom }]}>
        <View style={[styles.handle, { backgroundColor: c.border }]} />
        <View style={styles.head}>
          <View style={[styles.bell, { backgroundColor: c.greenSoft }]}><Icon name="bell" width={22} height={23} color={c.greenInk} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: c.text }]}>Aujourd'hui</Text>
            <Text style={{ color: c.muted, fontSize: 14.2 }}>{dayLabel(today)}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Fermer" style={styles.close}>
            <Icon name="close" size={24} color={c.text} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ gap: 18, paddingBottom: 4 }} showsVerticalScrollIndicator={false}>
          <Section icon="cutlery" title={todays.length ? "Au menu" : "Prochain menu"}>
            {shown.length === 0 && <Text style={[styles.empty, { color: c.muted }]}>Aucun menu choisi pour la semaine.</Text>}
            {!todays.length && next && <Text style={[styles.empty, { color: c.muted }]}>Rien de prévu aujourd'hui.</Text>}
            {shown.map((s) => {
              const pic = pictureOf(s.recipeId);
              return (
                <Pressable key={s.slotId} onPress={go(() => onOpenRecipe(s.recipeId!))} accessibilityRole="button"
                  accessibilityLabel={`${mealLabel(s.mealType)} : ${s.name}`}
                  style={({ pressed }) => [styles.card, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.85 : 1 }, CARD_SHADOW]}>
                  {pic
                    ? <Image source={{ uri: pic.uri, cacheKey: pic.cacheKey }} cachePolicy="memory-disk" style={styles.photo} contentFit="cover" transition={0} />
                    : <View style={[styles.photo, styles.center, { backgroundColor: c.chip }]}><Icon name="image" size={24} color={c.muted} /></View>}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: c.primary, fontSize: 13.5, fontWeight: "600" }}>
                      {s.date === today ? mealLabel(s.mealType) : `${dayLabel(s.date, today)} · ${mealLabel(s.mealType)}`}
                    </Text>
                    <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{s.name}</Text>
                    {s.totalMin ? <Text style={{ color: c.muted, fontSize: 14.2 }}>{minutes(s.totalMin)}</Text> : null}
                  </View>
                  <Icon name="chevronRight" width={9} height={15} color={c.text} />
                </Pressable>
              );
            })}
          </Section>

          {timers.length > 0 && (
            <Section icon="timer" title="Minuteurs">
              {timers.map((t) => (
                <View key={t.id} style={[styles.card, { backgroundColor: t.done ? c.dangerSoft : c.card, borderColor: t.done ? c.dangerSoft : c.cardLine }, CARD_SHADOW]}>
                  <View style={[styles.timerIcon, { backgroundColor: t.done ? c.card : c.greenSoft }]}>
                    <Icon name={t.done ? "bell" : "timer"} size={20} color={t.done ? c.danger : c.greenInk} />
                  </View>
                  <Pressable style={{ flex: 1, minWidth: 0 }} onPress={go(() => onOpenRecipe(t.recipeId))} accessibilityRole="button">
                    <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{t.subject}</Text>
                    <Text style={{ color: c.muted, fontSize: 14.2 }} numberOfLines={1}>Étape {t.step} · {t.recipeName}</Text>
                  </Pressable>
                  <Text style={[styles.clock, { color: t.done ? c.danger : c.text }]}>{t.done ? "Terminé" : clock((t.endsAt - now) / 1000)}</Text>
                  <Pressable onPress={() => stopTimer(t.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t.done ? "Fermer le minuteur" : "Arrêter le minuteur"}>
                    <Icon name="close" size={20} color={c.muted} />
                  </Pressable>
                </View>
              ))}
            </Section>
          )}

          <Section icon="cartBold" title="Courses">
            <Pressable onPress={go(onOpenShopping)} accessibilityRole="button"
              style={({ pressed }) => [styles.card, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.85 : 1 }, CARD_SHADOW]}>
              <View style={[styles.timerIcon, { backgroundColor: c.chip }]}><Icon name="cartFilled" width={22} height={20} color={c.text} /></View>
              <Text style={{ flex: 1, color: toBuy ? c.orangeInk : c.muted, fontSize: 16, fontWeight: "500" }}>
                {toBuy ? `${toBuy} article${toBuy > 1 ? "s" : ""} à acheter` : "Rien à acheter"}
              </Text>
              <Icon name="chevronRight" width={9} height={15} color={c.text} />
            </Pressable>
          </Section>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(26,29,25,0.45)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "82%", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  bell: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 22, lineHeight: 26, fontWeight: "700" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
  empty: { fontSize: 15, lineHeight: 20 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, padding: 8, paddingRight: 12, borderRadius: 12, borderWidth: 1 },
  photo: { width: 64, height: 56, borderRadius: 9 },
  center: { alignItems: "center", justifyContent: "center" },
  name: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
  timerIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  clock: { fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
