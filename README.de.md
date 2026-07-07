<div align="center">

# makera-pcb

**Aus KiCad-Gerber- + Bohrdaten wird fräsfertiger G-Code für die Makera Carvera Air – in einer App.**

Isolationsfräsen · Bohren · Außenkontur — mit Fräsbarkeits-Check, 2D-**und**-3D-Vorschau,
Werkzeug-Bibliothek (ein `M6`-Programm), KI-Check, komplett geführtem Fertigungsablauf und
**direkter Maschinen-Anbindung** (finden → Status → hochladen → starten). Kein FlatCAM, kein MakeraCAM nötig.

![Node ≥18](https://img.shields.io/badge/Node-%E2%89%A518-3c873a)
![tests](https://img.shields.io/badge/tests-45%20passing-2ecc71)
![kein externes CAM](https://img.shields.io/badge/kein-FlatCAM%20n%C3%B6tig-4c8dff)
![Makera Carvera Air](https://img.shields.io/badge/Makera-Carvera%20Air-ff5a5a)
![i18n](https://img.shields.io/badge/UI-DE%20%2F%20EN-8a94a6)

[English](README.md) · **Deutsch**

<img src="docs/img/preview.png" alt="2D-Vorschau mit Layer-Filtern" width="820" />

</div>

---

## ✨ Highlights

- **2D- + 3D-Board-Ansicht** — Kupfer, Silkscreen, Bohrungen und Fräsbahnen; drehbar in 3D (three.js).
- **Geführter, maßstabsgetreuer Ablauf** — Schritt für Schritt mit **exakten Carvera-Air-Grafiken**
  (300 × 200 mm Bett, Ankerpunkt 1, L-Winkel-Verschraubung, Opferplatte, Klemmen, Bemaßung).
- **Werkzeuge ↔ Schritte** — Feed/Plunge/RPM **pro Werkzeug**; jedem Schritt ein Werkzeug zuordnen →
  ein einziges **`0_full_job.nc`** mit `M6`-Wechseln (statt vieler Einzeldateien).
- **Offizielle Makera-Feeds** — ein Klick setzt alle Werkzeuge auf die Makera-Speeds&Feeds-Tabelle.
- **Direkte Maschinensteuerung** — UDP-Discovery, Live-Status, Jog, Antasten, Auto-Leveling, MDI,
  Upload & `play` — spricht das **binäre Framing-Protokoll** (Firmware ≥ 1.0.5, z. B. 1.0.6).
- **KI-Check (OpenAI)** — kennt die exakten Carvera-Air-Specs/Werkzeuge/Rohlinge und liefert
  konkrete Ein-Klick-Korrekturen.
- **UV-Lötstopplack-Ablauf** — Auftragen → Aushärten (mit Timer) → Pads freilegen, plus Laser-Silkscreen.
- **Zweisprachige UI (DE/EN)** und **Projekte** — kompletten Arbeitsstand speichern/laden/exportieren.

## 📸 Screenshots

| Material & Dateien | Fräs-Einstellungen | Werkzeuge & 1-Datei-Job |
|:---:|:---:|:---:|
| <img src="docs/img/material.png" width="260" /> | <img src="docs/img/config.png" width="260" /> | <img src="docs/img/tools.png" width="260" /> |
| **Geführte Fertigung (maßstabsgetreu)** | **Maschinensteuerung** | **2D-/3D-Vorschau** |
| <img src="docs/img/fabrication.png" width="260" /> | <img src="docs/img/machine.png" width="260" /> | <img src="docs/img/preview.png" width="260" /> |

## 🚀 Schnellstart

```bash
cd makera-pcb
npm install
npm start
```

`http://localhost:4321` öffnen, **„Beispiel-Board laden“** klicken (lädt das I²C-Board aus
`../platine/gerbers`) oder eigene Gerber per Drag & Drop einwerfen (F.Cu, Edge.Cuts, `.drl`
werden automatisch zugeordnet).

Die Oberfläche ist in **Workflow-Tabs** in der Reihenfolge des Vorgehens gegliedert:
**1 Material & Dateien · 2 Fräs-Einstellungen · 3 Werkzeuge · 4 Vorschau · 5 KI-Check ·
6 Maschine · 7 Fertigung · 8 Ergebnis**. „G-Code erzeugen“ ist immer oben erreichbar.

```
Gerber (F.Cu) ─┐
Edge.Cuts     ─┼─►  makera-pcb  ─►  1_isolation.nc · 2_drill_<Ø>.nc · 4_outline.nc
Drill (.drl)  ─┘                    0_full_job.nc (M6) · FERTIGUNGSPLAN.md
```

## 🧰 Werkzeuge & 1-Datei-Job

<img src="docs/img/tools.png" align="right" width="300" />

Im Card **„3 · Werkzeuge (Carvera Air)“** legst du deine Tools an (Nummer, Typ, Ø, Collet
S1–S6, **Feed/Plunge/RPM**, Bezeichnung – im Browser gespeichert).

- **Standard laden** füllt die komplette Carvera-Air-Werkzeugliste.
- **Makera-PCB Feeds** setzt Feed/Plunge/RPM aller Werkzeuge exakt auf die offizielle
  Makera-Tabelle (PCB-Spalte): V-Bit 12000/500/200, Corn-Bit 12000/500/300,
  Bohrer 10000/1000/200, Lötstopplack-Entferner 6000/400/200.

Darunter ordnest du jedem Schritt (Isolation, Bohren je Ø, Außenkontur) ein Werkzeug zu
(„Automatisch zuordnen“ per Typ/Ø). Sind alle Schritte belegt, entsteht zusätzlich
**`0_full_job.nc`** – ein einziges Programm mit `M6 T… S…`-Wechseln in der richtigen Reihenfolge.
Beim Carvera Air pausiert jeder `M6` für den manuellen Wechsel und misst danach automatisch die Länge.

<br clear="all" />

## 🧱 Material / Rohling

<img src="docs/img/material.png" align="right" width="300" />

Im Tab **Material & Dateien** wählst du den **Rohling** – mit den Standard-Makera-PCB-Blanks
(FR4 1,5 mm, ein-/doppelseitig, **100×150** und **150×200 mm**) plus „FR4 generisch 1,6 mm“
und „Eigenes Material“. Die Auswahl setzt Dicke (Z) und Stock-Maße (X/Y, mit ⇄-Tausch). Eine
**Live-Vorschau** zeigt den Rohling mit der Platine darauf und ob sie **passt**. Der Check
prüft zusätzlich, ob das Board auf den Rohling passt (inkl. ~4 mm Spannrand).

<br clear="all" />

## 🛠 Geführte Fertigung (maßstabsgetreue Grafiken)

<img src="docs/img/fabrication.png" align="right" width="300" />

Der **Fertigungs-Tab** nimmt dich beim echten Herstellen an die Hand – in exakt der
Makera-Reihenfolge (**erst Wired Probe – Rand/Z/Leveling – dann das Schneidwerkzeug**):

1. **Platine plan fixieren** an Ankerpunkt 1 (maßstabsgetreue Draufsicht + Seitenansicht des Aufbaus).
2. **XY-Nullpunkt setzen** (Makera-Offset X15/Y10 ab Anker 1).
3. **Wired Probe (T0) einsetzen.**
4. **Config & Run:** Scan Margin + Auto Z Probe + Auto Leveling (5×5, H2) in einem Rutsch.
5. **Isolationswerkzeug einsetzen** (Werkzeuglänge wird bei jedem Wechsel automatisch gemessen).
6. Isolation fräsen → Bohren → Kontur → optional Laser-Silkscreen → entnehmen & finishen.

Jeder Schritt hat eine **maßstabsgetreue Illustration der echten Carvera Air** (300 × 200 mm
Arbeitsfläche, grauer L-Winkel an Ankerpunkt 1 mit **2 Passstiften + 3 M5-Schrauben**,
Opferplatte, Top-Klemmen, Platine **in mm bemaßt**). Je Schritt gibt es geschätzte Zeit,
Werkzeug, **▶ Start** (lädt die passende `.nc` hoch und startet) und einen „Erledigt“-Haken;
UV-Lack-Schritte haben einen Aushärte-Timer.

> **Opferplatte:** MDF (oder Acryl-/HDF-Rest), **1–2 mm** dick, rundum ca. **20 mm** größer als
> die Platine – so gehen Bohrer/Kontur ins MDF statt ins Maschinenbett.

<br clear="all" />

## 🤖 Maschinensteuerung (Carvera Air)

<img src="docs/img/machine.png" align="right" width="300" />

1. **Suchen** — findet die Maschine per UDP-Broadcast (Port 3333, markiert **frei/belegt**).
2. **Verbinden** — TCP (Port 2222). Protokoll auto-erkannt (Framing-Firmware ≥ 1.0.5 oder
   alte Klartext-Firmware). Danach: Live-Status, MDI, **Hochladen** und **Hochladen & Start (play)**.
3. **Verbindungsprofile** — IP/Port als benanntes Profil speichern.

**Gerätesteuerung:** Jog-Pad (X/Y/Z/A), Home/Entsperren/Reset, Nullpunkt setzen, Freifahren/Nullpunkt,
Rand abfahren, Z antasten, Auto-Leveling; ein **Zubehör**-Panel für Licht, Auto-Absaugung, Air Assist,
Spindel-Lüfter, Piep, Spannzange öffnen/schließen, Kalibrieren, Höhenkarte zeigen/löschen;
Pause/Fortsetzen/Stop; Live-Fortschritt; und ein **Alarm-Banner** mit Klartext-Hinweisen +
Troubleshooting-Panel.

> **Protokoll:** Aktuelle Firmware (≥ 1.0.5, z. B. Carvera Air **1.0.6**) spricht ein **binäres
> Framing-Protokoll** (`0x8668 … CRC16 … 0x55AA`) – ein blankes `?` wird ignoriert (deshalb blieb
> der Status früher leer). Diese App erkennt das automatisch und verpackt Befehle, Realtime-Bytes
> und Datei-Upload passend. Der Carvera bedient nur **einen** Client – MakeraCAM/Controller vorher
> beenden (und USB ziehen).

<br clear="all" />

## 🧠 KI-Check (OpenAI)

OpenAI-Key eintragen (bleibt lokal im Browser, oder `.env`), Modell wählen (Default `gpt-5.5`)
und **„Konfiguration prüfen“**. Die KI bewertet Fräsbarkeit/Feeds/Speeds/Tiefen für *dieses*
Board und liefert konkrete **Korrekturen als Patch**, die du mit einem Klick übernimmst.

`makera-pcb/.env` anlegen (Vorlage: `.env.example`):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
```

`.env` ist git-ignored und wird beim Start automatisch geladen. Mit Server-Key zeigt der Check
„aktiv (.env)“, und der **Auto-Check** läuft nach jeder Erzeugung.

## 💾 Projekte & 🌐 Sprache

- **Projekte:** kompletten **Arbeitsstand** speichern/laden (Gerber-Dateien, alle Einstellungen,
  Werkzeuge, Zuordnungen, Material, Layer), als `*.mkpcb.json` exportieren/importieren. Das zuletzt
  geöffnete Projekt wird beim Start automatisch wiederhergestellt.
- **Sprache:** DE/EN-Umschalter (oben rechts) schaltet die komplette UI live um – Tabs, Formulare,
  geführte Schritte, Diagramme, Troubleshooting, Meldungen. Die Wahl wird gemerkt.

## ⌨️ Kommandozeile

```bash
# ganzen Gerber-Ordner verarbeiten
node src/cli.js ../platine/gerbers --out out

# einzelne Dateien
node src/cli.js --copper F_Cu.gbr --edge Edge_Cuts.gbr --drill board.drl --out out

# Parameter überschreiben
node src/cli.js ../platine/gerbers --set isolation.cutDepth=0.12 --set outline.tabs=6
```

Ergebnis liegt in `out/` (`*.nc` + `FERTIGUNGSPLAN.md`).

## ⚙️ Konfiguration

| Bereich | Schlüssel | Default | Bedeutung |
|---|---|---|---|
| Material | `material.thickness` | 1.5 | Materialdicke (mm) |
| Allgemein | `safeZ` / `travelZ` | 5 / 1.5 | Eil-Sicherheits-/Reisehöhe |
| Isolation | `isolation.tool` | `vbit` | `vbit` oder `endmill` |
| | `isolation.vbitAngleDeg` | 30 | V-Bit-Spitzenwinkel |
| | `isolation.tipWidth` | 0.1 | Spitzenbreite (mm) |
| | `isolation.cutDepth` | 0.15 | Frästiefe ins Kupfer (mm) |
| | `isolation.passes` | 2 | Anzahl Isolationsbahnen |
| | `isolation.overlap` | 0.4 | Überlappung der Bahnen (0–0.9) |
| | `isolation.feedXY` / `rpm` | 300 / 12000 | Vorschub / Drehzahl |
| Bohren | `drill.throughMargin` | 0.3 | Durchbruch-Zugabe (mm) |
| | `drill.peck` | 0.6 | Peck-Tiefe pro Zustellung (mm) |
| | `drill.remap` | `[]` | Bohrer umbelegen, z. B. `[{ "from":1.3, "to":1.2 }]` |
| Kontur | `outline.cutterDiameter` | 1.0 | Fräser-Ø (mm) |
| | `outline.depthPerPass` | 0.4 | Tiefe pro Bahn (mm) |
| | `outline.tabs` | 4 | Anzahl Haltestege |
| | `outline.tabWidth` / `tabHeight` | 2 / 0.4 | Steg-Breite / verbleibende Höhe (mm) |
| | `outline.offsetSide` | `outside` | `outside` / `on` / `inside` |

Die effektive V-Bit-Breite wächst mit der Frästiefe (`tipWidth + 2·cutDepth·tan(Winkel/2)`)
und geht in den Fräsbarkeits-Check ein.

## 🏗 Wie es funktioniert

| Modul | Aufgabe |
|---|---|
| `src/gerber/` | RS-274X-Parser (Format, Aperturen, Macros inkl. `RoundRect`, Flashes/Draws/Regionen, Polarität, Bögen) |
| `src/excellon/` | Bohrdaten (Tools, Koordinaten, Slots) |
| `src/geometry/` | Clipper-Wrapper: Union/Difference/Offset, Kreis-Approximation |
| `src/cam/` | Isolation (konzentrische Offsets), Bohren (Peck, Nearest-Neighbour), Kontur (Stitching, Offset, Haltestege), G-Code |
| `src/cam/checks.js` | kleinster Kupferabstand (Offset-bis-Merge) vs. Werkzeug |
| `src/machine.js` | Carvera-Netzwerk: UDP-Discovery, Framing-Protokoll (auto-erkannt) + Klartext-Fallback, Live-Status, MDI/Realtime, Datei-Upload |
| `src/ai.js` | OpenAI-Konfig-Review (Prompt/Parser testbar, API-Call im Server) |
| `web/public/app.js` | UI: 2D/Demo-Animation, Werkzeuge, KI-Check, Maschine, Projekte |
| `web/public/i18n.js` | DE/EN-Wörterbuch + `t()`/`applyI18n()` (Sprachumschaltung) |
| `src/pipeline.js` | verbindet alles → Dateien, Report, 2D/3D-Vorschau |

> Die 3D-Ansicht nutzt ein vorgebautes Bundle (`web/public/view3d.bundle.js`). Nach Änderungen
> an `web/public/view3d.js` neu bauen mit `npm run build:viewer`.

## 🚧 Grenzen

- Nur die **F.Cu-Lage** wird isoliert (einseitig; kein Spiegeln für doppelseitig).
- Nur Isolation (kein flächiges Kupfer-Abräumen – das Makera-Stock-`.nc` räumt zusätzlich den Hintergrund).
- Geroutete Langlöcher in der Bohrdatei werden gemeldet, aber nicht automatisch gefräst.

## ✅ Tests

```bash
npm test
```

Deckt Geometrie, Aperturen/Macros, Gerber- und Excellon-Parser, Kontur-Stitching, das kombinierte
`M6`-Programm, den Carvera-Status-Parser, CRC16/XMODEM, den Framing-Encoder und einen Datei-Upload
über das Framing-Protokoll gegen einen protokolltreuen Mock, die KI-Hilfsfunktionen sowie einen
End-to-End-Lauf auf dem echten I²C-Board ab.
