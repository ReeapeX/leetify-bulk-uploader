# Leetify Bulk Demo Uploader

Tampermonkey-Userscript für [leetify.com](https://leetify.com): sucht alle Matches mit **„Upload Demo“**, geht dafür selbst die Zeiträume im Kalender durch und lädt die Demos über deine Upload-Extension hoch (mit Parallel-Limit, Pausen, Timeouts, Auto-Pause, Bericht). Dazu eine **KI-Analyse**: baut aus deinen letzten Matches einen fertigen Text für Claude/ChatGPT/Gemini.

## Installation

1. [Tampermonkey](https://www.tampermonkey.net/) installieren.
2. Diesen Link öffnen und auf „Installieren“ klicken:
   `https://raw.githubusercontent.com/ReeapeX/leetify-bulk-uploader/main/leetify-bulk-uploader.user.js`
3. Auf [leetify.com/app/matches](https://leetify.com/app/matches) öffnen – unten rechts erscheint das Panel (`?` = Tutorial).

Updates kommen automatisch, sobald im Repo die `@version` im Header erhöht wurde.

## Upload

Erst **„1 testen“**, dann Modus **Vollautomatisch** und **Start**. Den Tab offen lassen. Bei mehreren Fehlern in Folge pausiert das Script von selbst (meist Captcha oder ausgeloggt). **📋 Bericht** lädt ein Protokoll herunter.

## KI-Analyse

Zwei Buttons im Panel, beide bauen denselben Text (es wird nichts an eine KI gesendet, du kopierst ihn selbst):

| Button | Datenquelle | Werte pro Match |
|---|---|---|
| **KI-Analyse (Liste)** | Match-Tabelle auf der Seite | alles, was die Liste zeigt (Spalten werden über die Kopfzeile erkannt) |
| **KI-Analyse (API)** | Leetify Public API | zusätzlich Reaktionszeit, Preaim, Kopf-/Spray-Accuracy, Counter-Strafing, Flashes, HE-Schaden, Trades, Multi-Kills, CT/T-Rating, dazu dein Skill-Profil |

Der Text enthält: Gesamtwerte, **Vergleiche beliebiger Zeitfenster**, Verlauf in 10er-Blöcken, Maps, Quellen, Tilt-Check, Ausreißer und eine Einzel-Tabelle. Der Auftrag an die KI verlangt **Diagnose statt Tipps**.

Einstellungen unter **⚙ Einstellungen → KI-Analyse**:

- **Vergleiche:** `10/10` = letzte 10 gegen die 10 davor · `30~60` = letzte 30 gegen die letzten 60 insgesamt. Beispiel: `10/10, 30/30, 30~60`.
- **Max. Matches:** wird automatisch erhöht, wenn die Vergleiche mehr brauchen. Bei „Liste“ zählt nur, was im gewählten Zeitraum sichtbar ist (z. B. oben „Last 90 Days“ einstellen).
- **Steam64-ID** (nur API): 17 Ziffern aus der Steam-Profil-URL.
- **Leetify-API-Key** (optional): [leetify.com/app/developer](https://leetify.com/app/developer). Ohne Key gelten strengere Rate-Limits.
- **Profil:** Freitext über dich (Rolle, Level, Maps, Setup, Ziel). Steht in jedem Export.

Die „Wertung“ in den Vergleichen sagt der KI, ob ein Unterschied belastbar ist: `im Rauschen` / `Tendenz` / `klar` (Standardfehler-Test gegen die Matches außerhalb des neuen Fensters).

## Datenschutz

API-Key, Steam64-ID und Profil liegen **nur lokal im Speicher von Tampermonkey**, nicht im Code, nicht im Bericht und nicht in diesem Repo. Das Script ruft ausschließlich `leetify.com`, FACEIT (über deine Upload-Extension) und bei der API-Analyse `api-public.cs-prod.leetify.com` auf.

## Changelog

### 3.5.0
- KI-Analyse neu: Diagnose statt Tipps, frei wählbare Vergleichsfenster, Rauschen-Check, 10er-Blöcke, Tilt-Check, API-Variante mit vielen Zusatzwerten, Profil-Feld.
- Fix: Warten auf einer anderen Leetify-Seite zählte als „Hänger“ und löste nach ~12 min Auto-Pause aus.
- Spalten der Liste werden über die Kopfzeile zugeordnet (vorher feste Positionen, Prozent-Spalten gingen verloren).
- Version wird aus dem Header gelesen, Metadaten für GitHub-Auto-Update.

### 3.4.1
- Stand vor der Veröffentlichung auf GitHub.
