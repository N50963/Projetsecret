/** Roue à faire défiler pour le temps disponible d'un repas (préparation et cuisson comprises). */

import { useEffect, useRef, useState } from "react";
import {
  Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance,
} from "react-native";

import { minutes } from "../lib/format";
import { useColors } from "../lib/theme";

export const TIME_CHOICES: Array<number | null> = [30, 60, null];
const ITEM = 34;

export function TimeWheel({ value, onChange }: { value: number | null; onChange: (minutes: number | null) => void }) {
  const c = useColors();
  const scroll = useRef<ScrollViewInstance>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = Math.max(0, TIME_CHOICES.indexOf(value));
  const [live, setLive] = useState(index);

  const scrollTo = (i: number, animated: boolean) => scroll.current?.scrollTo({ y: i * ITEM, animated });
  useEffect(() => {
    setLive(index);
    scrollTo(index, false);
  }, [index]);
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);

  const select = (i: number) => {
    scrollTo(i, true);
    setLive(i);
    if (TIME_CHOICES[i] !== value) onChange(TIME_CHOICES[i] ?? null);
  };
  // La valeur est retenue quand le défilement s'arrête (fonctionne aussi sur le web, sans fin d'élan).
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(TIME_CHOICES.length - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.y / ITEM)));
    setLive(i);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => select(i), 160);
  };

  return (
    <View style={{ height: ITEM * 3 }} accessible accessibilityRole="adjustable" accessibilityLabel="Temps disponible"
      accessibilityValue={{ text: minutes(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => select(Math.min(TIME_CHOICES.length - 1, Math.max(0, index + (e.nativeEvent.actionName === "increment" ? 1 : -1))))}>
      <View pointerEvents="none" style={[styles.band, { backgroundColor: c.chip }]} />
      <ScrollView ref={scroll} nestedScrollEnabled showsVerticalScrollIndicator={false} snapToInterval={ITEM} decelerationRate="fast"
        scrollEventThrottle={16} onScroll={onScroll} onLayout={() => scrollTo(index, false)} contentContainerStyle={{ paddingVertical: ITEM }}>
        {TIME_CHOICES.map((t, i) => (
          <Pressable key={String(t)} onPress={() => select(i)} style={styles.item}>
            <Text style={{ fontSize: i === live ? 16 : 14, fontWeight: i === live ? "700" : "400", color: i === live ? c.text : c.muted }}>
              {minutes(t)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { position: "absolute", left: 0, right: 0, top: ITEM, height: ITEM, borderRadius: 10 },
  item: { height: ITEM, alignItems: "center", justifyContent: "center" },
});
