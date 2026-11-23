# Приём оригиналов · v1.1, шаг 3

Срез плана `42ed7fc`. Миграции [03_intake_schema.sql](../../../db/migrations/03_intake_schema.sql) и [03_intake_z_prepare.sql](../../../db/migrations/03_intake_z_prepare.sql) и [03_intake_zz_manifest.sql](../../../db/migrations/03_intake_zz_manifest.sql). Точка подключения [index.ts](index.ts). Маршруты приложения начинаются с `/api`.

## Программный API

Транзакционные функции получают уже открытый `pg.PoolClient`. Для HTTP проверка проекта, аудит и квитанция команды использует штатный исполнитель шага 2. Фоновые вызывающие проверяют назначение ресурса своему проекту перед обращением к приёмке.

| Экспорт | Соглашение |
| --- | --- |
| `declareOriginal(tx, storage, { projectId, receiptId, uploadId?, relativePath, size, sha256, mediaType?, scopeIds?, replacesVersionId?, importId?, parentOccurrenceId? })` | Возвращает ID загрузки, вхождения и удержания, срок, размер и состояние частей. Шаг 10 задаёт устойчивый `uploadId` на узел. Повтор декларации с тем же ID и описанием возвращает текущее состояние. |
| `writePart(db, storage, { projectId, uploadId, number, length, sha256 }, stream, authorize?)` | `db` — `pg.Pool`. Возвращает подтверждение части после записи на диск и в БД. Номера с 1. Последняя часть может быть короче. |
| `finalizeOriginal(db, storage, { projectId, uploadId }, authorize?)` | Проверяет размер и SHA-256 собранных байтов и закрытого объекта. Публикует вхождение, оригинал, версию, очередь и событие одной транзакцией. Повтор возвращает те же `originalId, documentId, versionId, occurrenceId, jobId`. |
| `openOriginal(db, storage, projectId, versionId, range?)` | Внутренний поток для reader и распаковки с `sha256, size, mediaType, relativePath`. Диапазон `{start, end}` включительный. Для прямых клиентских обращений используется авторизованный HTTP. |
| `declareImport(tx, { projectId, receiptId, importId?, scopeIds? })` | Создаёт запись `intake_imports` и устойчивую причину до запуска загрузчика. Шаг 10 в той же транзакции создаёт своё задание. |
| `updateImport(tx, { projectId, receiptId, importId, status, reason?, expectedVersion? })`, `cancelImport(tx, { projectId, receiptId, importId })` | Состояния `queued, running, paused, completed, limited, failed, cancelled`. Отмена требует остановки загрузчика и отсутствия принятых или объявленных материалов этого импорта. |
| `completeOccurrenceInventory(tx, { projectId, receiptId, occurrenceId, restriction? })` | Завершает обход контейнера. Код ограничения сохраняется в описи. |
| `lockDiskReservations(tx)`, `intakeUnwrittenBytes(tx)` | Шаг 10 использует тот же транзакционный дисковый замок и учитывает обещанные байты intake. Приём учитывает активные резервы временных файлов шага 10. |

Если импорт или контейнер уже объявлен, связанные дочерние файлы можно объявить после seal. У них сохраняются `importId` и/или `parentOccurrenceId`; применяется удержание исходного импорта или корневого вхождения. Повторяющиеся исходные пути сохраняются как отдельные вхождения. Совпадающие байты внутри проекта имеют один объект. Для связи редакций требуется явный `replacesVersionId` того же проекта.

## PostgreSQL и соседи

- **Шаг 7.** В общей транзакции сначала вызвать `lockIntakeProject(tx, projectId)`, затем `lockProjectScopes` из access и взять блокировки зависимостей. `getIntakeGate(tx, projectId, scopeId)` возвращает `{ generation, projectGeneration, holds }`. Причина содержит `id, receiptId, source, sourceId, generation, version, scopeIds`. `null` у `scopeIds` означает неизвестную применимость ко всему проекту, включая новые области. `resolveIntakeHold(tx, {projectId, holdId, generation, version, scopeIds})` сужает причину или закрывает её при `scopeIds: null`. Проверку влияния и запись оснований выполняет шаг 7 в той же транзакции. Для законченного импорта с принятыми материалами проверяйте состояния `completed`, `limited` и `failed` по смыслу ограничения. Закрытая причина, её последняя область и история сохраняются. Отмена и истечение пустой передачи закрывают только её причину.
- **Шаг 4/8.** `intake_reader_jobs` содержит `id, project_id, receipt_id, document_id, version_id, original_id, created_at, dispatched_at`. Планировщик забирает недоставленные строки через `FOR UPDATE SKIP LOCKED`, создаёт запись своей очереди с устойчивым ключом `version_id` и фиксирует `dispatched_at` в той же транзакции. Состояние распознавания принадлежит планировщику. Тип берётся из `intake_document_versions.media_type`, путь из `intake_occurrences.relative_path`.
- **Шаг 7/13.** `intake_events(id, project_id, receipt_id, type, data, created_at)` — транзакционный журнал. `intake.receipt_created`, `intake.upload_declared`, `intake.original_ready`, `intake.receipt_sealed`, `intake.held`, `intake.hold_narrowed`, `intake.hold_closed` и события отмены/импорта служат сигналами перечитать авторизованный снимок. Подтверждённый прогресс частей читается в GET загрузки или описи. Общий курсор проекта обслуживает шаг 7.
- **Шаг 10.** Публикация контейнера вызывает `queueArchive` в той же транзакции и сохраняет `inventoryPending` до окончания обхода. Открытая опись учитывает seal, активные передачи, импорты и незаконченные обходы. Отмена требует отсутствия исполняемой работы; шаг 10 проверяет собственную аренду до вызова.

## HTTP и автоматическая проверка

| Метод и путь относительно `/api` | Вход и результат |
| --- | --- |
| GET /projects/:projectId/intake/capabilities | `{partSize, maxReceiptBytes, uploadTtlSeconds, diskGuardBytes, channels}` |
| POST /projects/:projectId/receipts | `{source?: "upload" \| "import"}` → 201 `{receiptId, number, source, sealed, inventoryOpen}` |
| GET /projects/:projectId/receipts?state=uploading | `{receipts, nextCursor}` для списка возобновляемых поступлений |
| POST /receipts/:receiptId/uploads | `{relativePath, size, sha256, mediaType?, scopeIds?, replacesVersionId?}` → 201, тот же формат, что у GET загрузки |
| GET /uploads/:uploadId | `{receiptId, occurrenceId, uploadId, holdId, status, size, sha256, partSize, expiresAt, parts, confirmedBytes}` |
| PUT /uploads/:uploadId/parts/:number | Тело `application/octet-stream`, `Content-Length` и `X-Part-SHA256` → 200 `{number, offset, length, sha256}` |
| POST /uploads/:uploadId/complete | `{}` → 200 `{receiptId, uploadId, occurrenceId, originalId, documentId, versionId, jobId, mediaType}` |
| POST /uploads/:uploadId/cancel | `{}` → 200 `{uploadId, status}` |
| POST /receipts/:receiptId/seal | `{}` → 200 `{receiptId, sealed}` |
| GET /receipts/:receiptId/inventory | `{receiptId, number, sealed, inventoryOpen, uploads, occurrences, imports}` |
| GET /documents/:documentId/versions/:versionId/content | 200 или 206, `Accept-Ranges: bytes`, `Cache-Control: no-store`. Закрытые, открытые и суффиксные одиночные диапазоны. Неудовлетворимый диапазон — 416. |

Запись требует сеанса, Origin и `X-CSRF-Token`. POST также требует `Idempotency-Key`. SHA-256 передаётся в hex. После обрыва браузер сверяет выбранный файл по размеру и хэшу и продолжает с карты подтверждений. `upload_busy` (409) при записи во время другой операции означает, что ту же команду можно повторить с тем же ключом. `part_conflict` (409) требует повторного чтения карты. `intake_disk_reserve` (429) допускает повтор декларации после освобождения ресурса. Просмотр PDF использует URL версии, возвращённой при публикации. Ссылка на объект S3 в UI отсутствует.

[Сценарий HTTP](intake.integration.test.mjs) работает на выделенной свежей БД и закрытом bucket со штатными командами доступа. Шаг 13 может воспроизвести в браузере последовательность декларации, обрыва, двух завершений, чтения Range и отзыва доступа. Из корня после сборки и загрузки окружения отдельной БД `step3` выполните `node --test src/modules/intake/intake.integration.test.mjs`. Сценарий сам применяет миграции 02, 03 и 10. `INTAKE_TEST_DIST` позволяет указать каталог изолированной сборки.

## Объявленный состав поступления

- `POST /api/projects/:projectId/receipts` с `{receiptId?, mode: "once" | "open", items}` создаёт поступление и целиком сохраняет состав версии 1. Повтор с тем же `Idempotency-Key` возвращает квитанцию. В браузере UUID поступления служит также ключом этой команды, поэтому после потери ответа клиент может найти запись по этому UUID.
- Пункт файла содержит `itemId, kind: "file", relativePath, size, sha256, mediaType?, scopeIds?, replacesVersionId?`. Сервер выделяет архив по формату. Пункт источника содержит `itemId, kind: "link", url, scopeIds?`. Задание получения ссылки сохраняется в той же транзакции. Публичный URL хранится в задании, а опись возвращает его идентификатор и состояние. Один запрос объявляет целую редакцию состава. Предел в 10 000 пунктов действует на поступление.
- `POST /api/receipts/:receiptId/manifest` с `{manifestVersion, items}` дополняет открытый приём и возвращает следующий номер редакции. `POST /api/receipts/:receiptId/seal` принимает `{manifestVersion}` и закрывает приём после завершения оставшихся входов. У прежних поступлений `manifest: null` и ручная команда seal с пустым телом.
- `GET /api/receipts/:receiptId/inventory` возвращает `projectId` и `manifest: {mode, version, items}`. Каждый пункт показывает подтверждённые байты текущей попытки, срок, состояние и причину ограничения. `POST /api/receipts/:receiptId/manifest/:itemId/upload` возвращает текущую загрузку или создаёт её. При истечении срока `{restartUploadId}` открывает новую попытку, сохраняя стабильный ID пункта и историю. Для частей и завершения используются существующие маршруты загрузки.
- `POST /api/receipts/:receiptId/manifest/:itemId/exclude` принимает `{manifestVersion, uploadId?, importId?, reason}`. Исключение сохраняет автора и ограничивает выводы о составе. Уже принятый оригинал остаётся доступным. `POST /api/receipts/:receiptId/manifest/:itemId/retry` с `{importId}` возвращает в очередь приостановленное получение или источник, который не удалось открыть для построения описи.
- Оригинал контейнера считается принятым после проверки байтов. Для источника по ссылке приём подтверждается после успешного получения объявленных файлов. Разовый приём закрывается транзакционно при завершении последнего пункта. Раскрытие архива и ограничения отражаются независимо от seal. `inventoryOpen` сообщает, идут ли ещё работы по описи. При формулировании вывода об объёме нужно проверить явные исключения и ограничения раскрытия.
- Карточка принятой версии доступна по `/projects/:projectId/receipts/:receiptId?document=<versionId>&row=<occurrenceId>`. Возврат по `?row=<occurrenceId>` переводит фокус на ту же строку. Оба адреса работают после перезагрузки.

## Хранение

- `FACADE_S3_ENDPOINT`, `FACADE_S3_BUCKET`, `AWS_REGION`, учётные данные AWS SDK. Используется закрытый bucket с доступом серверных ролей. Оригиналы лежат под `originals/<projectId>/<uploadId>`. Части находятся в приватном `FACADE_DATA_DIR/intake-parts`, который должен сохраняться между запусками API.
- Предел исходной передачи — 10 ГиБ на поступление. Настройки `FACADE_INTAKE_PART_BYTES` (8 МиБ), `FACADE_INTAKE_TTL_SECONDS` (7 суток) и `FACADE_INTAKE_DISK_GUARD_BYTES` (40 ГиБ) применяются на установке. Текущий расчёт допуска предполагает один физический пул диска для staging, S3 и временных файлов импорта. Перед первой частью резервируется пик сосуществования частей и закрытого объекта.
- Активная загрузка хранит части до принятия, отмены или истечения срока. Если объект был записан до сбоя транзакции, новый исполнитель проверяет тот же ключ и хэш и публикует ссылку при повторе. Очистка берёт блокировку конкретной загрузки, сверяет ссылки на закрытый объект и удаляет временные части. На bucket настраивается срок очистки незавершённых S3 multipart, которые мог оставить остановленный процесс.
