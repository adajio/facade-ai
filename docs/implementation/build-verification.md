# Интеграционная сборка Facade AI 1.1

Базовая спецификация — `42ed7fcf12e243a8520ad89ee827292d4a94b406`. Поставка ведётся локально в `codex/specification-v1.1`. Проверяются установка из двух lock-файлов, штатная сборка, типы, тесты и соответствие запущенного Linux-образа Git-снимку. Маршруты стенда проверяются без записи и без платных вызовов.

## Повторение из исходников

Команды выполняются из корня чистого checkout или распакованного архива с Node.js ≥ 24, npm ≥ 11 и Python 3.

```sh
npm ci
npm --prefix web ci
npm run build
npm run typecheck
npm test
```

Для отдельных проверок приёма, досылки и запуска приложения используйте выделенные PostgreSQL и S3. [Конфигурация стенда](../../infra/test-stand/README.md) · [Сценарий досылки](../../test/e2e-supplements/README.md).

## Находки владельцам модулей

1. **Шаг 11, пофайловый хэш фикстуры.** Исходное правило `* text=auto` в `.gitattributes` при `git add` нормализовало CRLF в `src/modules/formats/test/fixtures/notes.txt` в LF. Исходник и эталон `src/modules/formats/test/gold/SHA256SUMS` дают `03797aa7f500df8dc06eee4aecd752c4c5d47a550ba0060fdfc0e3a3ee51d759`. `git show :src/modules/formats/test/fixtures/notes.txt | shasum -a 256` после обычного staging даёт `4dcf14859e096c95ffa1be20c794ea9f5fadc8e20698d8ec00a68328afc55a7d`. Снимок `stand build` берёт исходные байты через `rsync`, поэтому чистый checkout расходится со снимком стенда. Добавлен атрибут `-text` для этой фикстуры. Индекс и чистый checkout сохраняют исходные байты.

2. **Шаг 6, проверка diff.** `git diff --cached --check -- . ':(exclude)*.pdf'` указывает на пустую строку в конце `src/modules/letters/grounds.ts:87` в первом снимке. Синтетические PDF содержат пробелы в служебных строках формата и сохраняются с исходными байтами.

3. **Шаги 1 и 15, синтетический DOCX.** `npm run test:fixtures` в чистом checkout падает на `test_whole_letter_in_txt_and_docx_is_independent_of_recognition` (`3/4`). `test/fixtures/test_training.py::write_docx` создаёт ZIP только с `word/document.xml`. Действующая `test/acceptance/score.py::docx_text` читает `[Content_Types].xml` и отношения пакета. Отсутствие первого файла проявляется как `KeyError`. Минимальное воспроизведение — `python3 -m unittest discover -s test/fixtures -p 'test_training.py'`. Шагу 1 нужно согласовать синтетический экспорт с контрактом оценщика шага 15. Действующий положительный пример находится в `test/acceptance/test_score.py`. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-fixtures-initial.log>).

4. **Шаги 1, 3 и 7, штатный `npm test`.** Из чистого checkout без окружения тестов `test:node` обнаруживает оба стендовых сценария. `src/modules/intake/intake.integration.test.mjs` сразу вызывает `new URL(DATABASE_URL)` и требует чистую БД `test_step3…` и S3. `test/e2e-supplements/stand.test.mjs` проверяет API, БД, каталог объектов и путь протокола, затем запускает Chromium. Сценарий шага 7 требует API с мигрированной БД. Интеграция шага 3 сама применяет `CREATE TABLE` к начально пустой БД. Для общего запуска нужны раздельные окружения или явные стендовые команды с opt-in. В первом снимке итог Node — 23 прошли, 2 отказа, 19 пропусков. Корневая последовательность останавливается до workspace и Python. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-initial.log>).

Сценарий шага 3 на том же Git-снимке прошёл отдельно: `stand new-db step3_integrator`, затем `node --test src/modules/intake/intake.integration.test.mjs` в окружении собственной пустой PostgreSQL/S3. Итог 1/1, 0 пропусков. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/step3-initial.log>).

## Первый чистый checkout

Снимок `69750df7354fc8c381a1de81d580c0350764420f` проверен на внешнем SSD, `/Volumes/cargo/facade-ai-integration-20261122/checkout`. macOS arm64, Node `25.9.0`, npm `11.17.0`, Python `3.14.3`. Использованы отдельный пустой кэш npm и пустые конфиги user/global. Каталоги `experiments/`, `contracts/`, корневой `fixtures/` и незатреканный `AGENTS.md` отсутствовали.

| Команда | Результат |
|---|---|
| `npm ci --prefer-offline --no-audit --no-fund` | 0, 301 пакет. npm помечает транзитивный `glob@11.1.0` устаревшим. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/npm-ci-root.log>) |
| `npm --prefix web ci --prefer-offline --no-audit --no-fund` | 0, 51 пакет. npm сообщает об install scripts `esbuild` и `fsevents`. Vite собрал web. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/npm-ci-web.log>) |
| `npm run build` | 0, сервер и web. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/build-initial.log>) |
| `npm run typecheck` | 0, svelte-check без ошибок и предупреждений. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/typecheck-initial.log>) |
| `npm test` | 1, 23 прошли, 2 отказа, 19 пропусков в Node. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-initial.log>) |
| `npm run test:workspaces` отдельно | 0, у workspace нет собственных `test` scripts. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-workspaces-initial.log>) |
| `npm run test:fixtures` отдельно | 1, 3 прошли, ошибка синтетического DOCX. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-fixtures-initial.log>) |
| `npm run test:acceptance` отдельно | 0, 8/8. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/test-acceptance-initial.log>) |

## Первый наблюдавшийся стенд

По TLS с локальным сертификатом проверен `https://127.0.0.1:18443`. `/healthz` и `/readyz` — `200` JSON. `/`, `/login` и `/projects` — `200` HTML. Фактические JS и CSS — `200`. Анонимный `/api/me` — `401`. Неизвестные API и asset — `404`. Запросы только GET. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-initial.log>).

API и worker использовали образ `sha256:30591ca79031dc37236a9cf7b46d9325b4ec85b76ac7db4e10f46a0575acfff3` с манифестом `ddfac215ffa4f95a0bdc51d220db6f152693e23011bd2e749419719573b71b14`. Метка Git образа указывает на базовую спецификацию. Воссоздание контекста по алгоритму `stand build` из первого чистого checkout даёт `23b8f68043648c884d3c3f76cbfeed9a8cba49f2624fa14275c0e8f141f16136`. Отличаются 19 путей, в том числе навигация поступления, harness, сверки, CAD и `notes.txt`. [Пофайловое сравнение](</Volumes/cargo/facade-ai-integration-20261122/logs/manifest-diff-initial.log>).

## Кандидат после исправлений

`d23dbff88af5c2d76a78d78b26bae3207c1bc7b6`. Манифест чистого контекста `stand build` содержит 232 записи. Ожидаемый SHA-256 для API и worker — `40ec8bd88e44b5cc255244810e10432fe2e02a40e5a1f3b65641891abe255103`. Этот кандидат доступен владельцу шага 14 для сборки после нагрузочного окна. На момент сверки действующий образ имел прежний манифест и расходился по 22 путям. Контроль `notes.txt` уже совпал. [Манифест](</Volumes/cargo/facade-ai-integration-20261122/logs/manifest-candidate.sha256>) · [Сверка с запущенными контейнерами](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-candidate.log>).

В новом чистом checkout прошли обе установки `npm ci`, `npm ls --all` в корне и web, `npm run build`, `npm run typecheck` и `npm test`. Node — 23 прошли, 0 отказов, 19 пропусков. Python — 4/4 проверки учебных фикстур и 8/8 проверок приёмочных инструментов. Workspace с самостоятельными `test` scripts отсутствуют. SHA-256 совпал у всех 21 оригинала в `src/modules/formats/test/gold/SHA256SUMS`. [Команды и статусы](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/status.log>) · [Лог тестов](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/test.log>) · [Хэши фикстур](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/format-fixtures.log>).

Из 19 пропусков в корневом наборе 7 относятся к проверкам шлюза с PostgreSQL, журналом и управляемым сервером. Остальные 12 покрывают оценку, три Linux-проверки форматов, worker harness, две проверки импорта, письма, PDF, две проверки вопросов и доступ. Для них нужны выделенные сервисы, конвертеры или флаги сценария. Имена и отметки `SKIP` есть в логе. Отдельные команды `npm run test:stand:intake` и `npm run test:stand:supplements` без окружения завершились кодом 2 с перечнем отсутствующих настроек. [Диагностика приёма](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/unconfigured-intake.log>) · [Диагностика досылки](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/unconfigured-supplements.log>).

`npm run test:platform:stand` на первом снимке прошёл на отдельных PostgreSQL и S3 после `stand new-db step1`. Сценарий проверил сортировку и целостность миграций, параллельное применение, откат и повтор, запуск API и worker, закрытый S3. [Лог](</Volumes/cargo/facade-ai-integration-20261122/logs/platform-stand-initial.log>).

На кандидате `d23dbff` команды проверены с отдельными окружениями. `npm run test:stand:intake` — 1/1 на чистых PostgreSQL и S3. `npm run test:stand:supplements` — 5/5, включая обе очередности допуска, историю письма и курсор ленты. Для досылки применены 13 миграций, запущены локальный API и два контекста Chrome. Worker оставался выключен. [Приём](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/opt-in/intake.log>) · [Досылка](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/opt-in/supplements.log>) · [Миграции](</Volumes/cargo/facade-ai-integration-20261122/logs/candidate/opt-in/supplements-migrate.log>).

## Кандидат с восстановлением worker

`f11ac1b7685493fc164cb55c1598385fbf802f79`. Зафиксированы изменения владельца шага 9, в том числе старт без управляемого транспорта и возобновление `route_reconciliation` и `journal_unavailable` при доступном журнале и известном расходе. После добавления `stand build reader <GIT_REF>` сравнение ведётся по снимку `git archive`. Для него ожидаемый SHA-256 манифеста API и worker — `edfb422084621d79e3e38f87badfc234b1a6097100da4324c388058db5fbd8a1`, 234 записи, включая `web/.gitignore` и `src/modules/formats/.dockerignore`. Прежнее копирование рабочего дерева фильтрует эти два файла и даёт `f2d3eb015026e644a38fe165af481da4605a3b865a4fc3aca30049c02ec84686`, 232 записи. [Манифест точного Git-среза](</Volumes/cargo/facade-ai-integration-20261122/logs/manifest-runtime-git.sha256>) · [Сверка с первым образом](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-runtime-git.log>).

Чистая проверка `f11ac1b` повторена. Оба `npm ci`, `npm ls --all`, сборка и проверка типов завершились кодом 0. `npm test` — 23 Node прошли, 19 пропущены, 0 отказов. Python — 4/4 и 8/8. Обе стендовые команды без требуемого окружения вернули код 2. [Команды и статусы](</Volumes/cargo/facade-ai-integration-20261122/logs/runtime/status.log>) · [Тесты](</Volumes/cargo/facade-ai-integration-20261122/logs/runtime/test.log>).

В 09:00 МСК оба контейнера на `https://127.0.0.1:18443` использовали `sha256:534262c3b7740ed1e49da6ab5b049f6176e988058239cd4654d5f3cf71440502` (`linux/arm64`) с Git-меткой `f11ac1b7685493fc164cb55c1598385fbf802f79`. Побайтовый `diff` манифеста от `git archive` с сохранённым манифестом сборки завершился кодом 0. Повторились все 10 HTTP-результатов из первого наблюдения. Изменившийся JS успешно загружен. Тэг работающего брокера совпал с расчётом из Git-байтов `Broker.Dockerfile` и `broker.mjs`. [Идентичность](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-deployed-runtime.log>) · [HTTP](</Volumes/cargo/facade-ai-integration-20261122/logs/routes-deployed-runtime.log>) · [Брокер](</Volumes/cargo/facade-ai-integration-20261122/logs/broker-identity.log>).

Архив этого развёрнутого снимка содержит ровно 286 отслеживаемых файлов Git. SHA-256 архива — `03319260da83bd83cfc84b5eeadc0760b3013a3f65feab9767df22aca3299ae5`. [Архив f11ac1b](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-f11ac1b76854.tar.gz>) · [Контрольная сумма](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-f11ac1b76854.tar.gz.sha256>).

Первый результат удержания сохраняется отдельно для манифеста `ddfac215ffa4f95a0bdc51d220db6f152693e23011bd2e749419719573b71b14`. В проверках шага 15 часть работ сохранялась в `held/route_reconciliation`. Сверка шага 9 нашла 402 завершённых попытки с квитанциями и ноль неизвестных исходов. На 75-секундной отсечке смешанного тёплого пакета завершились 23 из 130 обязанностей. Результаты исправленной версии имеют собственный протокол и хэши. [Приёмка шага 15](acceptance.md#холодный-тёплый-и-offline-технический-прогон).

## Снимок с типизированной непередачей и отдельными допусками

`a7608c39e28d3ea2e5989a78df249b93193d0eaf`. Включены изменения оценивания непередачи, раздельный допуск A/B/ведущего и миграция `09_harness_z_route_bindings.sql`. Ожидаемый SHA-256 для `stand build reader a7608c3` — `c9e5d3f1389949ae8e9e37abe6ef08071ae21d0a739138477c58c35b5927cead`, 237 записей. [Манифест](</Volumes/cargo/facade-ai-integration-20261122/logs/manifest-integrated.sha256>) · [Сверка с f11ac1b до переключения](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-integrated.log>).

Из чистого checkout на внешнем SSD прошли `npm ci`, `npm --prefix web ci`, оба `npm ls --all`, `npm run build`, `npm run typecheck` и `npm test`. Node — 25 прошли, 0 отказов, 20 пропусков, включая новую проверку раздельного допуска на управляемой подмене HTTP-транспорта. Python — 4/4 и 8/8. Все 21 хэш исходников форматов совпали. Обе opt-in команды без окружения вернули код 2. [Команды и статусы](</Volumes/cargo/facade-ai-integration-20261122/logs/integrated/status.log>) · [Тесты и пропуски](</Volumes/cargo/facade-ai-integration-20261122/logs/integrated/test.log>).

На выделенной PostgreSQL сначала применены 13 миграций `f11ac1b`. Переход на `a7608c3` добавил только `09_harness_z_route_bindings.sql`. Следующий запуск сообщил `Database migrations are current`. В реестре совпали 14 SHA-256 и появилась таблица `harness_route_bindings`. [Исходная схема](</Volumes/cargo/facade-ai-integration-20261122/logs/upgrade-baseline.log>) · [Обновление и повтор](</Volumes/cargo/facade-ai-integration-20261122/logs/integrated/upgrade.log>).

Повтор на `a7608c3` с выделенными PostgreSQL и S3 прошёл. `npm run test:stand:intake` — 1/1. `npm run test:stand:supplements` — 5/5 в Chrome, API запущен с отдельной БД, worker выключен. [Приём](</Volumes/cargo/facade-ai-integration-20261122/logs/integrated/opt-in/intake.log>) · [Досылка](</Volumes/cargo/facade-ai-integration-20261122/logs/integrated/opt-in/supplements.log>).

В 09:25 МСК оба контейнера на `https://127.0.0.1:18443` работали из образа `sha256:8a72c8c6c450aab3ac462b583f0cdd893148297ea2b1e0b2861b4aad25d678d8`. Git-метка обоих контейнеров — `a7608c39e28d3ea2e5989a78df249b93193d0eaf`. Манифесты Docker и Git из 237 записей совпали побайтово. Все 10 HTTP-проверок повторились. SHA-256 реально выданных JS и CSS совпали с файлами из чистой локальной сборки. [Пофайловая сверка](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-deployed-integrated.log>) · [Маршруты](</Volumes/cargo/facade-ai-integration-20261122/logs/routes-deployed-integrated.log>) · [Хэши web](</Volumes/cargo/facade-ai-integration-20261122/logs/assets-deployed-integrated.log>).

Пакет развёрнутого `a7608c3` проверен по составу Git и SHA-256. Архив содержит 301 Git-файл. [Архив](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-a7608c39e28d.tar.gz>) · [Контрольная сумма](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-a7608c39e28d.tar.gz.sha256>).

В управляемом прогоне неполного пакета на `a7608c3` шаг 15 получил `confirmed_missing`, подтвердил вывод через интерфейс и выгрузил черновик. При сверке ожидаемого адреса в TXT и DOCX обнаружено отсутствие строки 2 и редакции N05 реестра. Исправление проверяет владелец шага 6. [Матрица приёмки](acceptance.md).

## Финальный кодовый снимок

`201dc935748f2f7f1c3525273b652f8f775866ca`. Включены адрес и подтверждённая редакция оригинала в письме, диагностика HTTP 404 в квитанции шлюза и поздние изменения стендовых сценариев. SHA-256 манифеста для `stand build reader 201dc935748f2f7f1c3525273b652f8f775866ca` — `0149bb6f963eaa8695a92e63d136e92a79c0d332e8f4d39a0deb7e0100bb759a`, 238 записей. Lock-файлы и SQL-миграции совпадают с `a7608c3`. [Манифест](</Volumes/cargo/facade-ai-integration-20261122/logs/manifest-final-code.sha256>) · [Пофайловое сравнение до переключения](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-final-before.log>).

Отдельный чистый checkout на внешнем SSD прошёл `npm ci`, `npm --prefix web ci`, оба `npm ls --all`, `npm run build`, `npm run typecheck` и `npm test`. Node — 26 прошли, 0 отказов, 21 пропуск. Python — 4/4 и 8/8. Проверены 21 SHA-256 оригиналов форматов. На отдельных PostgreSQL и S3 прошли адресные проверки assessment 2/2 и писем 3/3. Они покрывают закреплённую опору, TXT/DOCX, блокировку старой текущей выдачи и открытие отправленной истории. [Команды и статусы](</Volumes/cargo/facade-ai-integration-20261122/logs/final/status.log>) · [Тесты и пропуски](</Volumes/cargo/facade-ai-integration-20261122/logs/final/test.log>) · [Assessment](</Volumes/cargo/facade-ai-integration-20261122/logs/final/addressed/assessment.log>) · [Письма](</Volumes/cargo/facade-ai-integration-20261122/logs/final/addressed/letters.log>).

На отдельных БД и бакетах `npm run test:stand:intake` прошёл 1/1, `npm run test:stand:supplements` прошёл 5/5 в Chrome. Обе команды проверены с подключённой инфраструктурой и диагностикой отсутствующих настроек. В инженерных проверках этой поставки использованы локальные синтетические данные. Платные вызовы в этих проверках отсутствовали. [Приём](</Volumes/cargo/facade-ai-integration-20261122/logs/final/opt-in/intake.log>) · [Досылка](</Volumes/cargo/facade-ai-integration-20261122/logs/final/opt-in/supplements.log>).

## Финальная сверка стенда

В 09:37 МСК работающие API и worker на `https://127.0.0.1:18443` использовали образ `sha256:718559d76800364e629ee4f19feae42503e543b52f4f0b9453d93a136a62ba71` с Git-меткой `201dc935748f2f7f1c3525273b652f8f775866ca`. Манифесты образа и чистого Git-снимка совпали побайтово по всем 238 записям. `/healthz`, `/readyz`, страницы и их JS/CSS вернули `200`. Анонимный `/api/me` вернул `401`. Неизвестные API и файл вернули `404`. SHA-256 загруженных JS/CSS совпали с локальной сборкой. Отдельный API шага 15 на `127.0.0.1:18085` отдал `ready` с тем же тэгом образа. [Манифесты](</Volumes/cargo/facade-ai-integration-20261122/logs/stand-identity-deployed-final.log>) · [Маршруты](</Volumes/cargo/facade-ai-integration-20261122/logs/routes-deployed-final.log>) · [Сравнение web](</Volumes/cargo/facade-ai-integration-20261122/logs/assets-deployed-final.log>) · [Отдельный API](</Volumes/cargo/facade-ai-integration-20261122/logs/step15-final-ready.log>).

Архив построен из точного кодового коммита стенда `201dc93`. Состав совпал с 302 отслеживаемыми Git-файлами, ревизия подтверждена заголовком архива. SHA-256 архива — `defd0f54c74dea183faebc26e466a60cb71c58ef241ba1c5c4430acdcc835a27`. SHA-256 извлечённого из архива CRLF-оригинала `notes.txt` совпал с эталоном. [Архив исходников](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-201dc935748f.tar.gz>) · [SHA-256](</Volumes/cargo/facade-ai-integration-20261122/facade-ai-1.1-201dc935748f.tar.gz.sha256>) · [Проверка состава](</Volumes/cargo/facade-ai-integration-20261122/logs/package-final.log>).

Владелец стенда на том же образе подтвердил строку 2 и N05 для непередачи и оба адреса N05 для конфликта. TXT и DOCX каждого письма совпали по тексту. После offline-повтора сохранились хэши и прежние идентификаторы попыток. Формулировки обоих писем отличаются от предварительного эталона, поэтому критерий полного текста AC06 остаётся открытым. Историческая запись о попытке OpenRouter с неизвестным исходом и её резерв сохранены после переключения стенда. [Адресный повтор и журнал](../../infra/test-stand/RESULTS.md#финальный-кодовый-снимок-и-адресный-повтор-писем).
