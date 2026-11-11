# Beads Observer

Lokalny panel zadań [Beads](https://github.com/gastownhall/beads) i plugin
**OpenCode 2**. Tablica, listy, graf zależności, epiki, aktywność agentów oraz
podgląd powiązanych sesji OpenCode. Interfejs w 24 językach UE, z jasnym,
ciemnym i systemowym motywem. Bez CDN i zależności produkcyjnych npm.

## Instalacja

Wymagania: **Node.js 22+**, npm oraz Beads CLI `bd` dla rzeczywistych projektów.
Projekt musi mieć zainicjalizowane Beads (`bd init`).

```sh
npm install --global @opentoria/beads-observer
cd /sciezka/do/projektu
beads-observer open
```

Panel działa domyślnie na **http://127.0.0.1:4317**. `open` otwiera przeglądarkę
i rejestruje projekt; pozostaw proces uruchomiony, jeśli nie obsługuje go już
inna instancja. W SSH otwórz adres przez bezpieczne przekierowanie portu.

```sh
beads-observer --help
beads-observer --cwd /projekty/backend --port 4318
beads-observer --project /projekty/backend --project /projekty/frontend
beads-observer --demo
```

Tryb demonstracyjny używa danych w pamięci i nie wymaga Beads.

## Plugin OpenCode 2

Dodaj wpis do istniejącego `opencode.json` lub `opencode.jsonc`, zachowując
pozostałe pluginy i ustawienia:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@opentoria/beads-observer",
      "options": {
        "port": 4317,
        "pollIntervalMs": 2000,
        "bdPath": "bd"
      }
    }
  ]
}
```

OpenCode pobiera pakiet z npm; globalna instalacja CLI nie jest konieczna
dla samego pluginu. Konfiguracja przeładowuje się automatycznie; można wymusić
przeładowanie poleceniem `/reload`.

- `/beads-observer` otwiera panel bieżącego projektu.
- `/beads-observer ID-ZADANIA` wiąże bieżącą sesję z zadaniem i otwiera szczegóły.
- Instancje tego samego użytkownika mogą współdzielić serwer na jednym porcie.

Plugin używa API `@opencode/plugin` dla OpenCode 2. Nie jest przeznaczony
dla OpenCode 1. Podgląd sesji wymaga zgodnego API hosta; testy adapterów nie
zastępują pełnego testu w rzeczywistej instancji OpenCode.

### Opcje

| Opcja              | Domyślna                   | Znaczenie                                                       |
| ------------------ | -------------------------- | --------------------------------------------------------------- |
| `port`             | `4317`                     | Port lokalnego serwera.                                         |
| `pollIntervalMs`   | `2000`                     | Interwał odczytu Beads, minimum 500 ms.                         |
| `bdPath`           | `bd`                       | Program Beads CLI lub jego absolutna ścieżka.                   |
| `cwd`              | katalog projektu OpenCode  | Projekt Beads.                                                  |
| `project`          | nazwa katalogu             | Nazwa projektu w panelu.                                        |
| `projects`         | `[]`                       | Dodatkowe ścieżki lub obiekty `{ "cwd": "…", "project": "…" }`. |
| `timeoutMs`        | `15000`                    | Limit czasu komendy Beads.                                      |
| `nodePath`         | `node`                     | Node.js 22+ uruchamiający serwer.                               |
| `runtimeDirectory` | katalog tymczasowy systemu | Prywatne rejestracje współdzielonego serwera.                   |
| `demo`             | `false`                    | Dane demonstracyjne zamiast bazy Beads.                         |

## Funkcje i granice

- Tablica i listy z filtrami, priorytetami, przypisaniem agentów i hierarchią epików.
- Graf rozróżnia relacje blokowania oraz rodzic–dziecko; gotowość pochodzi z Beads.
- Tworzenie zadań i epików, edycja tytułu/opisu/priorytetu oraz dodawanie relacji.
- Szczegóły, komentarze i historia zachowanych zdarzeń Beads.
- Profile agentów i podgląd logów oraz diffów jawnie powiązanych sesji OpenCode.
- Osobne dane i preferencje wielu projektów; aktualizacje panelu przez SSE.

Status zadań i przypisanie agentów pozostają zarządzane przez Beads/agentów.
Historia obejmuje tylko zachowane zdarzenia, a nie gwarantowany pełny audyt.
Nie ma sprintów, SLA, zdalnego logowania ani uprawnień zespołowych.

## Bezpieczeństwo i prywatność

Serwer nasłuchuje wyłącznie na `127.0.0.1`. Nie wystawiaj go publicznie.
Zapisy wymagają zgodnego Origin, tokenu sesji i walidowanego JSON; komendy CLI
nie są wykonywane przez powłokę. Sesje mogą zawierać wrażliwe logi i diffy:
są przechowywane lokalnie w prywatnym katalogu runtime, nie wysyłane do npm
ani GitHub. Reset bazy w panelu jest operacją destrukcyjną, wymaga osobnego
potwierdzenia i powinien być wykonywany dopiero po zatrzymaniu agentów.

Lokalne bazy `.beads`, konfiguracje narzędzi, archiwa i metadane Windows są
ignorowane przez Git. Paczka npm zawiera wyłącznie jawnie dopuszczone pliki
runtime, licencję, przykład konfiguracji i README.

## Rozwój i weryfikacja

```sh
git clone https://github.com/kosmateus/beads-observer.git
cd beads-observer
npm ci
npm run check
```

| Polecenie              | Działanie                                         |
| ---------------------- | ------------------------------------------------- |
| `npm run lint`         | ESLint; ostrzeżenia powodują błąd.                |
| `npm run lint:fix`     | Automatyczne poprawki ESLint.                     |
| `npm run format`       | Formatowanie Prettier.                            |
| `npm run format:check` | Kontrola formatowania bez zapisu.                 |
| `npm run build`        | Walidacja składni JS i wymaganych plików runtime. |
| `npm test`             | Testy automatyczne Node.js.                       |
| `npm run pack:check`   | Kontrola listy plików paczki npm.                 |
| `npm run demo`         | Lokalny panel demonstracyjny.                     |

Kod jest natywnym ESM, bez kompilacji i bundlera. `npm pack` wykonuje build
przez `prepack`. Testy `test/*.test.js` nie wymagają działającego OpenCode.
Skrypty `test/*.mjs` dla rzeczywistego hosta/przeglądarki są testami ręcznymi,
nie częścią domyślnego CI.

`npm ci` instaluje hooki Husky. Przed commitem `lint-staged` uruchamia ESLint
z automatycznymi poprawkami i Prettiera wyłącznie na staged plikach; błędy
niepoprawialne automatycznie blokują commit. Przed pushem ESLint i Prettier
sprawdzają cały projekt bez zmieniania plików. GitHub CI ponawia kontrole,
ponieważ lokalne hooki nie stanowią zabezpieczenia gałęzi.

## Publikacja

GitHub Actions uruchamia lint, formatowanie, build, testy i kontrolę paczki.
Wymagany check `CI gate` chroni `main`, a zmiany przechodzą przez squash PR.
Scalenie PR uruchamia wydanie według Conventional Commits; workflow `Release`
można też uruchomić ręcznie. Wersja i tag powstają przez semantic-release,
bez bezpośredniego commita do chronionego `main`.

Publikacja używa npm Trusted Publishing (OIDC), bez tokenu npm w repozytorium.
Po pierwszej publikacji opiekun musi skonfigurować zaufanego wydawcę pakietu:
GitHub `kosmateus/beads-observer`, workflow `release.yml`, bez environment.
Pierwsza publikacja nowego pakietu wymaga konta npm z dostępem do `opentoria`.

## Licencja

[MIT](LICENSE).
