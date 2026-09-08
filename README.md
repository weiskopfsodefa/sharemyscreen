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

## Lokaler Medienserver (optional)

Vor dem Start gibt es zwei unabhängige Einstellungen: **Übertragungsweg**
(Direkt / Lokaler Medienserver) und **Priorität** (Bewegung / Bildschärfe).
`npm start` und das bestehende Deployment bleiben standardmäßig im Direktmodus;
LiveKit ist dafür nicht erforderlich. Auf der gehosteten Seite verweist der
Medienserver-Modus auf die lokale Host-Seite. Es wird keine unsichere Verbindung
von einer öffentlichen HTTPS-Seite zu einem lokalen HTTP-Dienst vorausgesetzt.
Die lokalen Räume und ihre QR-Codes sind unabhängig von den gehosteten Räumen.

### Einmalige Einrichtung auf dem Host

Benötigt werden Node.js ab Version 20, dieses Repository (`npm ci`) und
[LiveKit Server](https://docs.livekit.io/transport/self-hosting/local/).
Auf den Tablets wird **nichts installiert**.

- **macOS:** `brew install livekit`
- **Windows:** das zur CPU passende ZIP der
  [offiziellen Releases](https://github.com/livekit/livekit/releases/latest)
  entpacken. `livekit-server.exe` in den PATH aufnehmen oder `LIVEKIT_BIN` auf
  den absoluten Pfad der EXE setzen.

### Starten

```bash
npm run start:local
```

Alternativ `start-local.command` (macOS) bzw. `start-local.cmd` (Windows) öffnen.
Der Starter startet **LiveKit und unsere Web-App zusammen**. Danach am Host
[localhost:3210/host](http://localhost:3210/host) öffnen, „Lokaler Medienserver“
auswählen und Bildschirm teilen. Die Tablets scannen den dort angezeigten QR-Code.
Die Host-Adresse `localhost` ist absichtlich anders als die LAN-Adresse im QR-Code.
Zum Beenden im Starter Strg+C drücken; beide Prozesse werden beendet.

Bei mehreren Netzwerkadressen nennt der Starter die möglichen Adressen und
fordert eine Auswahl. Die Adresse des LAN-/WLAN-Adapters angeben, über den die
Tablets erreichbar sind (nicht die VPN-Adresse):

```bash
# macOS / Linux
LOCAL_MEDIA_IP=192.168.1.20 npm run start:local
```

```powershell
# Windows PowerShell; Beispielpfade/-adresse durch eigene Werte ersetzen
$env:LIVEKIT_BIN = 'C:\LiveKit\livekit-server.exe'
$env:LOCAL_MEDIA_IP = '192.168.1.20'
npm run start:local
```

Im privaten Netzwerk müssen TCP **3210, 7880, 7881** und UDP **7882** zum Host
zugänglich sein. Kein Portforwarding zum Internet einrichten. Host möglichst
per LAN-Kabel anschließen und Client-Isolation am Router ausschalten.

### Lokalbetrieb und HTTPS

Der Standardstarter verwendet HTTP/WS im **vertrauenswürdigen privaten LAN**.
Der Host öffnet `localhost` als sicheren Browserkontext für die Bildschirmfreigabe;
Tablets empfangen ausschließlich Video über ihre LAN-Adresse. Das funktioniert
ohne Zertifikatsinstallation; im Browser kann die Seite als „nicht sicher“ markiert
sein. Der WebRTC-Medienverkehr ist verschlüsselt, die HTTP-Seite und Signaling-
Zugangstokens sind im Standardbetrieb jedoch nicht durch TLS geschützt.
Wake Lock ist auf HTTP-Empfängern möglicherweise nicht verfügbar; Display-Timeout
am Tablet entsprechend einstellen. Manche verwalteten Browser verlangen HTTPS.

Für solche Netze unterstützt die App `TLS_CERT` und `TLS_KEY` (PEM-Dateien).
Das Zertifikat muss für `localhost` und die gewählte LAN-Adresse gelten und von
allen Geräten akzeptiert werden. Der Starter zeigt dann HTTPS-URLs an, und die
App führt LiveKit-Signaling durch einen lokalen WSS-Proxy. Zertifikate bzw.
Vertrauensanker werden **nicht automatisch installiert**. Der Link von der
gehosteten Seite verwendet standardmäßig HTTP; bei TLS die ausgegebene HTTPS-
Host-Adresse direkt öffnen.

LiveKit wird mit privater Serveradresse, ohne externes IP-Discovery und ohne
TURN betrieben. Die Medienclients verwenden keine öffentlichen STUN-Server.
SDK und Oberfläche werden lokal ausgeliefert; lokale Seiten laden keine Webfonts
aus dem Internet. Nach Installation ist für den Medienserver-Modus kein Internet
nötig. Im Direktmodus bleibt die bisherige STUN-Konfiguration bestehen.

### Qualität und Grenzen dieser ersten SFU-Version

- Ein VP8-Videostream ohne Simulcast/zusätzlichen Backup-Codec für alle Tablets.
  „Automatisch“ startet mit bis zu **720p / 30 fps / 2 Mbit/s** und steigt nach
  jeweils 30 Sekunden stabiler Messwerte bis zur **nativen Quellauflösung / 30 fps**
  (maximal 6 Mbit/s). Die Quelle bleibt nativ, nur der Encoder skaliert herunter.
  Bei anhaltender CPU-/Bandbreitenbegrenzung, Paketverlust über 3 % oder deutlich
  weniger decodierten als gesendeten Frames senkt die Automatik die gemeinsame Stufe.
  Bewegung priorisiert FPS, Bildschärfe priorisiert Auflösung. Fehlende Messwerte
  verhindern Aufstiege; nach gescheiterten Aufstiegen wächst die Wartezeit bis 5 Minuten.
  Ein schwaches Tablet kann damit die Qualität aller Empfänger senken. Zielstufe und
  tatsächlich empfangene Auflösung werden getrennt angezeigt. Nativ meint die vom
  Browser gelieferte Quellauflösung, nicht eine künstliche Vergrößerung.
- Feste Presets gelten gemeinsam für alle Empfänger. Qualität und Übertragungsweg
  sind während des Streams gesperrt. Zum Wechseln stoppen und neu starten.
- Zehn Tablets erhalten weiterhin zehn Kopien über das WLAN; reduziert wird die
  Anzahl der vom Host-Browser erzeugten Streams. Ein langsamer Empfänger bekommt
  noch keine eigene Auflösungsvariante.
- Die Geräteliste zeigt pro Tablet empfangene Bitrate, decodierte fps, Auflösung
  und Paketverlust (Intervallmessung etwa alle 3 Sekunden). Ping bezieht sich auf
  Tablet ↔ Medienserver, nicht auf die Ende-zu-Ende-Videoverzögerung. Nach 10 Sekunden
  ohne neue Messung werden Werte ausgeblendet; nicht verfügbare Browserwerte bleiben leer.
- LiveKit übernimmt Wiederverbindungen. Nach endgültigem Abbruch holt die App
  neue kurzlebige Tokens und versucht erneut. Ein LiveKit-Neustart wird so ebenfalls
  abgefangen, solange die Bildschirmfreigabe im Host-Browser noch aktiv ist.
- Der Starter speichert lokale Geheimnisse und Logs ausschließlich in `.local/`
  (gitignored). Der LiveKit-API-Schlüssel bleibt auf dem Server; Tablets bekommen
  nur raumgebundene Empfangstokens. Logdateien können Verbindungsdetails enthalten.

### Verifikation

`npm test` deckt zusätzlich Medienrechte, Sitzungswechsel, SDK-Verbindungsabbruch
und Abbruch während des Verbindungsaufbaus ab. `npm run smoke-test` prüft weiter
Raumverwaltung und Direkt-Signaling.

Für einen Browser-Integrationstest mit bewegtem Testbild statt Bildschirmfreigabe:
Starter auf Port 3210 laufen lassen, dann `node scripts/browser-media-test.js` und
`http://localhost:3299/host` öffnen. Nur diese separate Testseite ersetzt die
Bildschirmquelle durch einen Canvas. Der QR-Code führt auf die echte Viewer-App.
Mit Stop → anderem Übertragungsweg → Start kann der Wechsel geprüft werden.
Der Test-Proxy bindet ausschließlich an Loopback und gehört nicht zum Deployment.

Vor dem Einsatz: mit 1, 3, 5 und 10 echten Tablets testen, Wiedergabeflüssigkeit,
Verzögerung und Host-Auslastung messen, WLAN aus-/einschalten und Starter neu starten.
Browserfenster auf einem einzigen Rechner ersetzen keinen WLAN-Lasttest.
