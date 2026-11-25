/** Scaffold and status banners shared by the lobby and the networked game screens. */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ClientSnapshot, PlayerView } from '../../net';
import { AppText, Button, Card, Screen } from '../components';
import { joinNames } from '../format';
import type { PublicPlayer } from '../game/parts';
import { spacing } from '../theme';

/** What the host's phone knows about its own word model, shown on the host only. */
export interface ModelNotice {
  status: 'loading' | 'error';
  detail?: string;
  retry: () => void;
}

export interface NetFrameProps {
  testID?: string;
  title: string;
  /** Ask to leave (the caller confirms). */
  onLeave: () => void;
  leaveLabel?: string;
  headerRight?: ReactNode;
  footer?: ReactNode;
  centered?: boolean;
  snapshot: ClientSnapshot;
  modelNotice?: ModelNotice | null;
  /** Extra cards under the connection banners (host controls). */
  notices?: ReactNode;
  children?: ReactNode;
}

/** The view's players in the shape the shared game components take. Public information only. */
export function publicPlayersOf(view: PlayerView): PublicPlayer[] {
  return view.players.map((p, index) => ({
    id: p.id ?? `seat-${p.seat}`,
    name: p.name,
    score: p.score,
    colorIndex: index,
  }));
}

export function hostNameOf(view: PlayerView): string {
  return view.players.find((p) => p.isHost)?.name ?? 'the host';
}

/**
 * Page scaffold for everything inside a session. Puts the connection state
 * where it cannot be missed: a banner while reconnecting, and the names of
 * players who have dropped out.
 */
export function NetFrame({
  testID,
  title,
  onLeave,
  leaveLabel = 'Leave',
  headerRight,
  footer,
  centered,
  snapshot,
  modelNotice,
  notices,
  children,
}: NetFrameProps) {
  const view = snapshot.view;
  const reconnecting = snapshot.status === 'reconnecting';
  const gone =
    view && view.stage === 'game' ? view.players.filter((p) => !p.connected && p.seat !== view.you.seat).map((p) => p.name) : [];
  return (
    <Screen testID={testID} title={title} onBack={onLeave} backLabel={leaveLabel} headerRight={headerRight} footer={footer} centered={centered}>
      {reconnecting ? (
        <Card tone="warning" testID="reconnecting-banner" accessibilityLiveRegion="polite">
          <AppText color="warning" style={styles.bold} accessibilityRole="alert">
            Connection lost
          </AppText>
          <AppText variant="caption">
            Trying to reconnect to the host. What you see may be out of date, and nothing you tap is sent until the
            connection is back.
          </AppText>
        </Card>
      ) : null}
      {gone.length > 0 ? (
        <Card tone="warning" testID="disconnected-banner">
          <AppText variant="caption" color="warning" style={styles.bold}>
            {`${joinNames(gone)} ${gone.length === 1 ? 'is' : 'are'} disconnected.`}
          </AppText>
          <AppText variant="caption">
            {view?.you.isHost
              ? 'They get their place back when their phone reconnects, unless they left the game. If the game is waiting for them, you can skip them below.'
              : 'They get their place back when their phone reconnects, unless they left the game. The host can skip them if the game is waiting.'}
          </AppText>
        </Card>
      ) : null}
      {modelNotice ? (
        <Card tone={modelNotice.status === 'error' ? 'danger' : 'muted'} testID={`host-model-${modelNotice.status}`}>
          {modelNotice.status === 'error' ? (
            <>
              <AppText color="danger" style={styles.bold}>
                The word model failed to load on this phone
              </AppText>
              <AppText variant="caption">
                {`${modelNotice.detail ? `${modelNotice.detail}. ` : ''}This phone scores everyone's clues, so no clue can be accepted until it loads.`}
              </AppText>
              <Button compact variant="secondary" testID="host-model-retry" label="Retry loading the model" onPress={modelNotice.retry} />
            </>
          ) : (
            <AppText variant="caption" color="muted">
              The word model is still loading on this phone. Clues are scored as soon as it is ready.
            </AppText>
          )}
        </Card>
      ) : null}
      {notices}
      {children}
    </Screen>
  );
}

/** Small "waiting for ..." block used wherever a player has nothing to do. */
export function Waiting({ title, detail, testID }: { title: string; detail?: string; testID?: string }) {
  return (
    <View style={styles.waiting} testID={testID}>
      <AppText variant="heading" center>
        {title}
      </AppText>
      {detail ? (
        <AppText color="muted" center>
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  waiting: { gap: spacing.sm, paddingVertical: spacing.lg },
});
