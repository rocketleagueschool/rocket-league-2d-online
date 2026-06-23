# Rocket League 2D Pro Online V9

V9 fokussiert sich auf bessere Online-Performance:

- Server-authoritative Multiplayer bleibt aktiv: kein Host-Physik-Vorteil
- 60 Hz Snapshot-Sync vom Server für flüssigere Remote-Bewegung
- WebSocket-first Verbindung im Browser
- verbesserte Client-Prediction für das eigene Auto
- sanftere Server-Reconciliation statt hartem Zurückziehen
- Input-Sequenzen mit Acknowledge vom Server
- stabilere Ping/Jitter-Anzeige
- Garage/Cosmetics, Quickchat, TAB-Scoreboard und Lobby bleiben drin

## Start

```bash
npm install
npm start
```

Render:

```text
Build Command: npm install
Start Command: npm start
```

Hinweis: Online-Lag kann nie vollständig verschwinden. V9 reduziert den gefühlten Delay, aber die beste Wirkung bekommst du zusätzlich mit einem Server in eurer Nähe und ohne Free-Cold-Starts.
