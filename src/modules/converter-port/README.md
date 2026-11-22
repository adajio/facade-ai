# Порт конвертеров v1

Фоновый процесс передаёт исходные байты брокеру по HTTP через файловый Unix-сокет. Брокер на Linux запускает одноразовый контейнер из заранее установленного образа по `sha256:<64 hex>`. Только брокер обращается к локальному Docker. Конвертер получает один файл только для чтения, работает без сети и пишет результат в stdout.

## Вызов из приложения

Импорт из `src/modules/converter-port/index.ts` через относительный путь `../converter-port/index.js`. Путь сокета в процессе worker задаёт `FACADE_CONVERTER_SOCKET`.

```ts
type Conversion = "doc" | "xls" | "dwg";
declare function converterImage(operation: Conversion | "archive", signal?: AbortSignal): Promise<string | undefined>;
declare function archiveBytes(source: Buffer | Readable, options: {
  size: number; bytes: number; entries: number; signal?: AbortSignal;
}): AsyncGenerator<Buffer>;
declare function convertBytes(operation: Conversion, input: Buffer, options: {
  image: string; signal?: AbortSignal;
}): Promise<{ bytes: Buffer; sha256: string }>;
```

`converterImage` возвращает закреплённый ID или `undefined` при недоступности. `archiveBytes` выдаёт кадры `extractor.c`. Передавайте точную исходную длину в `size` и оставшиеся лимиты раскрытия в `bytes` и `entries`. Для `convertBytes` передавайте `image` из `converterImage`.

Транспортные и удалённые отказы возвращаются как `ConverterPortError` с полем `code` (`unavailable`, `busy`, `timeout`, `memory_limit`, `resource_limit`, `failed`, `output_missing`, `invalid_request`, `scratch_unavailable`). Клиент сохраняет ошибку исходного потока и причину отмены `signal.reason`. Обрыв ответа до подтверждения результата считается `unavailable`. Прекращение обхода генератора закрывает запрос и отменяет работу. Кадр `done` принимайте после завершения транспортного генератора. `busy`, `unavailable` и `scratch_unavailable` допускают отложенный повтор.

## Установка и ограничения

Владелец стенда запускает `node infra/converters/broker.mjs` в Node.js 24+ с локальным Docker CLI. `FACADE_CONVERTER_SOCKET` на хосте указывает на короткий путь в каталоге, принадлежащем учётной записи брокера. Выдайте каталогу режим `2750` и группу worker, чтобы сокет унаследовал эту группу. Брокер создаёт сокет с режимом `0660`. Монтируйте каталог в вызывающий процесс только для чтения, чтобы после рестарта брокера был виден новый inode. На виртуализированном Docker сокет обоих процессов должен находиться в одной Linux-среде. Владелец брокера управляет выделенным каталогом сокета и удаляет оставшийся файл сокета после аварийного завершения только после подтверждения остановки предыдущего процесса. Сохраните тот же путь сокета при рестарте. Брокер использует его для поиска оставшихся контейнеров своего экземпляра.

Если брокер сам запускается в служебном контейнере, назначьте ему общий с worker именованный Linux-том для сокета. Доступ к локальному Docker API получает только служебный контейнер брокера. Рабочий том `FACADE_CONVERTER_SCRATCH` в таком профиле монтируется в брокер по тому же абсолютному пути, который видит демон Docker.

Брокер получает `FACADE_ARCHIVE_IMAGE`, `FACADE_OFFICE_IMAGE` и `FACADE_DWG_IMAGE` в виде установленных ID `sha256:<64 hex>`. Можно включить отдельные семейства. Исходники образов находятся в [imports](../imports/Dockerfile) и [formats](../formats/Dockerfile), где цели Office/CAD называются `office` и `dwg`. При смене закреплённых образов перезапускайте процессы, которые кэшируют ID из `converterImage`.

`FACADE_CONVERTER_SCRATCH` указывает на рабочий том с местом для seekable копии архива до 10 ГиБ. Путь должен быть доступен демону Docker под тем же абсолютным именем. Брокер обслуживает одну операцию одновременно и удаляет её вход перед подтверждением результата. Владелец стенда учитывает эту копию в общей схеме дисковых резервов либо размещает её на отдельно ограниченном томе. Вызывающему процессу нужен только каталог сокета. При неопределённом исходе создания контейнера или сбое очистки брокер удерживает новые запросы до рестарта и проверки своего scratch и контейнеров.

Протокол использует `GET /v1/info` и `POST /v1/archive|doc|xls|dwg` с `Content-Length`. Для архива нужны `X-Expanded-Bytes` и `X-Archive-Entries`, для DOC/XLS/DWG — `X-Converter-Image` с ожидаемым ID. Брокер проверяет сигнатуру OLE для DOC/XLS и `AC10xx` для DWG до запуска контейнера. `GET` возвращает JSON с ID по названиям операций. Ошибка до выдачи байтов приходит в HTTP-заголовке `X-Converter-Result`. Потоковый HTTP-ответ завершает trailer `X-Converter-Result` со значением `ok` или кодом ошибки. Архивный результат внутри кадров остаётся частью протокола распаковщика.

## Проверка со стороны worker

В окне, выделенном для синтетической проверки, запустите команду в той же Linux-среде, где worker видит сокет. Выберите операции с установленными образами. DOC/XLS берутся из синтетических фикстур шага 11. Для CAD `FACADE_SMOKE_DWG` указывает на синтетический DWG, например полученный из `schedule.dxf` инструментом `dxf2dwg` из закреплённого образа.

```sh
FACADE_CONVERTER_SOCKET=/run/facade-converter/c.sock \
FACADE_SMOKE_DWG=/path/to/synthetic.dwg \
node infra/converters/smoke.mjs archive doc xls dwg
```
