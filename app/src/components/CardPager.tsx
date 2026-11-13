/**
 * Carrousel des propositions : les cartes sont côte à côte et défilent page par page, avec le défilement natif du
 * téléphone (la carte suit le doigt et se cale toujours au centre). Remplace l'ancienne carte déplacée par une animation
 * maison, qui sur Android pouvait rester décalée pendant et après le mouvement. Le geste ne décide rien : choisir ou
 * écarter une recette se fait avec les boutons sous la carte.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";

export function CardPager<T>({ items, index, onIndex, keyOf, render, style, gutter = 14 }: {
  items: T[];
  /** Carte affichée. */
  index: number;
  /** Le foyer a fait défiler jusqu'à une autre carte. */
  onIndex: (index: number) => void;
  keyOf: (item: T, index: number) => string;
  render: (item: T, index: number) => ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Marge de l'écran autour de la carte : le carrousel s'étend jusqu'au bord de l'écran, la carte glisse ainsi jusqu'au
   * bord (et pas coupée avant), avec deux marges d'écart entre deux cartes.
   */
  gutter?: number;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { width, height } = size;
  const list = useRef<FlatList<T>>(null);
  /** Carte calée à l'écran (défilement du foyer ou demande de l'écran). */
  const shown = useRef(index);

  // L'écran change de carte (recette écartée, retour au début) : le carrousel s'y cale.
  useEffect(() => {
    if (!width || !items.length) return;
    const target = Math.max(0, Math.min(index, items.length - 1));
    if (target === shown.current) return;
    shown.current = target;
    list.current?.scrollToOffset({ offset: target * width, animated: true });
  }, [index, width, items.length]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!width) return;
    const i = Math.max(0, Math.min(items.length - 1, Math.round(e.nativeEvent.contentOffset.x / width)));
    if (i !== shown.current) {
      shown.current = i;
      onIndex(i);
    }
  };

  return (
    <View style={[style, { marginHorizontal: -gutter }]}
      onLayout={(e) => setSize({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })}>
      {width > 0 && height > 0 ? (
        <FlatList
          ref={list}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          disableIntervalMomentum
          keyExtractor={keyOf}
          getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={Math.max(0, Math.min(index, items.length - 1))}
          onScroll={onScroll}
          scrollEventThrottle={32}
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          windowSize={5}
          style={{ width, height }}
          // Chaque page a la taille exacte du carrousel : la carte remplit toute la hauteur et se cale toujours au centre.
          renderItem={({ item, index: i }) => <View style={{ width, height, paddingHorizontal: gutter }}>{render(item, i)}</View>}
        />
      ) : null}
    </View>
  );
}
