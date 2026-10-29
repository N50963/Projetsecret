/** Carte à faire glisser : à droite pour choisir, à gauche pour passer (boutons équivalents sous la carte). */

import { useEffect, useRef, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions } from "react-native";

const THRESHOLD = 110;

export type SwipeDirection = "left" | "right";

export function SwipeCard({ children, onSwipe, onPress, swipeRef }: {
  children: ReactNode; onSwipe: (direction: SwipeDirection) => void; onPress?: () => void;
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

  const rotate = position.x.interpolate({ inputRange: [-width, 0, width], outputRange: ["-12deg", "0deg", "12deg"] });
  const yes = position.x.interpolate({ inputRange: [0, THRESHOLD], outputRange: [0, 1], extrapolate: "clamp" });
  const no = position.x.interpolate({ inputRange: [-THRESHOLD, 0], outputRange: [1, 0], extrapolate: "clamp" });

  return (
    <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: position.x }, { translateY: position.y }, { rotate }] }}>
      <Pressable onPress={onPress} accessibilityHint="Ouvre la fiche de la recette">{children}</Pressable>
      <Animated.View pointerEvents="none" style={[styles.stamp, styles.yes, { opacity: yes }]}>
        <Text style={[styles.stampText, { color: "#2F7D4F" }]}>OUI</Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.stamp, styles.no, { opacity: no }]}>
        <Text style={[styles.stampText, { color: "#C0392B" }]}>NON</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stamp: { position: "absolute", top: 24, borderWidth: 4, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: "rgba(255,255,255,0.85)" },
  yes: { left: 20, borderColor: "#2F7D4F", transform: [{ rotate: "-12deg" }] },
  no: { right: 20, borderColor: "#C0392B", transform: [{ rotate: "12deg" }] },
  stampText: { fontSize: 28, fontWeight: "800" },
});
