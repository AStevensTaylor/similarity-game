import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  DEFAULT_SETTINGS,
  FORFEIT_AFTER_REJECTIONS,
  GIVER_REWARDS,
  MAX_CLUE_ROUNDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  OPTIONS_PER_TURN,
} from '../../game';
import { CALIBRATION_INFO, LINK_RAW_FLOOR, RAW_GATE, SCORE_GATE } from '../../similarity';
import { AppText, Card, Screen } from '../components';
import { formatRaw, formatThreshold } from '../format';
import { useSettings } from '../SettingsContext';
import { spacing, useTheme } from '../theme';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <AppText variant="title">{title}</AppText>
      {children}
    </Card>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.bullet}>
      <View style={[styles.bulletDot, { backgroundColor: colors.accent }]} />
      <AppText style={styles.flex}>{children}</AppText>
    </View>
  );
}

export interface HowToPlayScreenProps {
  onBack: () => void;
}

export function HowToPlayScreen({ onBack }: HowToPlayScreenProps) {
  const { settings } = useSettings();
  const gate = formatRaw(RAW_GATE);
  const scoreGate = formatThreshold(SCORE_GATE);
  return (
    <Screen testID="screen-how-to-play" title="How to play" onBack={onBack} backLabel="Home">
      <Section title="The idea">
        <AppText>
          {`A word game for ${MIN_PLAYERS} to ${MAX_PLAYERS} players: pass one phone around, or play over Wi-Fi with everyone on their own phone. One player secretly picks a word and gives one-word clues. A clue only counts if the phone's language model agrees it is close enough to the secret word - and the clue-giver scores when the others still cannot guess it.`}
        </AppText>
      </Section>

      <Section title="A turn">
        <Bullet>
          {`The clue-giver privately sees ${OPTIONS_PER_TURN} random nouns and picks one as the secret word.`}
        </Bullet>
        <Bullet>
          {`They type a clue: a single noun. It is accepted if its similarity score with the secret word is at least the threshold (${formatThreshold(settings.threshold)} right now)${
            settings.useWordLinks
              ? ', or if a dictionary links the two words (see "Word links" below)'
              : ''
          }. A rejected clue shows its score to the clue-giver only, and they try another.`}
        </Bullet>
        <Bullet>
          Once a clue is accepted, every other player privately makes one guess (the phone is passed to each of them
          in turn, or over Wi-Fi they all guess on their own phones). Nobody sees anyone else's guess until all are in.
        </Bullet>
        <Bullet>
          All guesses are then revealed. If someone is right, the turn ends. If nobody is, the clue-giver gives another
          clue.
        </Bullet>
        <Bullet>{`A turn has at most ${MAX_CLUE_ROUNDS} clues. Then the next player becomes the clue-giver.`}</Bullet>
      </Section>

      <Section title="Two ways to play">
        <Bullet>
          Play on this phone (pass-and-play): one phone is handed from player to player. A hand-off screen says whose
          turn it is, so nobody sees a secret word or someone else's guess by accident.
        </Bullet>
        <Bullet>
          Play over Wi-Fi: every player uses their own phone, all on the same Wi-Fi network. One phone hosts the game
          and the others find it automatically and join. Android phones and iPhones can play together, and no internet
          is needed.
        </Bullet>
        <AppText>The rules and the scoring are the same in both. Over Wi-Fi, a few things work differently:</AppText>
        <Bullet>
          There is no passing around. The clue-giver picks the word and types clues on their own phone, and once a clue
          is accepted all the others guess at the same time. Everyone sees who has guessed, but not what, until every
          guess is in.
        </Bullet>
        <Bullet>
          The host's phone runs the game: it checks and scores every clue with its own word model, so all phones see
          the same result, and the host's Settings apply. Each phone is only ever sent what its player may see.
        </Bullet>
        <Bullet>After each result the host taps to move everyone on.</Bullet>
        <Bullet>
          If the game does not show up in the list, both phones are probably not on the same Wi-Fi. You can also type
          in the address and port shown on the host's lobby screen. An iPhone asks once for permission to use the local
          network: it must be allowed.
        </Bullet>
        <Bullet>
          A player who loses the connection is marked as disconnected and gets their place back when their phone
          reconnects - by itself, or by joining the same game again if the app was closed. Leaving the game on purpose
          gives the place up. Meanwhile the host can skip their guess (it counts as wrong) or end their turn as
          clue-giver, so the game never gets stuck; after a minute without an answer the host can do the same for a
          player who is still connected. If the host leaves, the game ends for everyone.
        </Bullet>
      </Section>

      <Section title="Clue rules">
        <Bullet>One word, letters a to z only, 2 to 20 letters.</Bullet>
        <Bullet>
          {`It may not be, contain, be part of, or be a simple form (plural, -ing, -ed, -er...) of any of the ${OPTIONS_PER_TURN} offered words.`}
        </Bullet>
        <Bullet>You cannot reuse a clue you already tried this turn.</Bullet>
        <Bullet>
          It must be in the built-in noun dictionary (this can be turned off in Settings). Breaking a rule does not count
          as a rejected attempt.
        </Bullet>
        <Bullet>
          {`After ${FORFEIT_AFTER_REJECTIONS} rejected clues in one round, a stuck clue-giver may forfeit: the turn ends, the word is revealed and nobody earns further points that turn.`}
        </Bullet>
      </Section>

      <Section title="Guessing">
        <Bullet>
          In "type any word" mode guessers type their guess and never see the options. In "pick from the five" mode they
          see the five options and tap one.
        </Bullet>
        <Bullet>Capital letters do not matter, and a simple plural counts (cat / cats).</Bullet>
        <Bullet>All accepted clues of the turn stay visible to the guessers.</Bullet>
      </Section>

      <Section title="Scoring">
        <Bullet>Every guesser who names the secret word gets 1 point, and the turn ends.</Bullet>
        <Bullet>
          {`Each time a whole round of guesses fails, the clue-giver's total for the turn rises: ${GIVER_REWARDS[0]} after the first clue, ${GIVER_REWARDS[1]} after the second, ${GIVER_REWARDS[2]} after the third.`}
        </Bullet>
        <Bullet>
          Points already earned are kept. A clue-giver who survives the first clue and is guessed on the second keeps 1
          point.
        </Bullet>
        <Bullet>
          {`The game ends when everyone has been clue-giver the set number of times (${settings.turnsPerPlayer} right now). Highest score wins; equal scores share a place.`}
        </Bullet>
      </Section>

      <Section title="About the similarity score">
        <AppText>
          The score comes from a small BERT-family language model (all-MiniLM-L6-v2) that runs entirely on this phone.
          It turns each word into a list of numbers and measures the angle between the two lists: the raw cosine
          similarity.
        </AppText>
        <AppText>
          {`Honestly: with this model the raw cosine between two different nouns almost never gets near ${scoreGate}. Close synonyms land around 0.8 and unrelated words around 0.2. So the game shows a calibrated score instead. It is a fixed rescaling of the raw cosine, the same for every pair of words:`}
        </AppText>
        <Bullet>{`a raw cosine of ${gate} becomes exactly ${scoreGate};`}</Bullet>
        <Bullet>{`below that, score = ${scoreGate} x raw / ${gate} (never below 0);`}</Bullet>
        <Bullet>{`above that, the remaining raw range up to 1 is spread over ${scoreGate} to 1.`}</Bullet>
        <AppText>
          {`The rescaling never changes which of two pairs is closer; it only relabels the scale. The value ${gate} was measured, not guessed: it is the raw cosine at which about 90% of the game's words still have at least 8 allowed clues. The threshold in Settings (default ${formatThreshold(DEFAULT_SETTINGS.threshold)}) is compared with the calibrated score. The similarity checker always shows the raw cosine next to it.`}
        </AppText>
        <AppText variant="caption" color="muted">
          {`The model judges how words are used in text, not dictionary meaning, so it can be surprising. The app ships a size-reduced (8-bit) copy of the model, which can differ slightly from the reference used for calibration (${CALIBRATION_INFO.generatedAt}); Settings has a self-check that measures the difference on this device.`}
        </AppText>
      </Section>

      <Section title="Word links">
        <AppText>
          The model sometimes misses obvious connections: it rates "root" and "tree" just below the default threshold,
          and "petal" and "flower" well below it. So the game also carries about 80,000 links between its nouns, taken
          from two dictionaries: WordNet (same meaning, kind of, part of, member of, made of, opposites) and ConceptNet
          (common-sense facts such as "a key is used for a lock", plus word associations people gave in a word game).
        </AppText>
        <AppText>
          {`With "Accept linked words" on in Settings (${settings.useWordLinks ? 'it is on now' : 'it is off now'}), a clue below the threshold still counts when such a link joins it to the secret word, as long as the model sees at least some connection (a raw cosine of ${formatRaw(LINK_RAW_FLOOR)} or more). That filters out links that depend on a rare meaning of a word. After the turn, the clue list says which clues counted because of a link.`}
        </AppText>
      </Section>

      <Section title="Credits and licences">
        <AppText>
          Language model: sentence-transformers/all-MiniLM-L6-v2, licensed under Apache-2.0, run on-device with
          ExecuTorch.
        </AppText>
        <AppText>
          Word lists: derived from WordNet 3.1 (Copyright 2011 Princeton University), filtered for common words using
          the SCOWL word lists.
        </AppText>
        <AppText>
          Word links: WordNet 3.1 and ConceptNet 5.7 (conceptnet.io, licensed under CC BY-SA 4.0, which includes data
          from Open Mind Common Sense, Wiktionary and the Verbosity game). The link table is shared under the same
          licence.
        </AppText>
        <AppText variant="caption" color="muted">
          Full licence texts are in THIRD_PARTY_NOTICES.txt, distributed with the app's source.
        </AppText>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bullet: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  bulletDot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  flex: { flex: 1 },
});
