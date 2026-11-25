import { StyleSheet, View } from 'react-native';

import { initial } from '../format';
import { playerColor } from '../theme';
import { AppText } from './AppText';

export interface AvatarProps {
  name: string;
  /** Seat index; picks the colour. */
  index: number;
  size?: number;
}

/** Coloured circle with the player's initial. Decorative: the name is always shown next to it. */
export function Avatar({ name, index, size = 40 }: AvatarProps) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: playerColor(index) }]}
    >
      <AppText allowFontScaling={false} style={[styles.letter, { fontSize: size * 0.45, lineHeight: size * 0.6 }]}>
        {initial(name)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  letter: { color: '#FFFFFF', fontWeight: '900' },
});
