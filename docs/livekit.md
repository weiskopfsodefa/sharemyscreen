# LiveKit für sharemyscreen einrichten

LiveKit Server wird nur auf dem Host-Laptop installiert. Auf den Tablets reicht
unser Link im Browser. Der Direktmodus braucht kein LiveKit. Nach der einmaligen
Installation funktioniert der Medienserver-Modus ausschließlich im lokalen Netz;
ein LiveKit-Cloud-Konto oder Abonnement ist dafür nicht nötig.

## 1. Erst prüfen – vielleicht ist LiveKit schon installiert

Öffne ein Terminal im sharemyscreen-Projektordner und führe aus:

```sh
npm run check:local
```

Bei Erfolg erscheint beispielsweise `LiveKit Server 1.13.5 gefunden und ausführbar`.
Dann ist keine Neuinstallation nötig: weiter mit Schritt 3. Getestet wurde diese
Version; die Ausgabe einer anderen Version ist noch keine Kompatibilitätsgarantie.
Der Check prüft die ausführbare Datei und ihre Version, nicht WLAN, Firewall,
freie Ports oder die erreichbare Videoqualität. Er startet keinen Dienst und
ändert keine Dateien. Er funktioniert auch, wenn LiveKit bereits läuft.

Ohne Projekt kannst du die Installation auch direkt prüfen:

```sh
livekit-server --version
```

Wird der Befehl nicht gefunden, fehlt entweder LiveKit oder der Eintrag im PATH.
Unser Check sucht auf macOS zusätzlich unter `/opt/homebrew/bin` und
`/usr/local/bin`. Ein gesetztes `LIVEKIT_BIN` wird ausschließlich verwendet;
ein veralteter Pfad muss korrigiert werden. Die `lk`-CLI und das npm-Paket
`livekit-client` ersetzen den LiveKit Server nicht.

## 2. LiveKit installieren, falls es fehlt

### macOS

Falls `brew --version` funktioniert, installiere LiveKit mit:

```sh
brew install livekit
```

Fehlt Homebrew, folge zuerst der Anleitung auf [brew.sh](https://brew.sh/),
inklusive der dort ausgegebenen Schritte zum Einrichten des PATH. Öffne danach
ein neues Terminal. Für macOS verwenden wir Homebrew; die offiziellen
LiveKit-Releases enthalten nicht für jede Version fertige macOS-Binärdateien.

Bei einem eigenen Installationsort kannst du den Pfad ausdrücklich setzen:

```sh
export LIVEKIT_BIN="/vollstaendiger/Pfad/livekit-server"
npm run check:local
```

### Windows (PowerShell)

1. Öffne die [offiziellen LiveKit-Releases](https://github.com/livekit/livekit/releases/latest).
2. Lade unter **Assets** das Windows-ZIP passend zur CPU herunter. Auf üblichen
   Intel-/AMD-PCs ist das `windows_amd64`. Prüfe bei einem ARM-PC die verfügbaren
   Pakete und deren Kompatibilität; macOS-/Linux-Dateien funktionieren hier nicht.
3. Entpacke das ZIP vollständig, beispielsweise nach `C:\Tools\LiveKit`.
4. Setze in PowerShell den tatsächlichen Pfad zur entpackten EXE:

```powershell
$env:LIVEKIT_BIN = 'C:\Tools\LiveKit\livekit-server.exe'
& $env:LIVEKIT_BIN --version
```

Wechsle im selben Terminal in den Projektordner und führe `npm run check:local`
aus. Die Variable gilt nur für dieses Terminal und seine gestarteten Programme.
Für den späteren Doppelklick auf `start-local.cmd` nimm den Ordner dauerhaft in
den Benutzer-PATH auf oder lege `LIVEKIT_BIN` als Benutzer-Umgebungsvariable an.
Danach ein neues Terminal öffnen.

## 3. Projekt einmal vorbereiten

Benötigt wird [Node.js](https://nodejs.org/) ab Version 20, vorzugsweise eine
aktuell unterstützte LTS-Version. Prüfe `node --version` und `npm --version`.
Wenn einer der Befehle fehlt, installiere Node.js und öffne das Terminal neu.
Lade das Repository herunter oder klone es und wechsle in den Projektordner:

```sh
git clone https://github.com/weiskopfsodefa/sharemyscreen.git
cd sharemyscreen
npm ci
npm run check:local
```

Wenn das Projekt bereits vorhanden ist, überspringe das Klonen. Für einen PR-Test
verwende dessen Branch. `npm ci` installiert die Web-App-Abhängigkeiten, nicht
LiveKit Server. Einmalige Downloads benötigen Internetzugriff.

## 4. Übertragung starten

Verbinde den Host und die Tablets mit demselben lokalen Netzwerk. Im Projektordner:

```sh
npm run start:local
```

Alternativ öffne `start-local.command` auf macOS bzw. `start-local.cmd` auf Windows.
Der Starter prüft zuerst die LiveKit-Installation. Anschließend startet er
LiveKit und die Web-App mit der passenden lokalen Konfiguration und eigenen
Zugangsschlüsseln. Starte LiveKit deshalb nicht zusätzlich mit `--dev`.

1. Öffne am Host **http://localhost:3210/host**.
2. Wähle **Lokaler Medienserver**, die gewünschte Priorität und Qualität.
3. Klicke **Bildschirm teilen** und wähle die Bildschirmquelle aus.
4. Scanne mit den Tablets den QR-Code auf der Host-Seite.

Die Tablets verwenden die LAN-Adresse aus dem QR-Code, nicht `localhost`.
Lasse das Terminal während der Übertragung geöffnet. Mit Strg+C beendest du
beide Dienste. Nach einem App-Update Host-Seite und Tablets neu laden.

### Mehrere Netzwerkadressen

Bei WLAN plus Netzwerkkabel oder zusätzlichen Adaptern nennt der Starter die
gefundenen privaten IPv4-Adressen. Wähle die Adresse des Adapters, über den die
Tablets den Host erreichen. Beispielwerte durch deine Adresse ersetzen:

macOS:

```sh
LOCAL_MEDIA_IP=192.168.178.24 npm run start:local
```

Windows PowerShell:

```powershell
$env:LOCAL_MEDIA_IP = '192.168.178.24'
npm run start:local
```

## Wenn etwas nicht funktioniert

| Meldung oder Problem | Was hilft |
| --- | --- |
| LiveKit nicht gefunden | Installation und PATH prüfen oder den vollständigen Pfad in `LIVEKIT_BIN` setzen. |
| Gefunden, aber nicht ausführbar | Passendes Paket für Betriebssystem und CPU verwenden; Dateirechte bzw. Betriebssystemmeldung prüfen. |
| Keine erkennbare Server-Version | Auf `livekit-server` zeigen, nicht auf `lk` oder eine andere Datei. |
| Keine LAN-Adresse | WLAN/LAN verbinden; bei mehreren Adressen `LOCAL_MEDIA_IP` setzen. |
| Port belegt / LiveKit beendet sich sofort | Eine schon laufende separate Instanz im zugehörigen Terminal beenden und unseren Starter erneut ausführen. |
| Tablets erreichen den Host nicht | Gleiches Netzwerk, richtige QR-Adresse und Firewall prüfen. Gast-WLAN/Client-Isolation kann Geräte voneinander abschotten. |
| `node` oder `npm` fehlt beim Doppelklick | Node.js installieren/PATH einrichten oder aus einem Terminal starten, in dem `node --version` funktioniert. |

Im privaten Netz müssen TCP **3210, 7880, 7881** und UDP **7882** erreichbar sein.
Es ist keine Portfreigabe ins Internet nötig. Der Standardstarter verwendet
HTTP/WS im vertrauenswürdigen LAN; Details zu HTTPS und verwalteten Geräten stehen
in der [README](../README.md#lokalbetrieb-und-https). Private Diagnoseprotokolle
liegen in `.local/livekit.log`; sie können Zugangsdaten enthalten.

Die Webseite kann nicht nach installierten Programmen auf deinem Rechner suchen.
Sie erkennt, ob die Web-App für den Medienserver-Modus konfiguriert ist. Ob der
Server wirklich verbunden ist, zeigt sie erst beim Verbindungsaufbau. Für die
Installationsprüfung verwende den Check oben.

Quellen: [LiveKit: Running locally](https://docs.livekit.io/transport/self-hosting/local/),
[LiveKit-Releases](https://github.com/livekit/livekit/releases/latest).
