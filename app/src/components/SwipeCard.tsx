/** Carte à faire glisser : à droite pour choisir, à gauche pour passer (boutons équivalents sous la carte). */

import { useEffect, useRef, type ReactNode } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { Animated, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";

import { PRIMARY_GRADIENT, PRIMARY_GRADIENT_STOPS, colors } from "../lib/theme";
import { Icon } from "./icons";

const THRESHOLD = 110;

export type SwipeDirection = "left" | "right";

export function SwipeCard({ children, onSwipe, onPress, swipeRef, style }: {
  children: ReactNode; onSwipe: (direction: SwipeDirection) => void; onPress?: () => void; style?: StyleProp<ViewStyle>;
  /** Permet aux boutons de déclencher le même mouvement que le geste. */
  swipeRef?: { current: ((direction: SwipeDirection) => void) | null };
}) {
  const { width } = useWindowDimensions();
  const position = useRef(new Animated.ValueXY()).current;

  const fly = (direction: SwipeDirection) => {
    Animated.timing(position, { toValue: { x: (direction === "right" ? 1.4 : -1.4) * width, y: 0 }, duration: 220, useNativeDriver: false })
      .start(() => {
        position.setValue({ x: 0, y: 0 });
        onSwipe(direction);
      });
  };

  useEffect(() => {
    if (swipeRef) swipeRef.current = fly;
  });

  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_e, g) => position.setValue({ x: g.dx, y: g.dy * 0.2 }),
    onPanResponderRelease: (_e, g) => {
      if (g.dx > THRESHOLD) flyRef.current("right");
      else if (g.dx < -THRESHOLD) flyRef.current("left");
      else Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false, friction: 6 }).start();
    },
    onPanResponderTerminate: () => Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start(),
  })).current;
  const flyRef = useRef(fly);
  flyRef.current = fly;

  const rotate = position.x.interpolate({ inputRange: [-width, 0, width], outputRange: ["-8deg", "0deg", "8deg"] });
  const yes = position.x.interpolate({ inputRange: [0, THRESHOLD], outputRange: [0, 1], extrapolate: "clamp" });
  const no = position.x.interpolate({ inputRange: [-THRESHOLD, 0], outputRange: [1, 0], extrapolate: "clamp" });

  return (
    <Animated.View {...responder.panHandlers} style={[style, { transform: [{ translateX: position.x }, { translateY: position.y }, { rotate }] }]}>
      <Pressable onPress={onPress} accessibilityHint="Ouvre la fiche de la recette" style={{ flex: 1 }}>{children}</Pressable>
      <Animated.View pointerEvents="none" style={[styles.stamp, { left: 14, opacity: yes }]}>
        <LinearGradient colors={PRIMARY_GRADIENT} locations={PRIMARY_GRADIENT_STOPS} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.stampInner}>
          <Icon name="check" size={22} color="#FFFFFF" />
          <Text style={[styles.stampText, { color: "#FFFFFF" }]}>Je choisis</Text>
        </LinearGradient>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.stamp, { right: 14, opacity: no }]}>
        <Animated.View style={[styles.stampInner, { backgroundColor: colors.chip }]}>
          <Icon name="close" size={22} color={colors.text} />
          <Text style={[styles.stampText, { color: colors.text }]}>Autre idée</Text>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stamp: { position: "absolute", top: 14, borderRadius: 20, overflow: "hidden" },
  stampInner: { height: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingRight: 14 },
  stampText: { fontSize: 16, fontWeight: "600" },
});
