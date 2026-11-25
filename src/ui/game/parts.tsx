/**
 * Presentational pieces shared by pass-and-play (driven by the engine's
 * GameState) and Wi-Fi play (driven by a per-player PlayerView). They take
 * plain props only, so neither mode can leak something through them that the
 * caller did not hand over.
 */
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GIVER_REWARDS, MAX_CLUE_ROUNDS, type ClueAttempt, type RoundRecord, type TurnSummary } from '../../game';
import { AppText, Avatar, Button, Card, Chip, ScoreMeter } from '../components';
import { formatGain, formatPoints, formatScore, joinNames, rankLabel, rankSpoken } from '../format';
import { MAX_CONTENT_WIDTH, radius, spacing, useTheme } from '../theme';

/** What everybody may know about a player. */
export interface PublicPlayer {
  /** Engine player id, as used in rounds and turn summaries. */
  id: string;
  name: string;
  score: number;
  /** Picks the avatar colour (the seat index). */
  colorIndex: number;
}

export interface RankedPublicPlayer extends PublicPlayer {
  /** 1-based competition rank: tied players share a rank (1, 1, 3, ...). */
  rank: number;
  tied: boolean;
}

/** Same ordering and ranks as the engine's rankedPlayers(). */
export function rankPlayers(players: readonly PublicPlayer[]): RankedPublicPlayer[] {
  const sorted = players
    .map((p, index) => ({ p, index }))
    .sort((a, b) => b.p.score - a.p.score || a.index - b.index)
    .map(({ p }) => p);
  return sorted.map((p) => ({
    ...p,
    rank: 1 + sorted.filter((o) => o.score > p.score).length,
    tied: sorted.some((o) => o.id !== p.id && o.score === p.score),
  }));
}

function nameOf(players: readonly PublicPlayer[], id: string): string {
  return players.find((p) => p.id === id)?.name ?? 'Someone';
}

export interface PlayerRowViewProps {
  name: string;
  colorIndex: number;
  right?: ReactNode;
  subtitle?: string;
}

export function PlayerRowView({ name, colorIndex, right, subtitle }: PlayerRowViewProps) {
  return (
    <View style={styles.row}>
      <Avatar name={name} index={colorIndex} />
      <View style={styles.flex}>
        <AppText variant="bodyLarge" style={styles.bold}>
          {name}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color="muted">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right}
    </View>
  );
}

/** Ranked list of all players with their scores. Public information only. */
export function LeaderboardList({ players }: { players: readonly PublicPlayer[] }) {
  return (
    <View style={styles.block}>
      {rankPlayers(players).map((player) => (
        <Card
          key={player.id}
          accessible
          accessibilityLabel={`${player.name}, ${formatPoints(player.score)}, ${rankSpoken(player.rank, player.tied)}`}
          style={styles.leaderRow}
        >
          <AppText variant="title" color={player.rank === 1 ? 'accent' : 'muted'} style={styles.rank}>
            {rankLabel(player.rank, player.tied)}
          </AppText>
          <View style={styles.flex}>
            <PlayerRowView
              name={player.name}
              colorIndex={player.colorIndex}
              right={<AppText variant="title">{player.score}</AppText>}
            />
          </View>
        </Card>
      ))}
    </View>
  );
}

export interface WordOptionsProps {
  options: readonly string[];
  selected: string | null;
  onSelect: (word: string) => void;
  /** Accessibility label of the group. */
  label: string;
  /** Each option gets the testID `${testIDPrefix}${word}`. */
  testIDPrefix: string;
  minHeight?: number;
}

/** A radio list of big word buttons (the giver's five options, or the guessers' list). */
export function WordOptions({ options, selected, onSelect, label, testIDPrefix, minHeight = 64 }: WordOptionsProps) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.options}>
      {options.map((word) => {
        const isSelected = word === selected;
        return (
          <Pressable
            key={word}
            testID={`${testIDPrefix}${word}`}
            onPress={() => onSelect(word)}
            accessibilityRole="radio"
            accessibilityLabel={word}
            accessibilityState={{ selected: isSelected, checked: isSelected }}
            style={({ pressed }) => [
              styles.option,
              {
                minHeight,
                backgroundColor: isSelected ? colors.accent : pressed ? colors.surfaceAlt : colors.surface,
                borderColor: isSelected ? colors.accentEdge : colors.border,
              },
            ]}
          >
            <AppText variant="title" center style={{ color: isSelected ? colors.onAccent : colors.text }}>
              {word}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The giver's secret word, large. Only ever rendered on the giver's screen. */
export function SecretWordCard({ word }: { word: string }) {
  return (
    <Card tone="accent" style={styles.bigCard}>
      <AppText variant="label" color="onAccentSoft" center>
        Your secret word
      </AppText>
      <AppText testID="hidden-word" variant="display" color="onAccentSoft" center>
        {word}
      </AppText>
    </Card>
  );
}

/** The five words a clue may not resemble, with the secret one highlighted. Giver only. */
export function OffLimitsWords({ options, hiddenWord }: { options: readonly string[]; hiddenWord: string }) {
  return (
    <View style={styles.block}>
      <AppText variant="label" color="muted">
        Off-limits words
      </AppText>
      <View style={styles.chips}>
        {options.map((word) => (
          <Chip key={word} label={word} tone={word === hiddenWord ? 'accent' : 'neutral'} />
        ))}
      </View>
    </View>
  );
}

/** Giver's recap of the accepted clues of earlier, failed rounds. */
export function CluesGivenSoFar({ rounds }: { rounds: readonly RoundRecord[] }) {
  if (rounds.length === 0) return null;
  return (
    <View style={styles.block}>
      <AppText variant="label" color="muted">
        Clues given so far
      </AppText>
      {rounds.map((round) => (
        <Card key={round.round}>
          <AppText variant="bodyLarge" style={styles.bold}>
            {`${round.round}. ${round.clue}`}
          </AppText>
          <AppText variant="caption" color="muted">
            {`Scored ${formatScore(round.score)} - nobody guessed the word.`}
          </AppText>
        </Card>
      ))}
    </View>
  );
}

/** This round's rejected attempts with their scores, newest first. Giver only. */
export function RejectedAttempts({ rejected, threshold }: { rejected: readonly ClueAttempt[]; threshold: number }) {
  if (rejected.length === 0) return null;
  const newestFirst = [...rejected].reverse();
  return (
    <View style={styles.block}>
      <AppText variant="label" color="muted">
        {`Rejected this round (${newestFirst.length})`}
      </AppText>
      {newestFirst.map((attempt) => (
        <Card key={attempt.clue} testID={`rejected-${attempt.clue}`}>
          <View style={styles.spreadRow}>
            <AppText variant="bodyLarge" style={[styles.bold, styles.flex]}>
              {attempt.clue}
            </AppText>
            <AppText variant="bodyLarge" color="danger" style={styles.bold}>
              {formatScore(attempt.score)}
            </AppText>
          </View>
          <ScoreMeter score={attempt.score} threshold={threshold} />
        </Card>
      ))}
    </View>
  );
}

/** The newest accepted clue, large. */
export function LatestClueCard({ clue, number }: { clue: string; number: number }) {
  return (
    <Card tone="accent" style={styles.bigCard}>
      <AppText variant="label" color="onAccentSoft" center>
        {`Clue ${number} of ${MAX_CLUE_ROUNDS}`}
      </AppText>
      <AppText testID="latest-clue" variant="display" color="onAccentSoft" center>
        {clue}
      </AppText>
    </Card>
  );
}

/** Earlier (already public) rounds of the turn: each clue with the wrong guesses it drew. */
export function EarlierRounds({ rounds, players }: { rounds: readonly RoundRecord[]; players: readonly PublicPlayer[] }) {
  if (rounds.length === 0) return null;
  return (
    <View style={styles.block}>
      <AppText variant="label" color="muted">
        Earlier clues and wrong guesses
      </AppText>
      {rounds.map((round) => (
        <Card key={round.round}>
          <AppText variant="bodyLarge" style={styles.bold}>
            {`${round.round}. ${round.clue}`}
          </AppText>
          <View style={styles.chips}>
            {round.guesses.map((guess) =>
              guess.skipped ? null : (
                <Chip
                  key={guess.playerId}
                  tone="danger"
                  label={guess.guess}
                  accessibilityLabel={`${nameOf(players, guess.playerId)} guessed ${guess.guess}, wrong`}
                />
              ),
            )}
          </View>
        </Card>
      ))}
    </View>
  );
}

export interface RoundResultBodyProps {
  round: RoundRecord;
  giverName: string;
  /** True when this round ended the turn (somebody was right, or it was the last round). */
  turnOver: boolean;
  /** The giver's points so far this turn (fallback for the "turn total" text). */
  giverTurnPoints: number;
  players: readonly PublicPlayer[];
}

/**
 * Public: every guess of the round is revealed. The hidden word is not shown
 * here; it only becomes visible through a correct guess, which ends the turn.
 */
export function RoundResultBody({ round, giverName, turnOver, giverTurnPoints, players }: RoundResultBodyProps) {
  const correctNames = round.correctGuesserIds.map((id) => nameOf(players, id));
  return (
    <>
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          {`Clue ${round.round} of ${MAX_CLUE_ROUNDS} - everyone can look`}
        </AppText>
        <AppText variant="heading">
          {round.anyCorrect
            ? `${joinNames(correctNames)} got it!`
            : turnOver
              ? `Nobody got it - ${giverName} wins the turn`
              : 'Nobody got it'}
        </AppText>
        <AppText color="muted">
          {round.anyCorrect
            ? `${formatGain(1)} for ${correctNames.length === 1 ? correctNames[0] : 'each of them'}.`
            : `${giverName} earns ${formatGain(round.giverPointsAwarded)} (turn total ${formatPoints(
                GIVER_REWARDS[round.round - 1] ?? giverTurnPoints,
              )}).`}
        </AppText>
      </View>

      <Card tone="accent">
        <AppText variant="label" color="onAccentSoft">
          {`${giverName}'s clue`}
        </AppText>
        <AppText variant="heading" color="onAccentSoft">
          {round.clue}
        </AppText>
      </Card>

      <View style={styles.block}>
        <AppText variant="label" color="muted">
          Guesses
        </AppText>
        {round.guesses.map((guess) => {
          const player = players.find((p) => p.id === guess.playerId);
          if (player === undefined) return null;
          const verdict = guess.skipped ? 'no guess' : guess.correct ? 'correct' : 'wrong';
          return (
            <Card
              key={guess.playerId}
              accessible
              accessibilityLabel={
                guess.skipped ? `${player.name} did not guess` : `${player.name} guessed ${guess.guess}, ${verdict}`
              }
            >
              <PlayerRowView
                name={player.name}
                colorIndex={player.colorIndex}
                subtitle={guess.skipped ? 'did not guess' : `guessed "${guess.guess}"`}
                right={
                  guess.skipped ? (
                    <Chip tone="neutral" label="Skipped" />
                  ) : (
                    <Chip tone={guess.correct ? 'success' : 'danger'} label={guess.correct ? 'Correct +1' : 'Wrong'} />
                  )
                }
              />
            </Card>
          );
        })}
      </View>
    </>
  );
}

export interface TurnResultBodyProps {
  summary: TurnSummary;
  players: readonly PublicPlayer[];
}

/** Public: the turn is over, so the hidden word and the turn's points are revealed. */
export function TurnResultBody({ summary, players }: TurnResultBodyProps) {
  const giver = players.find((p) => p.id === summary.giverId);
  const giverName = giver?.name ?? 'Someone';
  const correctNames = summary.correctGuesserIds.map((id) => nameOf(players, id));
  const headline =
    summary.outcome === 'guessed'
      ? `${joinNames(correctNames)} guessed it`
      : summary.outcome === 'not-guessed'
        ? `${giverName} stumped everyone`
        : `${giverName} forfeited the turn`;

  return (
    <>
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          Turn over - everyone can look
        </AppText>
        <AppText variant="heading">{headline}</AppText>
      </View>

      {summary.hiddenWord.length > 0 ? (
        <Card tone="accent" style={styles.bigCard}>
          <AppText variant="label" color="onAccentSoft" center>
            {`${giverName}'s word was`}
          </AppText>
          <AppText testID="revealed-word" variant="display" color="onAccentSoft" center>
            {summary.hiddenWord}
          </AppText>
        </Card>
      ) : (
        // Only possible over Wi-Fi: the giver dropped out before picking a word.
        <Card tone="muted" testID="no-word-chosen">
          <AppText center color="muted">
            {`The turn ended before ${giverName} picked a word.`}
          </AppText>
        </Card>
      )}

      <View style={styles.block}>
        <AppText variant="label" color="muted">
          Points this turn
        </AppText>
        <Card>
          <PlayerRowView
            name={giverName}
            colorIndex={giver?.colorIndex ?? 0}
            subtitle="Clue-giver"
            right={<Chip tone={summary.giverPoints > 0 ? 'success' : 'neutral'} label={formatGain(summary.giverPoints)} />}
          />
          {summary.correctGuesserIds.map((id) => {
            const player = players.find((p) => p.id === id);
            return player ? (
              <PlayerRowView
                key={id}
                name={player.name}
                colorIndex={player.colorIndex}
                subtitle="Guessed the word"
                right={<Chip tone="success" label={formatGain(1)} />}
              />
            ) : null;
          })}
        </Card>
      </View>

      {summary.clues.length > 0 ? (
        <View style={styles.block}>
          <AppText variant="label" color="muted">
            Accepted clues
          </AppText>
          <Card>
            {summary.clues.map((clue, i) => (
              <View key={clue.clue} style={styles.spreadRow}>
                <AppText variant="bodyLarge" style={[styles.bold, styles.flex]}>
                  {`${i + 1}. ${clue.clue}`}
                </AppText>
                <AppText color="muted" accessibilityLabel={`similarity score ${formatScore(clue.score)}`}>
                  {formatScore(clue.score)}
                </AppText>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <View style={styles.block}>
        <AppText variant="label" color="muted">
          Standings
        </AppText>
        <LeaderboardList players={players} />
      </View>
    </>
  );
}

/** Final headline and ranked leaderboard; ties are shown as ties. */
export function GameOverBody({ players }: { players: readonly PublicPlayer[] }) {
  const topScore = Math.max(0, ...players.map((p) => p.score));
  const top = players.filter((p) => p.score === topScore);
  const headline =
    top.length === 1
      ? `${top[0].name} wins!`
      : top.length === players.length
        ? "It's a tie all round!"
        : `${joinNames(top.map((p) => p.name))} tie for first!`;
  return (
    <>
      <View style={styles.block}>
        <AppText variant="label" color="accent" center>
          Game over
        </AppText>
        <AppText testID="winner-headline" variant="display" center>
          {headline}
        </AppText>
        <AppText color="muted" center>
          {`With ${formatPoints(top[0]?.score ?? 0)}${top.length > 1 ? ' each' : ''}.`}
        </AppText>
      </View>
      <LeaderboardList players={players} />
    </>
  );
}

export interface ScoreboardSheetProps {
  visible: boolean;
  onClose: () => void;
  /** One line about where the game stands. */
  subtitle: string;
  players: readonly PublicPlayer[];
}

/** Scores and turn progress in a modal sheet. Deliberately contains public information only. */
export function ScoreboardSheet({ visible, onClose, subtitle, players }: ScoreboardSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[
          styles.backdrop,
          { backgroundColor: colors.overlay, paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
        ]}
      >
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.bg, borderColor: colors.border }]}>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <AppText variant="heading">Scoreboard</AppText>
            <AppText color="muted">{subtitle}</AppText>
            <LeaderboardList players={players} />
          </ScrollView>
          <View style={styles.sheetFooter}>
            <Button testID="close-scores" label="Close" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  spreadRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  leaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rank: { minWidth: 36 },
  bigCard: { paddingVertical: spacing.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  options: { gap: spacing.md },
  option: {
    borderRadius: radius.md,
    borderWidth: 2,
    borderBottomWidth: 4,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  bold: { fontWeight: '700' },
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  sheet: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    maxHeight: '100%',
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sheetContent: { padding: spacing.lg, gap: spacing.md },
  sheetFooter: { padding: spacing.lg, paddingTop: spacing.sm },
});
