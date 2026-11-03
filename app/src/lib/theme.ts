/**
 * Charte MenuBily (canevas Claude Design « MenuBily ») : fond crème, cartes beige clair, vert profond, texte orange
 * pour ce qui est à acheter. L'application garde cette charte claire quel que soit le réglage du téléphone, comme
 * dans les maquettes.
 */

const palette = {
  /** Fond des écrans. */
  background: "#FEF3E3",
  /** Cartes (jours, articles, préférences). */
  card: "#FDF4E9",
  cardLine: "#FBEEDD",
  /** Filets, contours de boutons secondaires, séparateurs. */
  border: "#E9DCC6",
  text: "#1A1D19",
  /** Texte secondaire (contraste suffisant sur le crème). */
  muted: "#3C403B",
  primary: "#2C5A27",
  primaryText: "#FFFFFF",
  /** Onglet actif de la barre du bas. */
  navActive: "#2F6327",
  nav: "#FDF3E4",
  navLine: "#F6E8D3",
  /** Fond des puces (temps, protéine, repas à cocher) et des photos en préparation. */
  chip: "#FAE8CF",
  /** Puce cochée : vert doux bordé de vert. */
  chipActive: "#E7E3BE",
  chipActiveText: "#1A1D19",
  greenSoft: "#E7E3BE",
  greenInk: "#274420",
  /** « À acheter », nombre d'articles. */
  orangeInk: "#8A4B12",
  /** Classement par temps : froid (bleu-gris doux), chaud (abricot doux). */
  coldSoft: "#DCE7EC",
  coldInk: "#2D5468",
  warmSoft: "#F7DDC2",
  /** Contour des champs de saisie. */
  field: "#8E8672",
  danger: "#B23A2A",
  dangerSoft: "#FBE3D8",
  success: "#2C5A27",
  /** Étoiles de l'avis. */
  accent: "#D39A2C",
  /** Bande verte en tête des écrans. */
  band: "#445A33",
  /** Barre d'état au-dessus de l'en-tête de l'accueil. */
  statusBar: "#3F542F",
  /** Pastille « Aujourd'hui » sur la photo du plat du jour. */
  heroPill: "#64842B",
  overlay: "#FAE8CF",
};

export type Colors = typeof palette;

export const colors: Colors = palette;

export function useColors(): Colors {
  return palette;
}

/** Dégradé du bouton principal (« Proposer les menus », « Se connecter »). */
export const PRIMARY_GRADIENT = ["#4E7029", "#466526", "#4A652B", "#40602C", "#3A5B2F"] as const;
export const PRIMARY_GRADIENT_STOPS = [0, 0.3, 0.5, 0.78, 1] as const;
/** Ombre douce des cartes (brun chaud, très légère). */
export const CARD_SHADOW = { shadowColor: "#966E3C", shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 } as const;
/** Police du nom de l'application (Cabin, gras italique). */
export const BRAND_FONT = "Cabin-BoldItalic";
