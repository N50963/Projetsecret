/** Couleurs de l'application, claires et sombres selon le réglage du téléphone. */

import { useColorScheme } from "react-native";

const light = {
  background: "#F6F5EF", card: "#FFFFFF", text: "#1F2420", muted: "#6A706A", border: "#E2E1D8",
  primary: "#2F7D4F", primaryText: "#FFFFFF", accent: "#E8A33D", danger: "#C0392B", success: "#2F7D4F",
  chip: "#ECEBE3", chipActive: "#2F7D4F", chipActiveText: "#FFFFFF", overlay: "rgba(0,0,0,0.04)",
};
const dark: typeof light = {
  background: "#121513", card: "#1D221E", text: "#ECEEE9", muted: "#A3A9A2", border: "#2E352F",
  primary: "#5DBB83", primaryText: "#0E1A12", accent: "#F0B860", danger: "#E57368", success: "#5DBB83",
  chip: "#2A302B", chipActive: "#5DBB83", chipActiveText: "#0E1A12", overlay: "rgba(255,255,255,0.05)",
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
