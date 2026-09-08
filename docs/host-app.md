# Host-App

Die Host-App bündelt unsere Webseite, Electron (inklusive Node-Laufzeit) und
LiveKit Server. Nutzer installieren nur diese App; Tablets bleiben im Browser.
Es werden beim ersten Start weder Programme nachgeladen noch Pakete installiert.

## Ablauf für Nutzer

1. Den passenden Installer herunterladen: macOS Apple Silicon, macOS Intel oder Windows.
2. macOS: App aus dem DMG in „Programme“ ziehen. Windows: Setup ausführen.
3. App öffnen. Bei mehreren Adaptern das Netzwerk der Tablets auswählen und **Host starten**.
4. **Bildschirm teilen**, die Bildschirmquelle auswählen und den QR-Code auf den Tablets öffnen.

Beim ersten Teilen fragt das Betriebssystem gegebenenfalls nach der Berechtigung
zur Bildschirmaufnahme bzw. zum lokalen Netzwerk. Die App öffnet auf neueren
macOS-Versionen die Systemauswahl; andernfalls gibt es eine native Auswahl von
Bildschirmen und Fenstern. Es wird keine Quelle ohne Auswahl freigegeben.

Der Medienserver-Modus ist in der App vorausgewählt. Alle Qualitäts-, Statistik-
und Reconnect-Funktionen der Webseite bleiben verfügbar. Der Raum der Online-Seite
ist unabhängig vom lokalen App-Raum; verwende dessen QR-Code. Im Menü **Host →
Netzwerk wechseln** lässt sich eine andere Verbindung wählen; die laufende
Übertragung wird dabei beendet. Das Schließen der App beendet beide Dienste.

Bei belegten Ports zeigt die App einen Hinweis. Beende einen zuvor gestarteten
Entwickler-Starter, bevor du die Host-App benutzt. Die Ports sind TCP 3210, 7880,
7881 und UDP 7882. Es ist keine Portfreigabe ins Internet nötig.

## Entwicklungsstand und Veröffentlichung

Die Installer werden zunächst als **unsignierte Test-Builds** erzeugt. Die
GitHub-Action „Host-App installers“ baut macOS (Apple Silicon/Intel) und Windows
(x64) und legt sie als Workflow-Artefakte ab. Sie veröffentlicht nichts automatisch.
Ein Windows-Installer-Build ersetzt keinen praktischen Test auf Windows.

Die Installer werden vorerst unsigniert veröffentlicht. macOS und Windows können
beim Öffnen Sicherheitsmeldungen anzeigen. Signierung und Notarisierung sind
später möglich; Laufzeittests auf Windows und Intel-Macs stehen noch aus.

Für eine Veröffentlichung: Version erhöhen, die drei Installer in CI bauen und
als Release im öffentlichen Repository `weiskopfsodefa/sharemyscreen-downloads`
hochladen. Dort liegen nur Downloads und Release-Hinweise, kein Projekt-Quellcode.
Das eigentliche Projekt-Repository bleibt privat; dessen Release-Assets sind
für nicht angemeldete Besucher nicht zugänglich.

Nach erfolgreichem Upload das Release veröffentlichen, die Asset-URLs in
`public/downloads.json` aktualisieren und ohne GitHub-Anmeldung prüfen.
`public/js/download.js` akzeptiert nur Release-URLs aus dem Download-Repository.
Anschließend die Webseite deployen und alle drei Download-Buttons kontrollieren.

## Lokal entwickeln und bauen

Nur Entwickler benötigen Node.js, npm, Go >= 1.26 und `tar`:

```sh
npm ci
npm run desktop:prepare
npm run desktop:dev
```

`desktop:prepare` lädt LiveKit **1.13.6** aus dem offiziellen Repository,
prüft den fest hinterlegten SHA-256-Hash und baut den Server für das Zielsystem.
Die Go-Abhängigkeiten sind durch LiveKits `go.mod`/`go.sum` festgelegt. Lizenzen
und Dependency-Hinweise werden mit dem Binary in `desktop-resources/livekit`
abgelegt. Endnutzer benötigen Go nicht. Die bestehende LiveKit-/Homebrew-
Installation wird weder verwendet noch verändert.

```sh
npm run desktop:build
```

Ergebnis: DMG auf macOS bzw. NSIS-Setup auf Windows unter `dist-desktop/`.
Die Ressourcen werden außerhalb von ASAR abgelegt, damit LiveKit ausführbar ist.
Der Build prüft, dass Betriebssystem und Architektur des Servers zum Installer
passen. `DESKTOP_ARCH=x64` bzw. `arm64` wählt beim Vorbereiten ein anderes Ziel;
beim anschließenden Build dieselbe Architektur angeben (`--x64` / `--arm64`).
macOS-Installer auf macOS bauen, Windows-Installer vorzugsweise auf Windows.

## Betriebsdetails

Die Web-App läuft in einem Electron-Utility-Prozess. Die Oberfläche hat weder
Node-Zugriff noch Dateisystemrechte. Die kleine IPC-Schnittstelle ist nur auf der
lokalen Einrichtungsseite aktiv und akzeptiert ausschließlich vorhandene private
Netzwerkadressen. Neue Fenster und Navigation zu fremden Seiten sind gesperrt.
LiveKit wird als eigener lokaler Prozess gestartet; beim regulären Beenden und
bei behandelten Dienstfehlern wird er mit beendet.

Konfiguration, Raum-Schlüssel und private Logs liegen im Benutzerprofil:

- macOS: `~/Library/Application Support/sharemyscreen/local-server/`
- Windows: `%APPDATA%/sharemyscreen/local-server/`

Der tatsächliche Ordner folgt dem Electron-App-Namen. Logs können Zugangsdaten
enthalten und werden nicht an einen Dienst geschickt. Das App-Bundle bleibt
schreibgeschützt. Die Übertragung läuft im vertrauenswürdigen lokalen Netzwerk
über dieselbe HTTP/WS-Konfiguration wie der Entwickler-Starter; WebRTC-Medien
sind verschlüsselt. Die Einschränkungen aus der README zu WLAN und HTTPS gelten
auch hier.
