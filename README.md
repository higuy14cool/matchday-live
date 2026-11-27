# Matchday Live

Tournaments, fixtures, live scoreboards and a phone-camera stream for **soccer** and **basketball**.
One small Node server, no build step, no database to install.

![two sports](https://img.shields.io/badge/sports-soccer%20%7C%20basketball-9ae64b)

## What it does

- **Tournaments** – a 3-step wizard: name and sport, then 3 to 80 team names, then the format (1–16 groups, single/double round robin or straight knockout, and final-only, semifinals or quarterfinals).
- **Custom groups** – after the team list you can put each team in a group yourself; if you do not, teams are split evenly.
- **Placement matches** – optionally add a third-place match when the format has semifinals or quarterfinals, and a 5th/6th place match when there are enough teams left.
- **Quick games** – a standalone game between two teams, outside any tournament, from the home page.
- **Fixtures** – group games are generated automatically when the tournament is created; knockout games (quarterfinal, semifinal, final) are created once the qualifiers are known.
- **Automatic progression** – quarterfinal winners meet in the semifinals, semifinal winners go to the final, semifinal losers go to the third-place match, and the next two teams play for 5th/6th. Every game has a *Change teams* control while it is still scheduled, so you can set a semifinal matchup by hand; the result still moves on the same way.
- **Standings** – a table per group (P, W, D, L, goals/points for and against, goal difference, points) with the qualifying places highlighted.
- **Live scoreboard** – score, fouls/cards, period clock, undo and a play-by-play feed. Every change is pushed to all viewers over a WebSocket, so phones in the stands stay in sync.
- **Final scores** – enter the result and tick “This is the final score” to finish the game, stop the clock, and let the bracket fill the next round in one step.
- **Big scoreboard** – a full-screen board (`#/g/<id>/board`) for a projector or a second screen, with a fullscreen button.
- **Live video** – the organizer can go live from the phone camera (WebRTC, peer to peer) or embed a YouTube/Twitch link. The scoreboard overlays the video.
- **Accounts and roles** – the site asks you to sign in first. Admins create tournaments and games, record results, go live and manage accounts; viewers can only watch, read the stats and follow a live game.
- **Full screen while filming** – the admin filming a game gets a **⛶ Full screen** button next to the camera controls. The video, the referee bar and the call overlays fill the screen; the button turns into **⤢ Exit full screen**.
- **Penalty shootouts** – in a knockout game, after extra time (2nd half → ET 1 → ET 2) the next clock step offers **Penalty shootout**. From then on, adding or removing a goal counts a penalty instead of a match goal, the scoreboard shows a **Pens 3–2** pill, and the big board shows it too. **← Leave penalties** goes back if you pressed it by mistake.
- **Penalty-only games** – tick *Penalty shootout only (no clock)* when creating a soccer game (quick game or tournament game) to start straight in a shootout with no match clock.
- **Scoreboard on the video** – while a game is live (or a recording is playing) the score, period and clock sit in the **top-left corner of the picture**, like a broadcast score bug. They follow the scoreboard in real time.
- **Replays of finished games** – while the admin films, the browser records the camera and uploads it when the stream stops or the game ends. The game page then shows the **▶ Replay** player to everyone, including viewers of a finished game. Games with a recording carry a **▶ Replay** note in the tournament fixture list. Deleting a game deletes its video too.
- **Deleting games** – the organizer can delete a game from its page (**🗑 Delete game** in the controls) or from the **🗑** button next to each fixture in a tournament. The game, its score and its events go; a one-game quick tournament goes with it. Viewers never see the button.
- **Referee bar while filming** – on a live game the admin gets a row of buttons under the video: VAR, yellow card, red card, second yellow → red, add a goal, subtract a goal. Each one asks who it is for (team and player, or a VAR description), then the call appears in the video's left corner for every viewer. Goals change only the scoreboard. Viewers never receive these buttons.
- **Accounts page** (`#/users`) – the admin makes a username and password for each viewer, so they can sign in on their own computer; deleting an account signs that viewer out at once.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Node 18 or newer. For development with auto-restart: `npm run dev`.
Tests: `npm test` (spins up a throwaway server and data directory).

Optional environment variables:

| Variable   | Default      | Meaning                                   |
| ---------- | ------------ | ----------------------------------------- |
| `PORT`     | `3000`       | HTTP port                                 |
| `HOST`     | `0.0.0.0`    | bind address                              |
| `DATA_DIR` | `./data`     | where `db.json` is written                |

Data lives in a single JSON file (`data/db.json`), written atomically and debounced. Back it up by copying that file.

## Signing in

The app opens on a sign-in page; nothing else is reachable without a session, and the WebSocket refuses anonymous listeners too.

The first admin is created on first start from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, defaulting to `higuy14/cool` / `favgame1` — change it with those variables before you expose the app. After that, add every viewer from **Accounts** in the header (or `POST /api/users`): username, password and role. Admins can also delete accounts and change their own password; a removed viewer loses their session immediately.

Sessions are held in memory with an HttpOnly, SameSite=Lax cookie, so restarting the server signs everyone out. Passwords are hashed with scrypt and a per-user salt.

## Try the demo

With no tournaments yet, the home page shows **Load demo data** (admin only, or call `POST /api/demo`). It seeds a basketball league and a soccer cup with teams, games and one live game each.

## Live video notes

- Phone camera streaming needs **HTTPS or localhost** (browser rule for `getUserMedia`). On a LAN, put the app behind a TLS proxy or use a tunnel.
- One broadcaster per game; if a second organizer goes live, the first is stepped down and viewers switch to the new stream.
- Embedded links need no camera and work for any number of viewers, but only while no one is broadcasting from a camera.
- Video is peer to peer (WebRTC); the server only relays signalling messages.
- The broadcaster's browser records the camera with `MediaRecorder` (WebM) and uploads it to `/api/games/:id/recording` when the stream stops, when the game ends, or on page close. Files live in `DATA_DIR/recordings/<game-id>.webm` and are served by `GET /api/games/:id/recording` (signed-in accounts only, seekable).
- Recordings are typically 1–2 GB per hour. The upload is streamed to disk, never buffered in memory, so disk space is the limit to watch.
- Chrome reports an unknown duration for recorded WebM; the replay player scans it once on load so the seek bar and length show correctly.

## API at a glance

Reading needs any signed-in account. Every write needs an **admin** session; viewers get `403`. Sign in with `POST /api/auth/login` (`{"username","password"}`) and send the returned session cookie with later calls.

| Method   | Path                    | Purpose                                |
| -------- | ----------------------- | -------------------------------------- |
| `POST`   | `/api/auth/login`       | sign in (rate limited)                  |
| `POST`   | `/api/auth/logout`      | sign out                                |
| `GET`    | `/api/auth/me`          | who am I                                |
| `POST`   | `/api/auth/password`    | change your own password                |
| `GET`    | `/api/users`            | list accounts (admin)                   |
| `POST`   | `/api/users`            | create an account (admin)               |
| `DELETE` | `/api/users/:id`        | remove an account (admin)               |

| Method   | Path                                   | Purpose                          |
| -------- | -------------------------------------- | -------------------------------- |
| `GET`    | `/api/health`                          | status + supported sports        |
| `GET`    | `/api/tournaments`                     | list tournaments                 |
| `POST`   | `/api/tournaments`                     | create with teams + format (admin) |
| `POST`   | `/api/quick-games`                     | create a standalone two-team game |
| `GET`    | `/api/quick-games`                     | recent quick games               |
| `GET`    | `/api/tournaments/:id`                 | tournament, teams, games         |
| `PATCH`  | `/api/tournaments/:id`                 | rename / change sport            |
| `DELETE` | `/api/tournaments/:id`                 | delete tournament and its games  |
| `POST`   | `/api/tournaments/:id/teams`           | add team                         |
| `POST`   | `/api/tournaments/:id/fixtures`        | round-robin fixture list         |
| `POST`   | `/api/tournaments/:id/games`           | create a game (scheduled or live) |
| `GET`    | `/api/live`                            | games currently in play          |
| `GET`    | `/api/games/:id`                       | game + teams                     |
| `POST`   | `/api/games/:id/events`                | goal / minus_goal / score / card / VAR / foul |
| `PATCH`  | `/api/games/:id`                       | change teams, venue or status    |
| `POST`   | `/api/games/:id/undo`                  | undo last event                  |
| `POST`   | `/api/games/:id/score`                 | set the score outright (and `pens` in a shootout) |
| `DELETE` | `/api/games/:id`                       | delete a game (admin only)       |
| `POST`   | `/api/games/:id/clock`                 | start / pause / reset / next     |
| `POST`   | `/api/games/:id/stream`                | set or clear an embed URL        |

Creating a game accepts `"live": true` to set it live and start the clock right away; the default is a scheduled game. It also accepts `"stage"`: `group`, `qf`, `sf`, `third`, `final` or `placement`; the stage is checked against the tournament's format (a final-only tournament refuses a quarterfinal).

`PATCH /api/games/:id` with `{"homeTeamId": "...", "awayTeamId": "..."}` changes who plays a scheduled knockout game (group games and games that have started keep their teams).

During a penalty shootout `POST /api/games/:id/score` also takes `"pens": {"home": 3, "away": 2}`; `GET /api/games/:id` reports `shootout: {active, home, away}` and `shootoutOnly`.

Set a score with `POST /api/games/:id/score` and `{"home": 3, "away": 1, "final": true}` to store the final result and finish the game. Finishing a group round or a knockout round creates the next games automatically.

A tournament can be created in one request:

```json
POST /api/tournaments
{
  "name": "Sunday Cup",
  "sport": "soccer",
  "teams": [
    { "name": "Riverside FC", "group": 0 },
    { "name": "Northside United", "group": 1 },
    { "name": "Harbour City", "group": 0 },
    { "name": "Hilltop Rovers", "group": 1 }
  ],
  "format": { "groups": 2, "groupStage": "single", "knockout": "semifinal", "advancePerGroup": 1, "thirdPlace": true, "placement": false }
}
```

Teams can also be plain names (`"teams": ["A", "B", "C"]`), in which case they are split evenly across the groups. Group numbers start at 0.

`groupStage` is `single`, `double` or `none`; `knockout` is `none`, `final`, `semifinal` or `quarterfinal`. `thirdPlace` is honoured for semifinal and quarterfinal formats; `placement` (the 5th/6th place game) needs a group stage and at least two teams beyond the knockout bracket.

WebSocket: `ws://<host>/ws`. Send `{"type":"subscribe","gameId":"gm_…"}` to join a game room; the server pushes `game`, `presence`, `onair`, `viewer-joined` and relayed `signal` messages.

## Layout

```
server/   express app, JSON store, gameplay rules, WebSocket hub
public/   plain ES modules + CSS (no bundler)
test/     node:test suites for the REST API and the live layer
```

## Recordings API

| Method | Path                         | Purpose                                            |
| ------ | ---------------------------- | -------------------------------------------------- |
| `PUT`  | `/api/games/:id/recording`   | admin: upload the recording (`video/webm` body, `?duration=` seconds) |
| `POST` | `/api/games/:id/recording`   | same, used by `sendBeacon` when the tab closes      |
| `GET`  | `/api/games/:id/recording`   | any signed-in account: stream the video (Range supported) |

`GET /api/games/:id` and the game lists report `recording: {available, duration, size, savedAt}`.

## Known limits

- Sessions live in memory: a restart signs everyone out (accounts themselves persist in `db.json`).
- Anyone with an admin account can change any tournament; there is no per-tournament ownership.
- The JSON store is single-process; it is fine for a club or a school, not for a fleet of servers.
- Camera streams are peer to peer, so a very large audience needs an embedded stream or an SFU.
- A recording is kept while it is being made: closing the tab mid-broadcast tries a final `sendBeacon` upload, but a crash can lose the last few seconds. Re-recording a game replaces its previous video.
- Recordings stay on the server's disk; back `DATA_DIR` up if the videos matter.
