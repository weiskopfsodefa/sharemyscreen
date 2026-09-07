# sharemyscreen

Bildschirm vom Windows-Laptop live auf ~10 Android-Tablets streamen – z. B. in einer Kneipe.
Gehostete Web-App, **das Video läuft aber P2P direkt im lokalen WLAN** (WebRTC-Fanout).
Der Server macht nur UI, Raumverwaltung und Signaling – er überträgt kein Video.

```
Website laden:        Internet
Signaling/WebSocket:  Internet, geringe Bandbreite
Video:                P2P im WLAN (Host -> jedes Tablet einzeln)
```

## Lokal starten

```bash
npm install
npm start          # http://localhost:3000
npm run smoke-test # Signaling-Tests
npm test           # Reconnect-Regressionstests mit simulierten Ausfällen
```

Hinweis: `getDisplayMedia()` braucht einen sicheren Kontext. `http://localhost` zählt als
sicher – für Tests mit echten Tablets muss die App aber über **HTTPS** erreichbar sein
(deployen, siehe unten).

## Benutzung

1. Host öffnet die Seite und klickt **Raum starten** (`/host`) – die URL springt
   auf `/CODE`. **Host-URL = Beitritts-URL**: Wer den Host-Token im Browser hat
   (localStorage), bekommt unter `/CODE` die Regie, alle anderen den Stream.
2. **Bildschirm teilen** klicken, Bildschirm/Fenster auswählen.
3. Tablets scannen den QR-Code (`/CODE`, alte `/v/CODE`-Links gehen weiter) –
   Stream startet automatisch, Vollbild-Button unten rechts, Wake Lock hält das
   Display an.
4. Host sieht pro Tablet: Status, **Verbindungsweg (LOKAL / DIREKT / RELAY)**,
   Bitrate, fps, Paketverlust, Ping. Bei RELAY warnt die App – dann läuft das
   Video übers Internet statt lokal.

## Deployment

Braucht dauerhafte WebSockets – also ein „echter“ kleiner Node-Server
(Fly.io, Railway, Render, Hetzner, DigitalOcean), **nicht** Vercel/Netlify-Functions.
HTTPS/WSS übernimmt der Anbieter.

```bash
# Beispiel Fly.io
fly launch --no-deploy   # erkennt das Dockerfile
fly deploy
# Danach eigene Domain (sharemyscreen.de) als Custom Domain + Zertifikat hinzufügen
```

Konfiguration: `PORT` (Default 3000) und `HOST_TOKEN_SECRET` (beliebige zufällige
Zeichenkette). Das Secret signiert die Host-Tokens – es muss über Neustarts stabil
bleiben, sonst verlieren Hosts ihre dauerhaften Raum-Codes. `render.yaml` erzeugt es
automatisch (`generateValue`); bei manuell angelegten Diensten in der Umgebungs-Konfiguration
des Anbieters setzen. Kein Build-Schritt.

## Empfehlung fürs Event

- Eigener Wi-Fi-6-Router, Laptop per **LAN-Kabel** an den Router, Tablets in dessen WLAN.
- **Client-/AP-Isolation am Router ausschalten** – sonst dürfen Geräte nicht direkt
  miteinander reden und WebRTC findet keinen lokalen Weg.
- Vorher mit 1, 3, 5, 10 Tablets testen und auf der Host-Seite prüfen,
  dass überall **LOKAL** steht.

## Technik / Grenzen (MVP)

- Vor dem Teilen wählt der Host eine **Priorität**: **„Flüssige Bewegung“** (Standard,
  für Videos) oder **„Hohe Bildschärfe“** (für Text/Präsentationen). Die Auswahl wird
  gespeichert und bleibt während der Übertragung gesperrt; zum Wechseln erst stoppen.
  Bewegungsmodus nutzt `motion`/`maintain-framerate`, Detailmodus `detail`/`maintain-resolution`.
- Qualität per Dropdown, Standard **„Automatisch“**: startet bei 1080p/30 und regelt
  pro Tablet anhand von Paketverlust und Drossel-Ursache. Bewegung reduziert zuerst
  die Auflösung (nativ/30 → 1080p/30 → 720p/30 → 540p/30 → 540p/15); Bildschärfe
  reduziert zuerst fps (nativ/30 → nativ/15 → 1080p/30 → 1080p/15 → …).
  Feste Presets behalten unabhängig von der Priorität ihre fps-/Auflösungsgrenzen.
  Gecaptured wird nativ mit bis zu 30 fps; Skalierung und Bitrate wirken pro Tablet
  live ohne Neustart (`QUALITY_PRESETS`/`STREAM_MODES` in `public/js/host.js`).
- ICE nur mit STUN, **bewusst kein TURN** – damit Video nie unbemerkt übers Internet läuft.
- **Raum-Codes sind dauerhaft**: Der Host-Browser merkt sich Code + Token in
  localStorage; existiert der Raum serverseitig nicht mehr (Deploy, Neustart,
  Spin-Down), legt der Reclaim ihn mit demselben Code neu an. Tablets versuchen
  es bei „Raum nicht aktiv“ automatisch alle 10 s erneut. Host-Tokens sind per
  HMAC mit `HOST_TOKEN_SECRET` signiert – fremde Clients können einen (z. B.
  gedruckten) Code nach einem Neustart nicht übernehmen.
- Kein SFU/Medienserver. Wenn 10 Tablets per P2P nicht stabil laufen, ist das die
  nächste Ausbaustufe.

## Wiederverbindung

- Ein WebSocket-Abbruch beendet keine funktionierende P2P-Videoverbindung.
  Das gilt auch, wenn der Raum während eines längeren Serverausfalls abläuft.
- Ohne Video wiederholen Tablets den Beitritt alle 10 Sekunden; nach einem
  erkannten Videoabbruch zunächst nach 2 Sekunden. Eine reine Beitrittsbestätigung
  beendet die Wiederholungen noch nicht. Ein neuer Aufbau hat 20 Sekunden Zeit.
- Der Host versucht fehlgeschlagene Verbindungen ebenfalls erneut und begrenzt
  einen hängenden Aufbau auf 25 Sekunden. Kurze WebRTC-Unterbrechungen bekommen
  eine Erholungsfrist (Tablet 4 Sekunden, Host 8 Sekunden).
- Jeder Aufbau trägt eine eigene Kennung, damit verspätete Antworten und
  ICE-Kandidaten keinen neueren Versuch beschädigen. SDP wird vor ICE gesendet.
- Ein Anwendungs-Heartbeat erkennt auch scheinbar offene, nicht mehr antwortende
  WebSockets; der Client verbindet sich mit bis zu 10 Sekunden Abstand erneut.

`npm test` prüft diese Zustandsübergänge mit kontrollierten Timern und simulierten
WebRTC-/WebSocket-Schnittstellen. Echte WLAN-Störungen und Medienwiedergabe müssen
zusätzlich mit den Zielgeräten getestet werden. Nach einem Update Host und Tablets
neu laden, damit alle dieselbe Signaling-Version verwenden.
