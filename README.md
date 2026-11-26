<img src="assets/icon.svg" width="64" height="64" alt="">

# Similarity Game

A party word game for 2 to 8 players on Android and iOS. One player secretly picks a word and gives
one-word clues; a clue only counts if a language model running **on the phone** agrees that it is close
enough to the secret word. The clue-giver scores when the clue is accepted and the others *still* cannot
guess the word.

It can be played two ways, with identical rules:

- **Play on this phone** (pass-and-play): one phone is handed around.
- **Play over Wi-Fi**: everyone uses their own phone on the same Wi-Fi network. Android phones and
  iPhones can play together. No internet connection and no server are needed for either mode.

Created in [T3 Code](https://t3.codes).

## Rules

A game is a series of turns; every player is the clue-giver the same number of times (1 to 5, default 2).

1. The clue-giver privately sees 5 random nouns and picks one as the secret word.
2. They type a clue: a single noun. It is **accepted** if its similarity score with the secret word
   reaches the threshold (default 0.95, adjustable from 0.80 to 0.99), or if a dictionary links the two
   words (see [Word links](#word-links); can be turned off). A rejected clue shows its score to the
   clue-giver only, and they try another.
3. Once a clue is accepted, every other player privately makes one guess. Nobody sees anyone else's
   guess until all are in; then all guesses are revealed.
4. If somebody named the secret word the turn ends. Otherwise the clue-giver gives another clue. A turn
   has at most 3 clues.

Clue rules: one word, letters a to z, 2 to 20 letters; it may not be, contain, be part of, or be a simple
form (plural, -ing, -ed, -er ...) of any of the 5 offered words; it cannot repeat a clue already tried
this turn; and it must be in the built-in noun dictionary (this check can be turned off in Settings).
Breaking a rule is not a rejected attempt. After 5 rejected clues in one round a stuck clue-giver may
forfeit the turn.

Guessing has two modes: **type any word** (guessers never see the 5 options) or **pick from the five**.
Capital letters do not matter and a simple plural counts.

### Scoring

- Every guesser who names the secret word gets **1 point**, and the turn ends.
- Each time a whole round of guesses fails, the clue-giver's total for the turn rises to **1**, then
  **2**, then **6** (after the first, second and third clue).
- Points already earned are kept: a clue-giver who survives the first clue and is guessed on the second
  keeps 1 point. A forfeit ends the turn with no further points for anyone.
- Highest score wins; equal scores share a place.

## The similarity score, and why it is "calibrated"

The score comes from [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
a small BERT-family sentence-embedding model, run entirely on the device with ExecuTorch (an 8-bit
quantised XNNPACK build, about 23 MB). Each word becomes a vector; the **raw** score is the cosine of the
angle between the two vectors.

With this model the raw cosine between two *different* nouns almost never gets near 0.95: close synonyms
land around 0.8 and unrelated words around 0.2. A game threshold of "0.95" on the raw value would be
unplayable. So the game shows a **calibrated score**: a fixed, monotonic, piecewise-linear rescaling of
the raw cosine that is the same for every pair of words.

| raw cosine | calibrated score |
| --- | --- |
| 0 or less | 0 |
| 0 .. `RAW_GATE` | 0 .. 0.95, linear |
| `RAW_GATE` .. 1 | 0.95 .. 1, linear |

`RAW_GATE` is currently **0.51**. It is measured, not guessed: it is the raw cosine at which about 90% of
the deck's words still have at least 8 valid clues in the noun dictionary. The rescaling never changes
which of two pairs is closer; it only relabels the scale so that "0.95" means "about as close as a good
clue gets". The in-app similarity checker always shows the raw cosine next to the calibrated score, and
Settings has a self-check that measures how far the phone's quantised model is from the reference used
for calibration.

The model judges how words are used in text, not dictionary meaning, so it can be surprising.

## Word links

The model misses some obvious connections, mostly "part of" and "goes with" pairs: tree / root scores
0.948, car / wheel 0.915, key / lock 0.881, flower / petal 0.683. So the app also carries a table of about
80,000 links between its dictionary nouns (`src/data/links.json`, 1.1 MB), built by
`npm run build-links` from two sources:

- **WordNet 3.1**: same meaning, kind of (direct hypernym), part of, member of, made of, opposites and
  noun-to-noun derivations (oboe / oboist), using only each word's common senses.
- **ConceptNet 5.7**: Open Mind Common Sense facts (part of, has, made of, used for, causes, found at),
  word associations from the Verbosity game, and Wiktionary synonyms and related terms.

Each source edge earns evidence points and a pair needs 1 point. Strong edges (any WordNet relation, a
common-sense "part of" fact, a strong Verbosity association) count fully; noisy ones (one Wiktionary
"related term", one "found at" fact, a weak association) count half, so they need something else to
agree. Pairs where one word contains the other are left out (they are not allowed as clues anyway).

With **Accept linked words** on (the default), a clue below the threshold is accepted when such a link
joins it to the secret word **and** the raw cosine is at least `LINK_RAW_FLOOR` (0.25). The floor drops
links that rely on a rare sense of a word ("bread" as money). It was chosen by reading samples of linked
pairs in each cosine band: below 0.25 the share of odd links rises. The similarity checker shows the link
it found, and after a turn the clue list says which clues counted because of a link. In Wi-Fi games the
link is only sent to the clue-giver until the word is revealed, because it names the secret word.

Against human ratings (pairs in the bottom and top thirds of each benchmark, counting a pair as passing
the default threshold), links raise the share of closely related pairs that pass from 64% to 81% on
SimLex-999 nouns, 49% to 81% on MTurk-771 and 37% to 54% on WordSim-353 relatedness. The share of
unrelated pairs that pass rises from 1% to 9% on MTurk-771 and from 18% to 29% on SimLex-999 (mostly
antonyms such as presence / absence, which SimLex rates low by design but are fair clues here).

## Pass-and-play vs Wi-Fi

| | Play on this phone | Play over Wi-Fi |
| --- | --- | --- |
| Phones | one, handed around | one each, same Wi-Fi network |
| Privacy | hand-off screens between players | each phone is only sent what its player may see |
| Guessing | one guesser after another | all guessers at the same time |
| Who scores clues | the phone | the host's phone, for everyone |
| Settings used | the phone's | the host's, read when the game starts |
| Moving on after a result | whoever holds the phone | the host |

How Wi-Fi play works:

- One phone **hosts**. It opens a TCP listener and advertises it with mDNS/Bonjour as `_simgame._tcp`.
  Other phones **discover** it automatically and join the lobby. If discovery finds nothing (some
  networks block mDNS), a player can type the IP address and port shown on the host's lobby screen. On
  Android there is also an "alternative discovery" switch (embedded mDNS responder instead of the
  system's NSD).
- The **host is authoritative**. It runs the same pure game engine as pass-and-play, validates clues and
  scores them with its own model, so every phone sees the same result. Every player, including the
  host's own, receives a per-player *view*: the secret word and the five options go only to the
  clue-giver, rejected clues and their scores go only to the clue-giver, and a guess is not sent to
  anyone else until the round resolves.
- The protocol is newline-delimited JSON with a version field. Every inbound message is validated on
  both sides; a seat is bound to its connection at the handshake, so a client can only act for itself.
  Phones with different protocol versions refuse each other with an "update the app" message.
- **Dropped connections**: heartbeats every 3 s detect a silent peer after about 10 s. A disconnected
  player is marked on every phone and reclaims their seat automatically (reconnect token) when their
  phone is back, including after the app was in the background. The token of the last game joined is
  kept on the phone for a few hours, so joining the same game again also gets the seat back after the
  app was closed; leaving a game on purpose gives the seat up. Meanwhile the host can skip their guess
  (it counts as wrong) or end their turn as clue-giver, and can remove players in the lobby (a player
  who was present when removed cannot rejoin that lobby). After a minute without an answer the host can
  do the same for a player who is still connected. If the host disappears, the other phones try to
  reconnect for about 20 s and then offer to go home; a host that leaves on purpose tells everyone at
  once.
- **Unfriendly peers**: guesses must be one word of the letters a-z, connections that send more than a
  burst of 40 messages (20 per second sustained) are dropped, connections that never say hello cannot
  crowd out players, and one address can hold at most two lobby seats.
- On **iOS** the first use triggers the system's Local Network permission prompt (the app explains this
  first). If it is denied, nothing is found: turn it on under Settings > Privacy & Security > Local
  Network.

Not included: joining a game that is already running (only reconnecting to your own seat), and play
across different networks or over the internet.

## Project layout

```
App.tsx                 state-machine navigation (no router library)
src/game/               pure rules engine: createGame, gameReducer, validateClue, selectors
src/similarity/         on-device embeddings -> raw cosine -> calibrated score; useSimilarity()
src/data/               deck.json (words offered to clue-givers), nouns.json (clue dictionary),
                        links.json + links.ts (WordNet / ConceptNet word links)
src/storage/            AsyncStorage persistence of settings, player names, Wi-Fi name
src/net/                local-network multiplayer core (framework-free)
  transport.ts            contract between sessions and a network
  protocol.ts             message types and validators
  view.ts                 projectView(state, seat): the only place that decides who sees what
  hostSession.ts          authoritative host: lobby, engine, scoring, heartbeats
  clientSession.ts        one player's connection: handshake, reconnect, latest view
  lanAdapter.ts           the real network (TCP + mDNS); the only file that loads native networking
  memoryAdapter.ts        in-memory network for tests
src/ui/
  theme.ts, components/   design tokens and shared controls
  screens/                home, setup, settings, similarity checker, how to play
  game/                   pass-and-play screens; parts.tsx holds the presentational pieces both modes share
  net/                    Wi-Fi screens: entry/discovery, lobby, networked game, connection states
tools/                  calibrate.mjs, fetch-model.mjs, build-links.mjs
assets/model/           the bundled model (.pte) and tokenizer
patches/                patch-package patch for react-native-tcp-socket
app.config.js           release version / build number from the environment, on top of app.json
plugins/                Expo config plugin: Android release signing from the environment
.github/workflows/      ci.yml (type-check + tests), release.yml (APK + IPA + GitHub Release)
```

`src/net/lanAdapter.ts` is deliberately not exported from `src/net/index.ts` and is `require`d lazily by
`src/ui/net/WifiFlow.tsx` the first time something hosts, browses or joins. Pass-and-play and the tests
therefore never load the native networking modules.

## Running it

The app uses native modules (ExecuTorch, TCP sockets, zeroconf), so it needs a **development build**.
It does **not** run in Expo Go.

```sh
npm install                 # also applies patches/ via patch-package
nix-shell                   # optional: JDK 17 + Android SDK/NDK (see shell.nix)
npx expo run:android        # build and install on a connected device or emulator
npx expo run:ios            # macOS with Xcode only
npm start                   # afterwards: start Metro for the installed dev build
```

`nix-shell --arg withEmulator true` also provides an Android emulator and system image. To try Wi-Fi play
you need two devices on the same Wi-Fi network; emulators generally cannot see each other's mDNS
announcements, and need port forwarding even for manual join.

### Requirements

- iOS 17.0 or later.
- Android 8.0 (API 26) or later, `arm64-v8a` or `x86_64`.
- Node.js 24 for the tools (provided by `shell.nix`).

## Releases

Two GitHub Actions workflows live in `.github/workflows/`:

- `ci.yml` runs the type-check and the tests on every push to `main` and every pull request.
- `release.yml` runs the same checks, then builds an Android APK and an iOS IPA in parallel and attaches
  them to a GitHub Release together with a `SHA256SUMS` file.

> The Android half has been built locally with the same commands the workflow uses (release build,
> R8 minification, both signing paths). At the time of writing **the workflows themselves have never
> run on GitHub, and the iOS job has never been run at all** (it needs macOS and Xcode). Expect to fix
> something the first time; the full `xcodebuild` log is uploaded as a workflow artifact when it fails.

### Cutting a release

```sh
git tag v1.2.3            # v<major>.<minor>.<patch>, optionally with a suffix such as v1.2.3-rc.1
git push origin v1.2.3
```

The tag decides the version: `1.2.3` becomes the Android `versionName` and the iOS
`CFBundleShortVersionString`, and the workflow's run number becomes the Android `versionCode` and the
iOS build number (`app.config.js` reads both from the environment; the version in `app.json` is only
the fallback for local builds). A tag with a suffix (`v1.2.3-rc.1`) is published as a pre-release.

The release gets these files:

| File | What it is |
| --- | --- |
| `similarity-game-<version>.apk` | Android, `arm64-v8a`, signed with the release keystore |
| `similarity-game-<version>-debugkey.apk` | the same, when no keystore is configured (see below) |
| `similarity-game-<version>-unsigned.ipa` | iOS, not code-signed |
| `SHA256SUMS` | checksums: `sha256sum -c SHA256SUMS --ignore-missing` |

If one platform fails to build, the other one is still released, the release notes say which file is
missing, and the run is marked as failed. Fix the cause and choose **Re-run failed jobs** on the run:
only the failed platform is rebuilt and its file is added to the same release. If the tests fail or
both platforms fail, no release is made.

### Running it by hand

**Actions > Release > Run workflow** (or `gh workflow run release.yml -f version=1.2.3`). Inputs:

- **version**: optional. Empty means the version in `app.json` (or the tag, if the run is started from
  a tag).
- **draft** (on by default): the release is created as a draft that only maintainers can see, and no
  tag is created until you publish it from the Releases page. Untick it to publish straight away; the
  tag `v<version>` is then created at the commit the run was started from. Publishing a draft creates
  the tag, which starts one more run of the workflow: it sees that the release already has both files
  and finishes after the tests without building or replacing anything.
- **prerelease**: mark the release as a pre-release.

Every run also keeps the APK and the IPA as workflow artifacts for 30 days (bottom of the run's summary
page; downloading them needs a GitHub login). A manual run refuses to reuse a tag that already points
at a different commit. Running it again for a version that so far only has a draft release replaces
the draft's files and moves the draft to the new commit; files from the earlier run that the new run
did not produce (for example a `-debugkey` APK once a keystore is configured) are removed.

### Android signing key (optional, recommended)

With no secrets configured the APK is signed with the Android **debug key** that ships with every Expo
project. It installs fine, but that key is public: anybody can sign an "update" with it, and once you
switch to a real key, people must uninstall the debug-key build before the new one installs. Such
builds are labelled `-debugkey` in the file name and in the release notes.

To sign with your own key, create a keystore once:

```sh
keytool -genkeypair -v -storetype PKCS12 \
  -keystore similarity-game-release.jks -alias similarity-game \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Similarity Game"
base64 -w0 similarity-game-release.jks > keystore.b64    # macOS: base64 -i similarity-game-release.jks | tr -d '\n' > keystore.b64
```

and add these repository secrets (**Settings > Secrets and variables > Actions**, or `gh secret set`):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the contents of `keystore.b64` (`gh secret set ANDROID_KEYSTORE_BASE64 < keystore.b64`) |
| `ANDROID_KEYSTORE_PASSWORD` | the password you gave `keytool` |
| `ANDROID_KEY_PASSWORD` | optional; only if the key has a different password from the keystore |

The key alias is not a secret. The workflow uses `similarity-game` (the alias in the command above);
for a keystore with another alias, set the repository **variable** `ANDROID_KEY_ALIAS`
(`gh variable set ANDROID_KEY_ALIAS -b my-alias`). Do not store the alias as a secret: GitHub would
then mask it out of every file name in the logs.

Then delete `keystore.b64` and keep the keystore and its password somewhere safe outside the
repository. If the keystore is lost, nobody can update an installed copy: every user has to uninstall
and reinstall. The workflow checks the certificate of the finished APK and fails if it is not the one
it expected.

The workflow builds the APK without the key and signs it afterwards with `apksigner`, in a step that
runs no project code, so build tools and dependencies never see the keystore or its password. Local
builds can sign with the same key: `plugins/withAndroidReleaseSigning.js` makes the generated Gradle
project read `ANDROID_KEYSTORE_FILE` (an absolute path), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when it builds. With none of them set, local builds
behave exactly as before.

### Installing the APK

Download the `.apk` on the phone (Android 8.0 or later, 64-bit ARM, which is practically every phone
from the last several years), open it, and allow the browser or file manager to "install unknown apps"
when Android asks. From a computer: `adb install similarity-game-<version>.apk`. The release APK does
not contain `x86_64` code, so it does not install on most emulators; use `npx expo run:android` there.

### Installing the unsigned IPA

The IPA is built with code signing switched off, because signing for distribution needs a paid Apple
Developer account. It **cannot** be installed as it is, and Xcode or Apple Configurator will reject
it. Sign it with your own Apple ID using one of these tools, which all work with a free Apple ID:

- [AltStore](https://altstore.io) or [SideStore](https://sidestore.io): install the tool, then open the
  `.ipa` with it on the phone.
- [Sideloadly](https://sideloadly.io) (Windows or macOS): connect the phone and drop the `.ipa` on it.

Things to know:

- It needs **iOS 17.0 or later**.
- With a free Apple ID the signature lasts **7 days**. After that the app stops opening until the same
  tool refreshes it (AltStore and SideStore can do this in the background); the app's data is kept.
  A free Apple ID can also keep only 3 sideloaded apps active on a device.
- The tool usually changes the app's bundle identifier (AltStore appends your team ID). The app does
  not depend on it.
- Wi-Fi play needs no special entitlement, only the Local Network permission prompt described above.
- TrollStore only supports iOS up to 17.0, so with this app's minimum of iOS 17.0 it is an option on
  iOS 17.0 exactly, and it has not been tried.

## Tests

```sh
npm test            # jest: engine, similarity, storage, network sessions, UI flows
npm run typecheck   # tsc --noEmit
```

The network core is tested against `memoryAdapter` (full games for 2, 3 and 8 players, a per-seat leak
test for every phase, hostile and malformed peers, drops and reconnects). The Wi-Fi UI tests render
several app instances on one in-memory network and check what each phone shows. Nothing in the test
suite uses a real socket or the real model.

## Calibration tool

```sh
npm run calibrate           # recompute RAW_GATE and prune unplayable deck words
npm run calibrate -- --dry-run
npm run fetch-model         # re-download and verify the bundled model assets
npm run build-links         # rebuild src/data/links.json from WordNet and ConceptNet
```

`tools/calibrate.mjs` runs the fp32 ONNX export of the same weights in Node (downloaded to `.cache/`),
embeds every dictionary and deck word, picks the raw cosine at which about 90% of deck words still have
at least 8 valid clues, writes `src/similarity/calibration.generated.json`, and removes deck words that
have fewer than 3 valid clues at that gate. Re-running it is idempotent.

`tools/build-links.mjs` downloads WordNet 3.1 (12 MB) and the ConceptNet 5.7 assertions dump (475 MB)
into `.cache/links/`, checks both against pinned SHA-256 hashes, and writes `src/data/links.json`
(see [Word links](#word-links)). Run it again after changing `nouns.json`: links are stored by noun index.

## Licences

- Language model: [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
  Apache-2.0; ExecuTorch build from
  [software-mansion/react-native-executorch-all-MiniLM-L6-v2](https://huggingface.co/software-mansion/react-native-executorch-all-MiniLM-L6-v2).
- Word lists: derived from WordNet 3.1 (Copyright 2011 Princeton University), filtered for common words
  with the SCOWL word lists.
- Word links (`src/data/links.json`): derived from WordNet 3.1 and from
  [ConceptNet 5.7](https://conceptnet.io/) (CC BY-SA 4.0; includes Open Mind Common Sense, Wiktionary
  and Verbosity data). As a derivative of ConceptNet, `links.json` is licensed under CC BY-SA 4.0.
- Full licence texts are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Dependencies carry their
  own licences in `node_modules`.

No licence has been chosen for the game's own source code yet.
