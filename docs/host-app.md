# Host-App

Die Host-App bündelt unsere Webseite, Electron (inklusive Node-Laufzeit) und
LiveKit Server. Nutzer installieren nur diese App; Tablets bleiben im Browser.
Es werden beim ersten Start weder Programme nachgeladen noch Pakete installiert.

## Ablauf für Nutzer

1. Den passenden Installer herunterladen: macOS Apple Silicon (M1 oder neuer) oder Windows 64 Bit. Intel-Mac-Installer werden nicht mehr angeboten.
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

Die GitHub-Action „Host-App installers“ baut macOS (Apple Silicon) und Windows
(x64) und legt sie als Workflow-Artefakte ab. Sie veröffentlicht nichts automatisch.
Pull Requests erzeugen ausschließlich **unsignierte Test-Builds** ohne Zugriff auf
Signing-Secrets; diese Artefakte sind mit `host-app-test-` gekennzeichnet und dürfen
nicht als öffentliche macOS-Downloads veröffentlicht werden.

Manuell gestartete Builds (`workflow_dispatch`) signieren und notarisieren die
macOS-App mit `electron-builder.release.cjs`. Fehlende Zugangsdaten, Fehler bei
Signierung oder Notarisierung sowie fehlgeschlagene Signatur-, Ticket- oder
Gatekeeper-Prüfungen brechen den macOS-Job vor dem Artefakt-Upload ab.
Windows-Installer bleiben unsigniert. Laufzeittests auf Windows stehen noch aus;
ein erfolgreicher Build ersetzt keinen praktischen Test.

Der Apple-Silicon-Installer von Version 0.1.1 wurde am 26. September 2026 durch
eine mit Developer ID signierte und von Apple akzeptierte, notarisierte Fassung
ersetzt (`mac-arm64-notarized.dmg`). Das Notarisierungsticket ist am DMG angebracht;
die App aus diesem DMG besteht die Gatekeeper-Prüfung als „Notarized Developer ID“.
Die alten unsignierten macOS-Installer einschließlich Intel werden nicht mehr angeboten.

### Apple-Signierung einmalig einrichten

Benötigt wird eine aktive Apple-Developer-Mitgliedschaft. Der Kontoinhaber muss
der Veröffentlichung zustimmen; sein Name bzw. der seiner Organisation erscheint
als Herausgeber. Ein kostenloses Entwicklerkonto oder ein Zertifikat vom Typ
„Apple Development“ reicht dafür nicht.

Der Kontoinhaber erstellt ein **Developer ID Application**-Zertifikat und exportiert
es mit dem zugehörigen privaten Schlüssel als passwortgeschützte `.p12`-Datei.
Unter GitHub → Repository → Settings → Secrets and variables → Actions werden
folgende Repository-Secrets hinterlegt, möglichst direkt durch den Kontoinhaber:

| Secret | Inhalt |
| --- | --- |
| `CSC_LINK` | Base64-kodierter Inhalt der `.p12`-Datei |
| `CSC_KEY_PASSWORD` | Passwort der `.p12`-Datei |
| `APPLE_ID` | Apple-Account-E-Mail des berechtigten Kontoinhabers |
| `APPLE_APP_SPECIFIC_PASSWORD` | Separat erzeugtes anwendungsspezifisches Passwort für die Notarisierung |
| `APPLE_TEAM_ID` | Team-ID der Apple-Developer-Mitgliedschaft |

Keine Zertifikate, privaten Schlüssel oder Passwörter im Repository oder Chat
ablegen. Das normale Apple-Account-Passwort wird nicht benötigt. Wer Workflows im
Repository verändern und ausführen darf, kann diese Secrets verwenden; der
Kontoinhaber sollte nur einem entsprechend vertrauenswürdigen Repository Zugriff geben.

Anschließend die Action „Host-App installers“ auf dem geprüften Release-Stand
manuell ausführen. Nur die erfolgreichen `host-app-release-`-Artefakte verwenden.
Den fertigen macOS-Download zusätzlich über einen Browser auf einem anderen Mac
installieren und starten, bevor die Download-Links umgestellt werden.

Referenzen: [Developer ID](https://developer.apple.com/developer-id/),
[electron-builder v26: macOS-Signierung](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

### Release veröffentlichen

Für einen lokalen Release-Build kann das Developer-ID-Zertifikat bereits im
macOS-Schlüsselbund liegen. Den Notarisierungszugang einmalig mit
`xcrun notarytool store-credentials sharemyscreen-notary` interaktiv einrichten;
das anwendungsspezifische Passwort wird verdeckt abgefragt und im Schlüsselbund
gespeichert. Anschließend mit den vorbereiteten LiveKit-Ressourcen bauen:

```sh
APPLE_KEYCHAIN_PROFILE=sharemyscreen-notary npx electron-builder \
  --config electron-builder.release.cjs --mac --arm64 --publish never
```

Vor der Veröffentlichung die App mit `codesign --verify --deep --strict`,
`xcrun stapler validate` und `spctl --assess --type execute` prüfen, wie im
CI-Workflow. Das lokale, ad-hoc signierte Test-DMG ist kein Release-Artefakt.

Für eine neue App-Version: Version erhöhen, die beiden Installer bauen und
als Release im öffentlichen Projekt-Repository `weiskopfsodefa/sharemyscreen`
hochladen. Quellcode und Installer sind dort ohne GitHub-Anmeldung zugänglich.

Nach erfolgreichem Upload das Release veröffentlichen, die Asset-URLs in
`public/downloads.json` aktualisieren und ohne GitHub-Anmeldung prüfen.
`public/js/download.js` akzeptiert nur Release-URLs aus dem Projekt-Repository.
Anschließend die Webseite deployen und beide Download-Buttons kontrollieren.

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
