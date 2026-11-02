/** Icônes MenuBily, reprises telles quelles des maquettes Claude Design (tracés SVG), et logo (image de la marmite). */

import { Image } from "expo-image";
import type { ReactNode } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

type Paint = { color: string };
type Drawing = { viewBox: string; draw: (p: Paint) => ReactNode };

const stroke = (color: string, width = 2) => ({
  fill: "none", stroke: color, strokeWidth: width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
});

const ICONS = {
  home: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M12 2.5L1.5 12H5v9.5h5.2V15h3.6v6.5H19V12h3.5z" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" /> },
  homeFilled: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M12 2.5L1.5 12H5v9.5h5.2V15h3.6v6.5H19V12h3.5z" fill={color} /> },
  cart: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M1.5 3h3.2l2.7 12.5h11.2" {...stroke(color, 1.8)} /><Path d="M5.5 6.5h16l-2.2 6.2H7" {...stroke(color, 1.8)} />
      <Circle cx={9} cy={19.5} r={1.8} {...stroke(color, 1.8)} /><Circle cx={17.5} cy={19.5} r={1.8} {...stroke(color, 1.8)} />
    </>,
  },
  cartBold: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M1.5 3h3.2l2.7 12.5h11.2" {...stroke(color, 2.2)} /><Path d="M5.5 6.5h16l-2.2 6.2H7" {...stroke(color, 2.2)} />
      <Circle cx={9} cy={19.5} r={1.8} {...stroke(color, 2.2)} /><Circle cx={17.5} cy={19.5} r={1.8} {...stroke(color, 2.2)} />
    </>,
  },
  cartFilled: {
    viewBox: "0 0 28 26", draw: ({ color }) => <>
      <Path d="M1.5 1h4.3l3.7 16h13v3H7.2L3.5 4H1.5z" fill={color} /><Path d="M7 5h20l-3 10.5H9.3z" fill={color} />
      <Circle cx={11} cy={23} r={2.5} fill={color} /><Circle cx={21} cy={23} r={2.5} fill={color} />
    </>,
  },
  profile: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={7.5} r={4.8} {...stroke(color, 2.2)} />
      <Path d="M3.5 20.2c0-3.6 3.8-5.7 8.5-5.7s8.5 2.1 8.5 5.7c0 1-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.6-1.6-1.6z" {...stroke(color, 2.2)} />
    </>,
  },
  profileFilled: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={7.5} r={4.8} fill={color} stroke={color} strokeWidth={1.2} />
      <Path d="M3.5 20.2c0-3.6 3.8-5.7 8.5-5.7s8.5 2.1 8.5 5.7c0 1-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.6-1.6-1.6z" fill={color} stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
    </>,
  },
  bell: {
    viewBox: "0 0 24 25", draw: ({ color }) => <>
      <Path d="M12 1.8v1.7" {...stroke(color)} /><Path d="M4.5 18.8c1.5-1.8 2-4 2-7.3a5.5 5.5 0 0 1 11 0c0 3.3.5 5.5 2 7.3z" {...stroke(color)} />
      <Path d="M9.8 21.8a2.3 2.3 0 0 0 4.4 0" {...stroke(color)} />
    </>,
  },
  calendar: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Rect x={2.5} y={4} width={19} height={17.5} rx={2.5} {...stroke(color, 2.2)} /><Path d="M2.5 9.5h19" {...stroke(color, 2.2)} />
      <Path d="M7.5 2v4" {...stroke(color, 2.2)} /><Path d="M16.5 2v4" {...stroke(color, 2.2)} />
      <Path d="M6.8 13.5h2M11 13.5h2M15.2 13.5h2M6.8 17.2h2M11 17.2h2M15.2 17.2h2" {...stroke(color, 2.4)} />
    </>,
  },
  chevronRight: { viewBox: "0 0 9 15", draw: ({ color }) => <Path d="M2 2l5.5 5.5L2 13" {...stroke(color)} /> },
  chevronDown: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M5.5 9.5L12 16l6.5-6.5" {...stroke(color, 2.4)} /> },
  chevronUp: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M5.5 14.5L12 8l6.5 6.5" {...stroke(color, 2.4)} /> },
  circle: { viewBox: "0 0 24 24", draw: ({ color }) => <Circle cx={12} cy={12} r={9.5} fill="none" stroke={color} strokeWidth={2} /> },
  checkCircle: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={12} r={9.5} {...stroke(color)} /><Path d="M8 12.4l2.7 2.7L16 9.6" {...stroke(color)} />
    </>,
  },
  check: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M5.5 12.5l4.5 4.5 8.5-9.5" {...stroke(color, 2.2)} /> },
  /** Coche et croix fines des cartes de la semaine (maquette « Ruban de la semaine »). */
  tick: { viewBox: "0 0 16 16", draw: ({ color }) => <Path d="M3.2 8.4l3.2 3.2 6.4-7" {...stroke(color, 2.4)} /> },
  cross: { viewBox: "0 0 16 16", draw: ({ color }) => <Path d="M3 3l10 10M13 3L3 13" {...stroke(color)} /> },
  // Poignée de déplacement : deux colonnes de trois points.
  grip: {
    viewBox: "0 0 16 16", draw: ({ color }) => <>
      {[3.5, 8, 12.5].flatMap((y) => [5.5, 10.5].map((x) => <Circle key={`${x}-${y}`} cx={x} cy={y} r={1.45} fill={color} />))}
    </>,
  },
  sun: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={12} r={4.2} {...stroke(color)} />
      <Path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" {...stroke(color)} />
    </>,
  },
  moon: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M20.5 14.3A8.7 8.7 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z" {...stroke(color)} /> },
  close: { viewBox: "0 0 24 24", draw: ({ color }) => <><Path d="M6.5 6.5l11 11" {...stroke(color, 2.2)} /><Path d="M17.5 6.5l-11 11" {...stroke(color, 2.2)} /></> },
  image: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Rect x={3} y={4.5} width={18} height={15} rx={2.5} {...stroke(color, 1.6)} /><Circle cx={8.5} cy={9.5} r={1.6} {...stroke(color, 1.6)} />
      <Path d="M21 15.5l-4.8-4.5L9 18" {...stroke(color, 1.6)} />
    </>,
  },
  clock: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={12} r={10} {...stroke(color)} /><Path d="M12 6.5V12l3.5 2" {...stroke(color)} />
    </>,
  },
  timer: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={13} r={9.5} {...stroke(color)} /><Path d="M12 7.5V13l3.5 2" {...stroke(color)} /><Path d="M9.5 1.5h5" {...stroke(color)} />
    </>,
  },
  toque: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M6.5 14.5H17.5V21.5H6.5z" fill={color} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M6.5 13.5C4 13 2.5 11 2.5 8.8 2.5 6 5 3.8 8 4.3 9 2.8 10.4 2 12 2s3 .8 4 2.3c3-.5 5.5 1.7 5.5 4.5 0 2.2-1.5 4.2-4 4.7" {...stroke(color)} />
      <Path d="M6.5 11.5h11" {...stroke(color)} />
    </>,
  },
  cutlery: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M6 2.5V9a3 3 0 0 0 6 0V2.5" {...stroke(color)} /><Path d="M9 2.5v19" {...stroke(color)} />
      <Path d="M18 21.5v-19c-2.5 1-3.8 4-3.8 7.5 0 2.2 1.2 3.5 3.8 3.5" {...stroke(color)} />
    </>,
  },
  people: {
    viewBox: "0 0 24 20", draw: ({ color }) => <>
      <Circle cx={9} cy={5.5} r={4.5} fill={color} /><Path d="M.5 19c0-5 3.7-7.5 8.5-7.5s8.5 2.5 8.5 7.5v.5H.5z" fill={color} />
      <Circle cx={18} cy={6.5} r={3.5} fill={color} /><Path d="M16.5 11.3c.6-.1 1.1-.2 1.7-.2 3.2 0 5.3 2.3 5.3 6.1v.8h-4.2c-.2-2.9-1.1-5-2.8-6.7z" fill={color} />
    </>,
  },
  sparkle: {
    viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M12 3.5l1.9 5.6a2 2 0 0 0 1.2 1.2l5.4 1.7-5.4 1.7a2 2 0 0 0-1.2 1.2L12 20.5l-1.9-5.6a2 2 0 0 0-1.2-1.2L3.5 12l5.4-1.7a2 2 0 0 0 1.2-1.2z" {...stroke(color, 1.8)} />,
  },
  wand: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M14.8 7.3l3.9 3.9L6.2 23.7 2.3 19.8z" fill={color} />
      <Path d="M9 1.5l.9 2.3 2.3.9-2.3.9L9 8l-.9-2.4-2.3-.9 2.3-.9z" fill={color} />
      <Path d="M19.5 1.5l.9 2.3 2.3.9-2.3.9-.9 2.4-.9-2.4-2.3-.9 2.3-.9z" fill={color} />
      <Path d="M20.5 12l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill={color} />
    </>,
  },
  logout: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" {...stroke(color)} /><Path d="M15.5 8l4 4-4 4" {...stroke(color)} />
      <Path d="M9.5 12h10" {...stroke(color)} />
    </>,
  },
  minus: { viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M6 12h12" {...stroke(color, 2.2)} /> },
  plus: { viewBox: "0 0 24 24", draw: ({ color }) => <><Path d="M6 12h12" {...stroke(color, 2.2)} /><Path d="M12 6v12" {...stroke(color, 2.2)} /></> },
  alert: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Circle cx={12} cy={12} r={9.5} {...stroke(color)} /><Path d="M12 7.5v5.5" {...stroke(color)} /><Path d="M12 16.4v.1" {...stroke(color)} />
    </>,
  },
  camera: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M3.5 8.5a2 2 0 0 1 2-2h2.3l1.4-2.2h5.6l1.4 2.2h2.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" {...stroke(color)} />
      <Circle cx={12} cy={12.8} r={3.6} {...stroke(color)} />
    </>,
  },
  gallery: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Rect x={3} y={7} width={15} height={13} rx={2.5} {...stroke(color)} /><Path d="M7 3.5h11.5A2.5 2.5 0 0 1 21 6v10" {...stroke(color)} />
      <Path d="M18 16l-4-3.8-6.3 7.3" {...stroke(color)} /><Circle cx={8} cy={11.5} r={1.4} {...stroke(color)} />
    </>,
  },
  back: { viewBox: "0 0 22 20", draw: ({ color }) => <><Path d="M21 10H2" {...stroke(color)} /><Path d="M10 2l-8 8 8 8" {...stroke(color)} /></> },
  share: {
    viewBox: "0 0 23 24", draw: ({ color }) => <>
      <Circle cx={18} cy={4.5} r={2.8} fill={color} stroke={color} strokeWidth={2} /><Circle cx={5} cy={12} r={2.8} fill={color} stroke={color} strokeWidth={2} />
      <Circle cx={18} cy={19.5} r={2.8} fill={color} stroke={color} strokeWidth={2} />
      <Path d="M16 5.8L7 10.7M7 13.3l9 4.9" fill="none" stroke={color} strokeWidth={2} />
    </>,
  },
  heart: {
    viewBox: "0 0 24 22", draw: ({ color }) => <Path d="M12 21.5C4.5 15.5.5 12 .5 7A6.3 6.3 0 0 1 7 .5c2 0 3.8 1 5 2.7C13.2 1.5 15 .5 17 .5A6.3 6.3 0 0 1 23.5 7c0 5-4 8.5-11.5 14.5z" fill={color} />,
  },
  heartOutline: {
    viewBox: "0 0 24 22", draw: ({ color }) => <Path d="M12 20.2C5.2 14.8 1.5 11.6 1.5 7A5.3 5.3 0 0 1 7 1.5c2 0 3.6 1 5 3 1.4-2 3-3 5-3A5.3 5.3 0 0 1 22.5 7c0 4.6-3.7 7.8-10.5 13.2z" {...stroke(color)} />,
  },
  receipt: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M5 2.5h14v19l-3.5-2-3.5 2-3.5-2-3.5 2z" {...stroke(color, 2.2)} /><Path d="M9 8h6" {...stroke(color, 2.2)} /><Path d="M9 12.5h6" {...stroke(color, 2.2)} />
    </>,
  },
  sliders: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M3 7h10" {...stroke(color, 2.2)} /><Path d="M19 7h2" {...stroke(color, 2.2)} /><Circle cx={16} cy={7} r={2.8} {...stroke(color, 2.2)} />
      <Path d="M3 17h2" {...stroke(color, 2.2)} /><Path d="M11 17h10" {...stroke(color, 2.2)} /><Circle cx={8} cy={17} r={2.8} {...stroke(color, 2.2)} />
    </>,
  },
  book: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" {...stroke(color, 2)} /><Path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v2.5H6.5" {...stroke(color, 2)} />
      <Path d="M9 7h7" {...stroke(color, 2)} />
    </>,
  },
  bookFilled: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" fill={color} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v2.5H6.5" {...stroke(color, 2)} />
      <Path d="M9 7h7" {...stroke("#FDF3E4", 2)} />
    </>,
  },
  search: { viewBox: "0 0 24 24", draw: ({ color }) => <><Circle cx={10.5} cy={10.5} r={6.5} {...stroke(color, 2.2)} /><Path d="M15.5 15.5l5 5" {...stroke(color, 2.2)} /></> },
  star: {
    viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill={color} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />,
  },
  starOutline: {
    viewBox: "0 0 24 24", draw: ({ color }) => <Path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" {...stroke(color, 1.8)} />,
  },
  trash: {
    viewBox: "0 0 24 24", draw: ({ color }) => <>
      <Path d="M4 6.5h16" {...stroke(color)} /><Path d="M9 6.5V4h6v2.5" {...stroke(color)} /><Path d="M6 6.5l1 14h10l1-14" {...stroke(color)} />
    </>,
  },
  stop: { viewBox: "0 0 24 24", draw: ({ color }) => <><Circle cx={12} cy={12} r={9.5} {...stroke(color)} /><Rect x={8.8} y={8.8} width={6.4} height={6.4} rx={1} fill={color} /></> },
} satisfies Record<string, Drawing>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color, width, height }: { name: IconName; size?: number; color: string; width?: number; height?: number }) {
  const icon: Drawing = ICONS[name];
  return (
    <Svg width={width ?? size} height={height ?? size} viewBox={icon.viewBox} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {icon.draw({ color })}
    </Svg>
  );
}

/** Logo MenuBily : la marmite (même image que l'icône de l'application, assets/logo-marmite.png). */
export function Logo({ width = 56, height = 35 }: { width?: number; height?: number }) {
  return (
    <Image source={require("../../assets/logo-marmite.png")} style={{ width, height }} contentFit="contain" transition={0}
      accessibilityLabel="Logo MenuBily" />
  );
}
