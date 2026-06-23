# Rocket League 2D Pro Online V8

V8 ist die große Netcode-Version:

- Server-authoritative Multiplayer: Der Server berechnet Autos, Ball, Tore, Timer und Bots.
- Kein Host-Physik-Vorteil mehr: Alle Spieler senden nur Eingaben zum Server.
- Client-Prediction + Smooth-Sync bleiben aktiv, damit sich das eigene Auto direkter anfühlt.
- Garage: Auto-Farbe, Boost-Farbe, Lack und Boost-Stil.
- Mehr Lobby-Einstellungen: Spielzeit, Torlimit, Boost, Bot-Stärke, Spieltempo, Ballgefühl und Touch-Assist.
- TAB im Spiel halten: Scoreboard mit Score, Goals, Assists, Saves, Shots und Ping.
- Deutscher Schnellchat mit 1-4 und eigener Chat mit G.

## Start

```bash
npm install
npm start
```

Dann öffnen:

```text
http://localhost:3000
```

## Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Hinweis: Render Free kann trotzdem kleine Pings/Cold Starts haben. V8 entfernt aber den großen Host-Vorteil, weil nicht mehr der Host-Browser die Physik berechnet.
