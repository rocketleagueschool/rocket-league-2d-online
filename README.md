# Rocket League 2D Online

Online-1v1-Version mit Host-Prinzip:
- Host erstellt einen Raum und simuliert die Spielphysik im Browser.
- Gast tritt per Code bei und sendet seine Eingaben an den Host.
- Der Host sendet 30 Mal pro Sekunde den Spielzustand an den Gast.

## Lokal starten

```bash
npm install
npm start
```

Dann öffnen:

```text
http://localhost:3000
```

## Online spielen

1. Projekt zu Render oder Railway hochladen.
2. Start Command: `npm start`
3. Port: wird automatisch über `process.env.PORT` genutzt.
4. Öffentliche URL öffnen.
5. Host: `Online-Raum erstellen` drücken.
6. Gast: Code eingeben oder kopierten Link öffnen und `Raum beitreten` drücken.

## Steuerung

Host / Blau:
- WASD
- Shift für Boost

Gast / Orange:
- WASD oder Pfeiltasten
- Shift oder Enter für Boost
