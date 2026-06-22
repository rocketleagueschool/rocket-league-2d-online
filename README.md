# Rocket League 2D Online V2

Verbesserte Online-Version mit:

- Namen festlegen, bevor man Räume erstellt oder beitritt
- Raum erstellen mit Code
- Öffentliche Raumliste zum Durchblättern und Beitreten
- Raum per Code beitreten
- Host kann Modus auswählen
- Ready-System: alle Teilnehmer müssen bereit sein
- Modi:
  - 1v1 Spieler gegen Spieler
  - 2v2 Menschen vs 2 gute Bots
  - 3v3 Menschen vs 3 gute Bots
  - 4v4 Menschen vs 4 gute Bots
- Host-Browser simuliert das Spiel, Render/Socket.IO verbindet alle Spieler

## Render Einstellungen

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Wichtig beim Upload zu GitHub

Die Struktur muss genau so sein:

```text
server.js
package.json
README.md
public/index.html
```

Nicht die ZIP-Datei hochladen, sondern den Inhalt entpackt hochladen.
