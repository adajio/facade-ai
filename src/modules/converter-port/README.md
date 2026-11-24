# Порт конвертеров v1

Фоновый процесс передаёт исходные байты брокеру по HTTP через файловый Unix-сокет. Брокер на Linux запускает одноразовый контейнер из заранее установленного образа по `sha256:<64 hex>`. Только брокер обращается к локальному Docker. Конвертер получает один файл только для чтения и работает без сети. Архив и Office используют stdout. DWG записывает проверенную производную в приватный каталог брокера на диске.

## Вызов из приложения

Импорт из `src/modules/converter-port/index.ts` через относительный путь `../converter-port/index.js`. Путь сокета в процессе worker задаёт `FACADE_CONVERTER_SOCKET`.

```ts
type Conversion = "doc" | "xls" | "dwg";
declare function converterImage(operation: Conversion | "archive", signal?: AbortSignal): Promise<string | undefined>;
declare function archiveBytes(source: Buffer | Readable, options: {
  size: number; bytes: number; entries: number; signal?: AbortSignal;
}): AsyncGenerator<Buffer>;
declare function dwgProfile(signal?: AbortSignal): Promise<{ id: string; timeout: number; reserve: number } | undefined>;
declare function convertDwg(source: Readable, output: Writable, options: {
  size: number; image: string; timeout: number; signal?: AbortSignal;
  checkSpace?: (size: number) => Promise<void>;
}): Promise<{ size: number; sha256: string }>;
declare function convertBytes(operation: "doc" | "xls", input: Buffer, options: {
  image: string; signal?: AbortSignal;
}): Promise<{ bytes: Buffer; sha256: string }>;
```

`converterImage` возвращает закреплённый ID или `undefined` при недоступности. `archiveBytes` выдаёт кадры `extractor.c`. Передавайте точную исходную длину в `size` и оставшиеся лимиты раскрытия в `bytes` и `entries`. Для `convertBytes` передавайте `image` из `converterImage`. Для `convertDwg` используйте размер оригинала и профиль `dwgProfile`. Считайте файл пригодным к чтению после успешного завершения `convertDwg`.

Транспортные и удалённые отказы возвращаются как `ConverterPortError` с полем `code` (`unavailable`, `busy`, `timeout`, `memory_limit`, `resource_limit`, `failed`, `output_missing`, `invalid_request`, `scratch_unavailable`). Клиент сохраняет ошибку исходного потока и причину отмены `signal.reason`. Обрыв ответа до подтверждения результата считается `unavailable`. Прекращение обхода генератора закрывает запрос и отменяет работу. Кадр `done` принимайте после завершения транспортного генератора. `busy`, `unavailable` и `scratch_unavailable` допускают отложенный повтор.

## Установка и ограничения

Владелец стенда запускает `node infra/converters/broker.mjs` в Node.js 24+ с локальным Docker CLI. `FACADE_CONVERTER_SOCKET` на хосте указывает на короткий путь в каталоге, принадлежащем учётной записи брокера. Выдайте каталогу режим `2750` и группу worker, чтобы сокет унаследовал эту группу. Брокер создаёт сокет с режимом `0660`. Монтируйте каталог в вызывающий процесс только для чтения, чтобы после рестарта брокера был виден новый inode. На виртуализированном Docker сокет обоих процессов должен находиться в одной Linux-среде. Владелец брокера управляет выделенным каталогом сокета и удаляет оставшийся файл сокета после аварийного завершения только после подтверждения остановки предыдущего процесса. Сохраните тот же путь сокета при рестарте. Брокер использует его для поиска оставшихся контейнеров своего экземпляра.

Если брокер сам запускается в служебном контейнере, назначьте ему общий с worker именованный Linux-том для сокета. Доступ к локальному Docker API получает только служебный контейнер брокера. Рабочий том `FACADE_CONVERTER_SCRATCH` в таком профиле монтируется в брокер по тому же абсолютному пути, который видит демон Docker.

Брокер получает `FACADE_ARCHIVE_IMAGE`, `FACADE_OFFICE_IMAGE` и `FACADE_DWG_IMAGE` в виде установленных ID `sha256:<64 hex>`. Можно включить отдельные семейства. Исходники образов находятся в [imports](../imports/Dockerfile) и [formats](../formats/Dockerfile), где цели Office/CAD называются `office` и `dwg`. При смене закреплённых образов перезапускайте процессы, которые кэшируют ID из `converterImage`.

`FACADE_CONVERTER_SCRATCH` указывает на рабочий том с местом для seekable копии архива до 10 ГиБ. Путь должен быть доступен демону Docker под тем же абсолютным именем. Брокер обслуживает одну операцию одновременно. Он удаляет вход и производную перед подтверждением результата. Владелец стенда учитывает эту копию в общей схеме дисковых резервов либо размещает её на отдельно ограниченном томе. Вызывающему процессу нужен только каталог сокета. При неопределённом исходе создания контейнера или сбое очистки брокер удерживает новые запросы до рестарта и проверки своего scratch и контейнеров.

Для DWG лимит входа совпадает с лимитом поступления 10 ГиБ. После записи
входа брокер отнимает резерв от свободного места и отдаёт до половины остатка
под производную. Вторая половина учитывает временную копию reader на той же
файловой системе. Этот бюджет применяется через `RLIMIT_FSIZE` и к DXF, и к
JSON. После обрыва DXF запись удаляется перед восстановлением. Храните scratch
на выделенном томе или учитывайте одновременных пользователей диска при выборе
резерва. Worker проверяет свободные байты в `TMPDIR` перед записью и удаляет
имя временного файла сразу после его открытия. Завершение worker освобождает
дисковое место вместе с файловым дескриптором.

`FACADE_DWG_MEMORY_MIB` задаёт память контейнера (по умолчанию 1536),
`FACADE_DWG_TIMEOUT_SECONDS` задаёт срок конвертации (420),
`FACADE_DWG_SCRATCH_RESERVE_BYTES` задаёт свободный резерв (1 ГиБ).
Сроки загрузки и выдачи DWG составляют по 1800 с. Брокер передаёт итоговый
клиентский дедлайн в `dwgClientTimeoutMs` и резерв в `dwgReserveBytes` через
`/v1/info`. Операции DOC и XLS сохраняют лимит по 16 МиБ на вход и выход.

Протокол использует `GET /v1/info` и `POST /v1/archive|doc|xls|dwg` с `Content-Length`. Для архива нужны `X-Expanded-Bytes` и `X-Archive-Entries`, для DOC/XLS/DWG — `X-Converter-Image` с ожидаемым ID. Брокер проверяет сигнатуру OLE для DOC/XLS и `AC10xx` для DWG до запуска контейнера. `GET` возвращает JSON с ID по названиям операций. Ошибка до выдачи байтов приходит в HTTP-заголовке `X-Converter-Result`. Потоковый HTTP-ответ завершает trailer `X-Converter-Result` со значением `ok` или кодом ошибки. У DWG заголовок `X-Converter-Bytes` объявляет размер готового файла.
Успешный трейлер повторяет размер и сообщает `X-Converter-Sha256`.
Клиент сверяет их с принятым потоком. Брокер, DWG-образ с записью в
`/out/derivative` и worker с `convertDwg` обновляются вместе.
Архивный результат внутри кадров остаётся частью протокола распаковщика.

## Проверка со стороны worker

В окне, выделенном для синтетической проверки, запустите команду в той же Linux-среде, где worker видит сокет. Выберите операции с установленными образами. DOC/XLS берутся из синтетических фикстур шага 11. Для CAD `FACADE_SMOKE_DWG` указывает на синтетический DWG, например полученный из `schedule.dxf` инструментом `dxf2dwg` из закреплённого образа.

```sh
FACADE_CONVERTER_SOCKET=/run/facade-converter/c.sock \
FACADE_SMOKE_DWG=/path/to/synthetic.dwg \
node infra/converters/smoke.mjs archive doc xls dwg
```
