/**
 * Barre de mise à jour des illustrations, en bas de l'écran (au-dessus de la barre de navigation) : discrète, aux couleurs
 * de MenuBily. Elle apparaît pendant le téléchargement des illustrations nouvelles ou modifiées (au lancement surtout),
 * indique l'avancement, affiche « Illustrations à jour » un instant, puis disparaît en fondu.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import { useIllustrationUpdate } from "../lib/images";
import { useColors } from "../lib/theme";
import { Icon } from "./icons";

/** Durée d'affichage du message de fin avant le fondu. */
const DONE_MS = 1600;

export function UpdateBar() {
  const c = useColors();
  const u = useIllustrationUpdate();
  const [shown, setShown] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (u.running && u.total > 0) {
      setShown(true);
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      return;
    }
    if (!u.running && shown) {
      const t = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 320, useNativeDriver: true }).start(({ finished }) => {
          if (finished) setShown(false);
        });
      }, DONE_MS);
      return () => clearTimeout(t);
    }
  }, [u.running, u.total, shown, opacity]);

  if (!shown) return null;
  const finished = !u.running;
  const ratio = u.total ? Math.min(1, u.done / u.total) : 1;
  const label = finished
    ? u.failed ? `${u.failed} illustration${u.failed > 1 ? "s" : ""} à charger plus tard` : "Illustrations à jour"
    : "Mise à jour des illustrations";
  return (
    <Animated.View style={[styles.bar, { opacity, backgroundColor: c.nav, borderTopColor: c.navLine }]}
      accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityValue={finished ? undefined : { min: 0, max: u.total, now: u.done }}>
      <View style={styles.row}>
        <Icon name={finished && !u.failed ? "check" : "image"} size={15} color={finished && !u.failed ? c.primary : c.muted} />
        <Text style={[styles.label, { color: c.muted }]} numberOfLines={1}>{label}</Text>
        {!finished && <Text style={[styles.count, { color: c.muted }]}>{u.done} / {u.total}</Text>}
      </View>
      <View style={[styles.track, { backgroundColor: c.chip }]}>
        <View style={[styles.fill, { width: `${Math.round(ratio * 100)}%`, backgroundColor: c.primary }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 7, gap: 5 },
  row: { flexDirection: "row", alignItems: "center", gap: 7 },
  label: { flex: 1, fontSize: 13, lineHeight: 16 },
  count: { fontSize: 13, lineHeight: 16, fontVariant: ["tabular-nums"] },
  track: { height: 3, borderRadius: 2, overflow: "hidden" },
  fill: { height: 3, borderRadius: 2 },
});
