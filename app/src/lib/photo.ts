/** Photo d'un plat prise avec l'appareil photo ou choisie dans la galerie du téléphone. */

import * as ImagePicker from "expo-image-picker";
import { Alert, Platform } from "react-native";

export interface PickedPhoto {
  uri: string;
  width?: number;
}

export async function pickDishPhoto(camera: boolean): Promise<PickedPhoto | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [4, 3], quality: 0.7 };
  if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
    throw new Error("Accès à l'appareil photo refusé : autorisez-le dans les réglages du téléphone.");
  }
  const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  return asset ? { uri: asset.uri, width: asset.width } : null;
}

/** Demande d'où vient la photo (appareil photo ou galerie), puis l'obtient ; null si l'utilisateur renonce. */
export function chooseDishPhoto(title = "Photo du plat"): Promise<PickedPhoto | null> {
  if (Platform.OS === "web") return pickDishPhoto(false);
  return new Promise((resolve, reject) => {
    Alert.alert(title, "Votre photo remplace l'illustration du plat.", [
      { text: "Prendre une photo", onPress: () => pickDishPhoto(true).then(resolve, reject) },
      { text: "Choisir dans la galerie", onPress: () => pickDishPhoto(false).then(resolve, reject) },
      { text: "Annuler", style: "cancel", onPress: () => resolve(null) },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}
