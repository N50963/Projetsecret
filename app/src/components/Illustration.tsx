/** Illustration d'une recette : image (photo du foyer ou image créée par Mistral), sinon dessin d'après les ingrédients. */

import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

const PROTEIN: Record<string, [string, string]> = {
  volaille: ["🍗", "#F6E3C8"], boeuf: ["🥩", "#F3D6D2"], porc: ["🥓", "#F5DCD6"], poisson: ["🐟", "#D6E8F2"],
  fruits_de_mer: ["🦐", "#F8DDD2"], oeuf: ["🍳", "#F8EFC6"], legumineuse: ["🫘", "#E9E1D2"], vegetarien: ["🥗", "#DCEFD9"],
};
const INGREDIENT: Record<string, string> = {
  carotte: "🥕", tomate: "🍅", tomate_cerise: "🍅", tomate_conserve: "🍅", pomme_de_terre: "🥔", riz: "🍚", pates: "🍝",
  pates_fraiches: "🍝", brocoli: "🥦", champignon: "🍄", oignon: "🧅", ail: "🧄", poivron: "🫑", courgette: "🥒", concombre: "🥒",
  aubergine: "🍆", citron: "🍋", citron_vert: "🍋", salade_verte: "🥬", epinard: "🥬", avocat: "🥑", mais: "🌽",
  courge_butternut: "🎃", potimarron: "🎃", emmental: "🧀", comte: "🧀", mozzarella: "🧀", chevre: "🧀", feta: "🧀", parmesan: "🧀",
  pain: "🥖", oeuf: "🥚", lait_coco: "🥥", crevette: "🍤", saumon: "🐟", patate_douce: "🍠", olive: "🫒", haricot_vert: "🫛",
  petit_pois: "🫛", pomme: "🍎", poire: "🍐", gnocchi: "🥟", tortilla_wrap: "🌯", lentilles: "🫘", pois_chiches: "🫘",
};

export function Illustration({ uri, mainProtein, slugs, height = 180, rounded = 16 }: {
  uri: string | null | undefined; mainProtein: string; slugs: Array<string | null>; height?: number; rounded?: number;
}) {
  if (uri) {
    return <Image source={{ uri }} style={{ height, borderRadius: rounded, width: "100%" }} contentFit="cover" transition={200}
      accessibilityLabel="Photo du plat" />;
  }
  const [main, background] = PROTEIN[mainProtein] ?? ["🍽️", "#E8E6DE"];
  const extras = [...new Set(slugs.map((s) => (s ? INGREDIENT[s] : undefined)).filter((e): e is string => Boolean(e) && e !== main))].slice(0, 5);
  return (
    <View style={[styles.drawing, { height, borderRadius: rounded, backgroundColor: background }]} accessibilityLabel="Dessin du plat">
      <View style={[styles.plate, { width: height * 0.62, height: height * 0.62, borderRadius: height }]}>
        <Text style={{ fontSize: height * 0.3 }}>{main}</Text>
      </View>
      <View style={styles.extras}>
        {extras.map((e, i) => <Text key={i} style={{ fontSize: height * 0.13 }}>{e}</Text>)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  drawing: { width: "100%", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  plate: { backgroundColor: "rgba(255,255,255,0.85)", alignItems: "center", justifyContent: "center",
    borderWidth: 6, borderColor: "rgba(255,255,255,0.6)" },
  extras: { position: "absolute", bottom: 8, flexDirection: "row", gap: 6 },
});
