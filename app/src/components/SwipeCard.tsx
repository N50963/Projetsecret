/**
 * Carte en carrousel : glisser vers la gauche montre la recette suivante, vers la droite la précédente. Le geste ne
 * décide rien : choisir ou écarter une recette se fait avec les boutons sous la carte.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { Animated, PanResponder, type GestureResponderEvent, Platform, Pressable, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";

const THRESHOLD = 80;
/** Animations jouées par le système (fil natif) : la carte part sans attendre le calcul des propositions suivantes. */
const NATIVE = Platform.OS !== "web";

/** « left » : recette suivante ; « right » : recette précédente. */
export type SwipeDirection = "left" | "right";

export function SwipeCard({ children, onSwipe, onPress, swipeRef, style, canBack = true, canForward = true, enter = null }: {
  children: ReactNode; onSwipe: (direction: SwipeDirection) => void; onPress?: () => void; style?: StyleProp<ViewStyle>;
  /** Permet de déclencher le même mouvement depuis un bouton. */
  swipeRef?: { current: ((direction: SwipeDirection) => void) | null };
  /** Une recette précédente ou suivante existe (sinon la carte revient en place). */
  canBack?: boolean; canForward?: boolean;
  /** Geste qui a amené cette carte : elle arrive du côté opposé (la carte est recréée à chaque recette). */
  enter?: SwipeDirection | null;
}) {
  const { width } = useWindowDimensions();
  const position = useRef(new Animated.ValueXY({ x: enter === "left" ? width : enter === "right" ? -width : 0, y: 0 })).current;
  const mounted = useRef(true);
  useEffect(() => {
    if (enter) Animated.timing(position, { toValue: { x: 0, y: 0 }, duration: 170, useNativeDriver: NATIVE }).start();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = () => Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: NATIVE, friction: 7 }).start();

  const slide = (direction: SwipeDirection) => {
    const sign = direction === "right" ? 1 : -1;
    Animated.timing(position, { toValue: { x: sign * width, y: 0 }, duration: 160, useNativeDriver: NATIVE }).start(() => {
      onSwipe(direction);
      // Normalement la carte suivante remplace celle-ci ; si elle reste (rien de ce côté), elle revient en place.
      requestAnimationFrame(() => {
        if (mounted.current) settle();
      });
    });
  };

  const allowed = (direction: SwipeDirection) => (direction === "right" ? propsRef.current.canBack : propsRef.current.canForward);
  const propsRef = useRef({ canBack, canForward });
  propsRef.current = { canBack, canForward };

  useEffect(() => {
    if (swipeRef) swipeRef.current = (d) => (allowed(d) ? slideRef.current(d) : settle());
  });

  // Déplacement calculé depuis la position du doigt au début du geste : le cumul de PanResponder est faux sur le web
  // à partir du deuxième geste (la carte ne glissait qu'une fois).
  const startX = useRef(0);
  const dxOf = (e: GestureResponderEvent) => e.nativeEvent.pageX - startX.current;
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: (e, g) => {
      startX.current = e.nativeEvent.pageX - g.dx;
    },
    onPanResponderMove: (e) => {
      const dx = dxOf(e);
      // Pas de recette de ce côté : la carte résiste.
      position.setValue({ x: allowed(dx > 0 ? "right" : "left") ? dx : dx * 0.25, y: 0 });
    },
    onPanResponderRelease: (e) => {
      const dx = dxOf(e);
      const d: SwipeDirection = dx > 0 ? "right" : "left";
      if (Math.abs(dx) > THRESHOLD && allowed(d)) slideRef.current(d);
      else settle();
    },
    onPanResponderTerminate: () => settle(),
  })).current;
  const slideRef = useRef(slide);
  slideRef.current = slide;

  return (
    <Animated.View {...responder.panHandlers} style={[style, { transform: [{ translateX: position.x }] }]}>
      <Pressable onPress={onPress} accessibilityHint="Ouvre la fiche de la recette" style={{ flex: 1 }}>{children}</Pressable>
    </Animated.View>
  );
}
