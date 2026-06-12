# sharemyscreen

Bildschirm vom Windows-Laptop live auf ~10 Android-Tablets streamen – z. B. in einer Kneipe.
Gehostete Web-App, **das Video läuft aber P2P direkt im lokalen WLAN** (WebRTC-Fanout).
Der Server macht nur UI, Raumverwaltung und Signaling – er überträgt kein Video.

```
Website laden:        Internet
Signaling/WebSocket:  Internet, geringe Bandbreite
Video/Audio:          P2P im WLAN (Host -> jedes Tablet einzeln)
```

## Lokal starten

```bash
npm install
npm start          # http://localhost:3000
npm run smoke-test # Signaling-Tests
```

Hinweis: `getDisplayMedia()` braucht einen sicheren Kontext. `http://localhost` zählt als
sicher – für Tests mit echten Tablets muss die App aber über **HTTPS** erreichbar sein
(deployen, siehe unten).

## Benutzung

1. Host öffnet die Seite und klickt **Raum starten** (`/host`).
2. **Bildschirm teilen** klicken, Bildschirm/Fenster auswählen.
   Für Ton: „Gesamter Bildschirm“ + „Systemaudio teilen“ anhaken.
3. Tablets scannen den QR-Code (`/v/CODE`) – Stream startet automatisch,
   Vollbild-Button unten rechts, Wake Lock hält das Display an.
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

Es gibt keine Konfiguration außer `PORT` (Default 3000). Kein Build-Schritt.

## Empfehlung fürs Event

- Eigener Wi-Fi-6-Router, Laptop per **LAN-Kabel** an den Router, Tablets in dessen WLAN.
- **Client-/AP-Isolation am Router ausschalten** – sonst dürfen Geräte nicht direkt
  miteinander reden und WebRTC findet keinen lokalen Weg.
- Vorher mit 1, 3, 5, 10 Tablets testen und auf der Host-Seite prüfen,
  dass überall **LOKAL** steht.

## Technik / Grenzen (MVP)

- Ziel: 720p, 15 fps, max. 1,2 Mbit/s pro Tablet (im Code: `MAX_BITRATE_BPS` in `public/js/host.js`).
- ICE nur mit STUN, **bewusst kein TURN** – damit Video nie unbemerkt übers Internet läuft.
- Host-Reload behält den Raum (5 Min. Karenz), Tablets verbinden sich automatisch neu.
- Kein SFU/Medienserver. Wenn 10 Tablets per P2P nicht stabil laufen, ist das die
  nächste Ausbaustufe.
