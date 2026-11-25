/**
 * The game as one player sees it on their own phone, rendered purely from the
 * per-player PlayerView the host sends (the host's own phone included). There
 * are no hand-off screens: private information only ever arrives on the phone
 * of the player it belongs to, so every screen here is safe to show as it is.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { FORFEIT_AFTER_REJECTIONS, GIVER_REWARDS, MAX_CLUE_LENGTH, MAX_CLUE_ROUNDS } from '../../game';
import { isGuessWord } from '../../net';
import type { ClientSession, ClientSnapshot, GameView, PlayerView } from '../../net';
import { AppText, Button, Card, Chip, TextField } from '../components';
import { formatPoints, formatScore, formatThreshold, joinNames, pluralize } from '../format';
import { PHASE_TAP_GUARD_MS } from '../game/GameScreen';
import {
  CluesGivenSoFar,
  EarlierRounds,
  GameOverBody,
  LatestClueCard,
  OffLimitsWords,
  PlayerRowView,
  RejectedAttempts,
  RoundResultBody,
  ScoreboardSheet,
  SecretWordCard,
  TurnResultBody,
  WordOptions,
  type PublicPlayer,
} from '../game/parts';
import { spacing } from '../theme';
import { NetFrame, Waiting, hostNameOf, publicPlayersOf, type ModelNotice, type NetFrameProps } from './netShared';

export interface NetGameScreenProps {
  snapshot: ClientSnapshot;
  view: PlayerView;
  game: GameView;
  client: ClientSession;
  modelNotice?: ModelNotice | null;
  /** Ask to leave (the caller confirms). */
  onLeave: () => void;
  /** Leave without asking (offered once the game is over). */
  onLeaveNow: () => void;
}

/** Everything a phase component needs. */
interface PhaseContext {
  snapshot: ClientSnapshot;
  view: PlayerView;
  game: GameView;
  client: ClientSession;
  players: PublicPlayer[];
  giverName: string;
  online: boolean;
  /** True for a moment after each step change, so a double tap cannot press the next screen's button. */
  tooSoon: () => boolean;
  frame: Omit<NetFrameProps, 'children' | 'footer' | 'testID' | 'centered'>;
}

type Feedback = { tone: 'danger' | 'warning'; text: string } | null;

/**
 * A guess is confirmed by the host through the next view. If none has come
 * after this long, the "Sending..." state is dropped so the player can send
 * it again (the host keeps only the first guess, so a duplicate is harmless).
 * An object so tests can shorten it.
 */
export const GUESS_TIMING = { unconfirmedMs: 4000 };

function nameOfSeat(view: PlayerView, seat: number): string {
  return view.players.find((p) => p.seat === seat)?.name ?? 'Someone';
}

// ---------------------------------------------------------------------------
// Who has guessed (never what)
// ---------------------------------------------------------------------------

function GuessProgress({ ctx }: { ctx: PhaseContext }) {
  const { view, game, client, online } = ctx;
  const skippable = view.host?.skippableSeats ?? [];
  const waitingFor = game.guessStatus.filter((s) => s.status === 'pending').map((s) => nameOfSeat(view, s.seat));
  return (
    <View style={styles.block}>
      <AppText variant="label" color="muted">
        Guesses
      </AppText>
      {waitingFor.length > 0 ? (
        <AppText testID="waiting-for" color="muted" accessibilityLiveRegion="polite">
          {`Waiting for ${joinNames(waitingFor)}.`}
        </AppText>
      ) : null}
      <Card>
        {game.guessStatus.map((entry) => {
          const index = view.players.findIndex((p) => p.seat === entry.seat);
          const player = view.players[index];
          if (player === undefined) return null;
          const you = entry.seat === view.you.seat;
          return (
            <PlayerRowView
              key={entry.seat}
              name={you ? `${player.name} (you)` : player.name}
              colorIndex={index}
              subtitle={player.connected ? undefined : 'Disconnected'}
              right={
                <View style={styles.rowRight}>
                  <Chip
                    tone={entry.status === 'submitted' ? 'success' : entry.status === 'skipped' ? 'warning' : 'neutral'}
                    label={entry.status === 'submitted' ? 'Locked in' : entry.status === 'skipped' ? 'Skipped' : 'Guessing...'}
                  />
                  {skippable.includes(entry.seat) ? (
                    <Button
                      compact
                      variant="danger"
                      testID={`skip-${player.name}`}
                      label="Skip"
                      accessibilityLabel={`Skip ${player.name}'s guess`}
                      accessibilityHint="Counts as a wrong guess for this round"
                      disabled={!online}
                      onPress={() => {
                        if (!player.connected) {
                          client.skipGuesser(entry.seat);
                          return;
                        }
                        // Still connected, just not answering: make sure before taking their guess away.
                        Alert.alert(`Skip ${player.name}'s guess?`, `${player.name} is still connected but has not guessed. Skipping counts as a wrong guess for this round.`, [
                          { text: 'Keep waiting', style: 'cancel' },
                          { text: 'Skip', style: 'destructive', onPress: () => client.skipGuesser(entry.seat) },
                        ]);
                      }}
                    />
                  ) : null}
                </View>
              }
            />
          );
        })}
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Giver
// ---------------------------------------------------------------------------

function GiverChooseWord({ ctx }: { ctx: PhaseContext }) {
  const { game, client, online } = ctx;
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = game.giver?.options ?? [];
  return (
    <NetFrame
      {...ctx.frame}
      testID="phase-choose-word"
      footer={
        <View style={styles.block}>
          {error ? (
            <AppText variant="caption" color="danger" accessibilityRole="alert">
              {error}
            </AppText>
          ) : null}
          <Button
            testID="confirm-word"
            label={selected ? `Lock in "${selected}"` : 'Pick a word'}
            disabled={selected === null || !online}
            onPress={() => {
              if (selected === null) return;
              setError(client.chooseWord(selected) ? null : 'Not connected to the host - try again in a moment.');
            }}
          />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          Only you can see this
        </AppText>
        <AppText variant="heading">Pick your secret word</AppText>
        <AppText color="muted">
          You will give one-word clues for it. Your clues may not contain, or be a form of, any of these five words.
        </AppText>
      </View>
      <WordOptions options={options} selected={selected} onSelect={setSelected} label="Secret word options" testIDPrefix="option-" />
    </NetFrame>
  );
}

function GiverClue({ ctx }: { ctx: PhaseContext }) {
  const { snapshot, view, game, client, online } = ctx;
  const giver = game.giver;
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = snapshot.cluePending || (giver?.scoring ?? false);

  const submit = useCallback(async () => {
    if (busy || text.trim().length === 0) return;
    setFeedback(null);
    const result = await client.submitClue(text);
    if (!mounted.current) return;
    switch (result.kind) {
      case 'invalid':
        setFeedback({ tone: 'warning', text: result.message });
        break;
      case 'error':
        setFeedback({ tone: 'danger', text: result.message });
        break;
      case 'rejected':
        // The input stays editable while scoring: only clear it if it was not changed meanwhile.
        setText((current) => (current === text ? '' : current));
        setFeedback({
          tone: 'danger',
          text: `"${result.clue}" scored ${formatScore(result.score)} - not close enough. Try another clue.`,
        });
        break;
      default:
        // 'accepted' moves everyone on to guessing; 'busy' means an earlier submission is still being scored.
        break;
    }
  }, [busy, client, text]);

  const confirmForfeit = useCallback(() => {
    Alert.alert('Forfeit this turn?', 'The turn ends and the word is revealed. Nobody earns any more points this turn.', [
      { text: 'Keep trying', style: 'cancel' },
      { text: 'Forfeit', style: 'destructive', onPress: () => client.forfeit() },
    ]);
  }, [client]);

  if (!giver || giver.hiddenWord === null) return null;
  const threshold = view.settings.threshold;

  return (
    <NetFrame
      {...ctx.frame}
      testID="phase-clue"
      footer={
        <View style={styles.block}>
          {feedback ? (
            <AppText testID="clue-feedback" variant="caption" color={feedback.tone} accessibilityLiveRegion="polite" accessibilityRole="alert">
              {feedback.text}
            </AppText>
          ) : null}
          <TextField
            testID="clue-input"
            label={`Clue ${game.clueRound} of ${MAX_CLUE_ROUNDS}`}
            placeholder="One noun"
            value={text}
            onChangeText={(value) => {
              setText(value);
              if (feedback) setFeedback(null);
            }}
            secretWord
            maxLength={MAX_CLUE_LENGTH + 10}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => void submit()}
          />
          <Button
            testID="submit-clue"
            label={busy ? `${hostNameOf(view)}'s phone is scoring...` : 'Submit clue'}
            loading={busy}
            disabled={text.trim().length === 0 || !online}
            onPress={() => void submit()}
          />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          Only you can see this
        </AppText>
        <SecretWordCard word={giver.hiddenWord} />
        <AppText color="muted">
          {`Type a single noun. It is accepted when its similarity score reaches ${formatThreshold(threshold)}; the host's phone scores it. If nobody guesses the word this round, your total for the turn becomes ${formatPoints(game.rewardIfRoundFails)} (${GIVER_REWARDS.join(', ')} for rounds 1 to ${MAX_CLUE_ROUNDS}).`}
        </AppText>
      </View>

      <OffLimitsWords options={giver.options} hiddenWord={giver.hiddenWord} />
      <CluesGivenSoFar rounds={game.rounds} />
      <RejectedAttempts rejected={giver.rejected} threshold={threshold} />

      <View style={styles.block}>
        {giver.canForfeit ? (
          <Card tone="warning">
            <AppText color="warning" style={styles.bold}>
              Stuck?
            </AppText>
            <AppText variant="caption">
              You can keep trying, or forfeit: the turn ends, the word is revealed and nobody earns any more points this
              turn.
            </AppText>
            <Button testID="forfeit" variant="danger" label="Forfeit turn" disabled={busy || !online} onPress={confirmForfeit} />
          </Card>
        ) : (
          <AppText variant="caption" color="muted">
            {`Forfeiting the turn becomes available after ${pluralize(giver.rejectionsUntilForfeit, 'more rejected clue')} (${FORFEIT_AFTER_REJECTIONS} in one round).`}
          </AppText>
        )}
      </View>
    </NetFrame>
  );
}

// ---------------------------------------------------------------------------
// Guesser
// ---------------------------------------------------------------------------

function GuesserGuess({ ctx }: { ctx: PhaseContext }) {
  const { game, client, players, giverName, online } = ctx;
  const options = game.guessOptions;
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The guess last handed to the connection; the host confirms it through the next view.
  const [sent, setSent] = useState<string | null>(null);

  const value = options ? (selected ?? '') : text.trim();
  const latest = game.acceptedClues[game.acceptedClues.length - 1];

  // A guess handed to a connection that then dropped may never have arrived. The
  // session sends it again by itself after reconnecting; whatever happens, the
  // button must not stay on "Sending..." (this screen is only shown while the
  // host has no guess from this player).
  useEffect(() => {
    if (!online) setSent(null);
  }, [online]);
  useEffect(() => {
    if (sent === null) return;
    const timer = setTimeout(() => setSent(null), GUESS_TIMING.unconfirmedMs);
    return () => clearTimeout(timer);
  }, [sent]);

  const submit = () => {
    if (sent !== null && sent === value) return;
    if (value.length === 0) {
      setError(options ? 'Pick one of the words.' : 'Type your guess first.');
      return;
    }
    if (!options && !isGuessWord(value)) {
      // The host only takes one word of plain letters; say so instead of waiting for nothing.
      setError('Use one word, letters a to z only.');
      return;
    }
    if (client.submitGuess(value)) {
      setError(null);
      setSent(value);
    } else {
      setError('Not connected to the host - try again in a moment.');
    }
  };

  return (
    <NetFrame
      {...ctx.frame}
      testID="phase-guess"
      footer={
        <View style={styles.block}>
          {options ? (
            error ? (
              <AppText variant="caption" color="danger" accessibilityRole="alert">
                {error}
              </AppText>
            ) : null
          ) : (
            <TextField
              testID="guess-input"
              label="Your guess"
              placeholder="One word"
              value={text}
              onChangeText={(next) => {
                setText(next);
                if (error) setError(null);
              }}
              error={error}
              secretWord
              maxLength={40}
              returnKeyType="send"
              onSubmitEditing={submit}
            />
          )}
          <Button
            testID="submit-guess"
            label={sent !== null && sent === value ? 'Sending...' : 'Lock in guess'}
            disabled={value.length === 0 || !online || (sent !== null && sent === value)}
            onPress={submit}
          />
        </View>
      }
    >
      <View style={styles.block}>
        <AppText variant="label" color="accent">
          Everyone guesses at the same time
        </AppText>
        <AppText variant="heading">{`What is ${giverName}'s word?`}</AppText>
      </View>

      {latest ? <LatestClueCard clue={latest.clue} number={game.acceptedClues.length} /> : null}
      <EarlierRounds rounds={game.rounds} players={players} />

      {options ? (
        <View style={styles.block}>
          <AppText variant="label" color="muted">
            It is one of these
          </AppText>
          <WordOptions
            options={options}
            selected={selected}
            onSelect={(word) => {
              setSelected(word);
              setError(null);
            }}
            label="Possible words"
            testIDPrefix="guess-option-"
            minHeight={60}
          />
        </View>
      ) : (
        <AppText color="muted">
          Type the word you think it is. Spelling counts, but a plural is fine. Nobody else sees your guess until
          everyone has guessed.
        </AppText>
      )}

      <GuessProgress ctx={ctx} />
    </NetFrame>
  );
}

// ---------------------------------------------------------------------------
// Watching (nothing to do on this phone right now)
// ---------------------------------------------------------------------------

function Watching({ ctx }: { ctx: PhaseContext }) {
  const { view, game, players, giverName } = ctx;
  const isGiver = game.role === 'giver';
  const latest = game.acceptedClues[game.acceptedClues.length - 1];
  const myStatus = game.guessStatus.find((s) => s.seat === view.you.seat)?.status;

  let title: string;
  let detail: string | undefined;
  if (game.phase === 'choose-word') {
    title = `${giverName} is picking a secret word`;
    detail = 'You will guess it from one-word clues. Nothing to do yet.';
  } else if (game.phase === 'clue') {
    title = `${giverName} is thinking of a clue`;
    detail =
      game.clueRound > 1
        ? `Nobody guessed the word. Clue ${game.clueRound} of ${MAX_CLUE_ROUNDS} is on its way.`
        : `A clue only counts when the host's phone scores it at ${formatThreshold(view.settings.threshold)} or more.`;
  } else if (isGiver) {
    title = 'Your clue was accepted';
    detail = 'The others are guessing now. You see the guesses when everyone is done.';
  } else if (myStatus === 'skipped') {
    title = 'Your guess was skipped';
    detail = 'The host moved on while you were disconnected. It counts as a wrong guess for this round.';
  } else {
    title = 'Guess locked in';
    detail = 'Everyone sees the guesses once they are all in.';
  }

  return (
    <NetFrame {...ctx.frame} testID={`phase-watch-${game.phase}`}>
      <Waiting title={title} detail={detail} />

      {isGiver && game.giver?.hiddenWord ? <SecretWordCard word={game.giver.hiddenWord} /> : null}

      {!isGiver && game.phase === 'guess' && game.yourGuess !== null ? (
        <Card tone="accent">
          <AppText variant="label" color="onAccentSoft" center>
            Your guess
          </AppText>
          <AppText testID="your-guess" variant="heading" color="onAccentSoft" center>
            {game.yourGuess}
          </AppText>
        </Card>
      ) : null}

      {latest && game.phase === 'guess' ? <LatestClueCard clue={latest.clue} number={game.acceptedClues.length} /> : null}
      {game.phase === 'guess' ? <GuessProgress ctx={ctx} /> : null}
      <EarlierRounds rounds={game.rounds} players={players} />
    </NetFrame>
  );
}

// ---------------------------------------------------------------------------
// Public results
// ---------------------------------------------------------------------------

function ContinueFooter({ ctx, label }: { ctx: PhaseContext; label: string }) {
  const { view, game, client, online, tooSoon } = ctx;
  if (!game.canContinue) {
    return (
      <AppText testID="waiting-continue" color="muted" center>
        {`Waiting for ${hostNameOf(view)} to continue.`}
      </AppText>
    );
  }
  return (
    <Button
      testID="next"
      label={label}
      disabled={!online}
      onPress={() => {
        if (!tooSoon()) client.next();
      }}
    />
  );
}

function RoundResult({ ctx }: { ctx: PhaseContext }) {
  const { game, players, giverName } = ctx;
  const round = game.rounds[game.rounds.length - 1];
  if (round === undefined) return null;
  const turnOver = round.anyCorrect || game.clueRound >= MAX_CLUE_ROUNDS;
  return (
    <NetFrame
      {...ctx.frame}
      testID="phase-round-result"
      footer={<ContinueFooter ctx={ctx} label={turnOver ? 'See the turn result' : `On to clue ${game.clueRound + 1}`} />}
    >
      <RoundResultBody round={round} giverName={giverName} turnOver={turnOver} giverTurnPoints={game.giverTurnPoints} players={players} />
    </NetFrame>
  );
}

function TurnResult({ ctx }: { ctx: PhaseContext }) {
  const { view, game, players } = ctx;
  const summary = game.turnSummary;
  if (summary === null) return null;
  const lastTurn = game.turnNumber >= game.totalTurns;
  const giverIndex = view.players.findIndex((p) => p.seat === game.giverSeat);
  const nextGiver = view.players[(giverIndex + 1) % view.players.length];
  return (
    <NetFrame
      {...ctx.frame}
      testID="phase-turn-result"
      footer={<ContinueFooter ctx={ctx} label={lastTurn ? 'See the final scores' : `Next turn: ${nextGiver?.name ?? 'next player'} gives the clues`} />}
    >
      <TurnResultBody summary={summary} players={players} />
    </NetFrame>
  );
}

function GameOver({ ctx, onLeaveNow }: { ctx: PhaseContext; onLeaveNow: () => void }) {
  const { view, client, players, online, tooSoon } = ctx;
  const isHost = view.you.isHost;
  return (
    <NetFrame
      {...ctx.frame}
      title="Final scores"
      testID="phase-game-over"
      footer={
        <View style={styles.block}>
          {view.host?.canPlayAgain ? (
            <Button
              testID="play-again"
              label="Play again"
              accessibilityHint="Takes everyone back to the lobby"
              disabled={!online}
              onPress={() => {
                if (!tooSoon()) client.playAgain();
              }}
            />
          ) : (
            <AppText testID="waiting-again" color="muted" center>
              {`${hostNameOf(view)} can start another game with the same players.`}
            </AppText>
          )}
          <Button
            testID="leave-game"
            variant="secondary"
            label={isHost ? 'Close the game' : 'Leave'}
            onPress={() => {
              if (!tooSoon()) onLeaveNow();
            }}
          />
        </View>
      }
    >
      <GameOverBody players={players} />
    </NetFrame>
  );
}

// ---------------------------------------------------------------------------

export function NetGameScreen({ snapshot, view, game, client, modelNotice, onLeave, onLeaveNow }: NetGameScreenProps) {
  const [scoresOpen, setScoresOpen] = useState(false);
  const players = publicPlayersOf(view);
  const giverName = nameOfSeat(view, game.giverSeat);
  const online = snapshot.status === 'connected';
  const isGiver = game.role === 'giver';

  // Remount per step so typed text and selections never carry over.
  const key = `${game.turnNumber}:${game.clueRound}:${game.phase}`;
  // Stamped during render so the guard is already running when the new step's buttons can first be touched.
  const lastKey = useRef<string | null>(null);
  const stepStartedAt = useRef(0);
  if (lastKey.current !== key) {
    lastKey.current = key;
    stepStartedAt.current = Date.now();
  }
  const tooSoon = useCallback(() => Date.now() - stepStartedAt.current < PHASE_TAP_GUARD_MS, []);

  // Offered at once for a giver who is disconnected, and after a while for one who is connected but not playing.
  const giverConnected = view.players.find((p) => p.seat === game.giverSeat)?.connected ?? false;
  const hostNotices = view.host?.canForfeitGiver ? (
    <Card tone="warning" testID="giver-gone">
      <AppText color="warning" style={styles.bold}>
        {giverConnected ? `${giverName} is not responding` : `${giverName} is disconnected`}
      </AppText>
      <AppText variant="caption">
        {giverConnected
          ? 'The game has been waiting for them for a while. You can keep waiting, or end their turn: it counts as a forfeit and points already earned are kept.'
          : 'The game is waiting for their clue. You can wait for them to come back, or end their turn: it counts as a forfeit and points already earned are kept.'}
      </AppText>
      <Button
        testID="forfeit-giver"
        variant="danger"
        label={`End ${giverName}'s turn`}
        disabled={!online}
        onPress={() => {
          if (!giverConnected) {
            client.forfeitGiver();
            return;
          }
          Alert.alert(`End ${giverName}'s turn?`, `${giverName} is still connected. Their turn ends as a forfeit; points already earned are kept.`, [
            { text: 'Keep waiting', style: 'cancel' },
            { text: 'End turn', style: 'destructive', onPress: () => client.forfeitGiver() },
          ]);
        }}
      />
    </Card>
  ) : null;

  const ctx: PhaseContext = {
    snapshot,
    view,
    game,
    client,
    players,
    giverName,
    online,
    tooSoon,
    frame: {
      title: `Turn ${game.turnNumber} of ${game.totalTurns}`,
      onLeave,
      leaveLabel: view.you.isHost ? 'Close' : 'Leave',
      headerRight: (
        <Button compact variant="ghost" label="Scores" onPress={() => setScoresOpen(true)} accessibilityHint="Shows the scoreboard" />
      ),
      snapshot,
      modelNotice,
      notices: hostNotices,
    },
  };

  const myStatus = game.guessStatus.find((s) => s.seat === view.you.seat)?.status;
  let screen;
  switch (game.phase) {
    case 'choose-word':
      screen = isGiver ? <GiverChooseWord key={key} ctx={ctx} /> : <Watching key={key} ctx={ctx} />;
      break;
    case 'clue':
      screen = isGiver ? <GiverClue key={key} ctx={ctx} /> : <Watching key={key} ctx={ctx} />;
      break;
    case 'guess':
      screen =
        !isGiver && myStatus === 'pending' ? (
          <GuesserGuess key={key} ctx={ctx} />
        ) : (
          <Watching key={`${key}:watch`} ctx={ctx} />
        );
      break;
    case 'round-result':
      screen = <RoundResult key={key} ctx={ctx} />;
      break;
    case 'turn-result':
      screen = <TurnResult key={key} ctx={ctx} />;
      break;
    case 'game-over':
      screen = <GameOver key={key} ctx={ctx} onLeaveNow={onLeaveNow} />;
      break;
  }

  return (
    <>
      {screen}
      <ScoreboardSheet
        visible={scoresOpen}
        onClose={() => setScoresOpen(false)}
        subtitle={`Turn ${game.turnNumber} of ${game.totalTurns} - ${giverName} is the clue-giver - clue round ${Math.min(game.clueRound, MAX_CLUE_ROUNDS)} of ${MAX_CLUE_ROUNDS}`}
        players={players}
      />
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bold: { fontWeight: '700' },
});
