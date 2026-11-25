import { StyleSheet, View } from 'react-native';

import type { ClientSession, ClientSnapshot, HostSnapshot, PlayerView } from '../../net';
import { AppText, Button, Card, Chip } from '../components';
import { formatThreshold, pluralize } from '../format';
import { PlayerRowView } from '../game/parts';
import { spacing } from '../theme';
import { NetFrame, hostNameOf, type ModelNotice } from './netShared';

export interface LobbyScreenProps {
  snapshot: ClientSnapshot;
  view: PlayerView;
  client: ClientSession;
  /** Present on the host's phone only. */
  hostSnapshot?: HostSnapshot | null;
  modelNotice?: ModelNotice | null;
  onLeave: () => void;
}

/** The lobby, for the host (address, remove, start) and for joiners (waiting). */
export function LobbyScreen({ snapshot, view, client, hostSnapshot, modelNotice, onLeave }: LobbyScreenProps) {
  const controls = view.host;
  const isHost = view.you.isHost;
  const online = snapshot.status === 'connected';
  const connected = view.players.filter((p) => p.connected).length;
  const settings = view.settings;

  let startHint: string | null = null;
  if (connected < view.minPlayers) {
    startHint = `Waiting for at least ${pluralize(view.minPlayers, 'player')} - ${connected} here so far.`;
  } else if (connected > view.maxPlayers) {
    startHint = `At most ${view.maxPlayers} players can play. Remove someone to start.`;
  } else if (view.players.some((p) => !p.connected)) {
    startHint = 'Players who are disconnected when you start are left out of the game.';
  }

  return (
    <NetFrame
      testID="screen-lobby"
      title="Lobby"
      onLeave={onLeave}
      leaveLabel={isHost ? 'Close' : 'Leave'}
      snapshot={snapshot}
      modelNotice={modelNotice}
      footer={
        isHost ? (
          <View style={styles.block}>
            {startHint ? (
              <AppText testID="start-hint" variant="caption" color="muted">
                {startHint}
              </AppText>
            ) : null}
            <Button
              testID="start-wifi-game"
              label={`Start game with ${pluralize(connected, 'player')}`}
              disabled={!online || !controls?.canStart}
              onPress={() => client.startGame()}
            />
          </View>
        ) : (
          <AppText testID="lobby-waiting" color="muted" center>
            {`Waiting for ${hostNameOf(view)} to start the game.`}
          </AppText>
        )
      }
    >
      <View style={styles.block}>
        <AppText variant="heading">{isHost ? 'Your lobby is open' : `${hostNameOf(view)}'s lobby`}</AppText>
        <AppText color="muted">
          {isHost
            ? 'Other phones on this Wi-Fi find your game under "Play over Wi-Fi" on their home screen.'
            : `You are in as ${view.you.name}. The game starts when the host says so.`}
        </AppText>
      </View>

      {isHost && hostSnapshot ? (
        <Card tone="accent" testID="host-address-card">
          <AppText variant="label" color="onAccentSoft">
            If your game does not show up
          </AppText>
          {hostSnapshot.address !== null && hostSnapshot.port !== null ? (
            <>
              <AppText color="onAccentSoft">They can tap "Enter the host's address instead" and type:</AppText>
              <AppText testID="host-address" variant="title" color="onAccentSoft" selectable>
                {`${hostSnapshot.address}:${hostSnapshot.port}`}
              </AppText>
              <AppText variant="caption" color="onAccentSoft">
                {`IP address ${hostSnapshot.address}, port ${hostSnapshot.port}.`}
              </AppText>
            </>
          ) : (
            <AppText testID="host-address" color="onAccentSoft">
              {`This phone's Wi-Fi address could not be read. Look it up in the Wi-Fi settings (IP address); the port is ${hostSnapshot.port ?? 'unknown'}.`}
            </AppText>
          )}
          {hostSnapshot.error ? (
            <AppText variant="caption" color="danger">
              {`Network problem: ${hostSnapshot.error}`}
            </AppText>
          ) : null}
        </Card>
      ) : null}

      <View style={styles.block}>
        <AppText variant="label" color="muted">
          {`Players (${view.players.length} of ${view.maxPlayers})`}
        </AppText>
        {view.players.map((player, index) => {
          const you = player.seat === view.you.seat;
          const removable = controls?.removableSeats.includes(player.seat) ?? false;
          return (
            <Card
              key={player.seat}
              testID={`lobby-player-${player.name}`}
              accessible={!removable}
              accessibilityLabel={`${player.name}${you ? ', you' : ''}${player.isHost ? ', host' : ''}${player.connected ? '' : ', disconnected'}`}
            >
              <PlayerRowView
                name={player.name}
                colorIndex={index}
                subtitle={[you ? 'You' : null, player.isHost ? 'Host' : null].filter(Boolean).join(' - ') || undefined}
                right={
                  <View style={styles.rowRight}>
                    {player.connected ? null : <Chip tone="warning" label="Disconnected" />}
                    {removable ? (
                      <Button
                        compact
                        variant="ghost"
                        testID={`remove-${player.name}`}
                        label="Remove"
                        accessibilityLabel={`Remove ${player.name}`}
                        disabled={!online}
                        onPress={() => client.removePlayer(player.seat)}
                      />
                    ) : null}
                  </View>
                }
              />
            </Card>
          );
        })}
      </View>

      <Card tone="muted">
        <AppText variant="label" color="muted">
          This game
        </AppText>
        <AppText variant="caption">
          {`${pluralize(settings.turnsPerPlayer, 'turn')} as clue-giver each - clue threshold ${formatThreshold(settings.threshold)} - ${
            settings.guessMode === 'list' ? 'guessers pick from the five words' : 'guessers type any word'
          }${settings.requireDictionaryNoun ? '' : ' - clues need not be dictionary nouns'}. ${
            isHost ? 'These are your settings; change them in Settings before opening a lobby.' : "These are the host's settings."
          }`}
        </AppText>
        <AppText variant="caption" color="muted">
          {view.continueBy === 'host'
            ? 'The host scores every clue and moves the game on after each result.'
            : 'The host scores every clue; anyone can move the game on after each result.'}
        </AppText>
      </Card>
    </NetFrame>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
