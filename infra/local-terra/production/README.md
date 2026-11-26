# Обзор и углублённое чтение новых поступлений через Terra на Mac

Профиль рассчитан на `facade.ftbd.dev`. Producer читает подготовленную опись и адресные фрагменты на VPS. Он отправляет подготовленный запрос по обратному SSH Unix-сокету на Mac. Mac запускает один `gpt-6.1-terra` с effort `high` через локальный Codex. Профиль хранит на Mac хэш допущенного запроса и счётчик при установленном ограничении.

Локальная сборка использует [синтетические тесты транспорта](../../../test/local-terra-production-transport.test.mjs). Тесты проверяют автоматический допуск новых запечатанных поступлений, сохранение первой границы запуска, явный допуск по редакции исторической описи, отказ по старому незавершённому вызову, неизвестный исход после доставки, восстановление SSH и завершение начатого вызова при паузе.

После загрузки сервер распаковывает архивы, обрабатывает доступные документы и сохраняет подготовленную опись. Служба `preliminary` публикует первые 16 оценок и черновик письма. Служба `deep` выбирает адреса для открытых вопросов и ведёт многоходовое чтение на Mac через закрытый `/v1/research`. Источники и результаты инструментов остаются привязаны к редакции документа и поступлению. Новые подтверждённые наблюдения поступают в адресную ревизию матрицы и письма. Текущий предел — четыре участка на поступление и восемь ходов на участок. Обработчик может закончить раньше, а при неизвестном исходе останавливает повторную отправку. Обзор и ревизия учитываются отдельно от этого предела.

Штатный worker готовит документы и индексы. Режим `FACADE_HARNESS_REPLAY_ONLY=1` в нём относится к другим маршрутам модели. Живые запросы новых поступлений проходят через отдельные службы `preliminary` и `deep`. У каждой свой файл активации. Исторический допуск для обзора сам по себе не запускает углублённое чтение.

## 1. Выпуск API и закрытого producer

Оператор выпуска использует полный SHA уже слитого релиза и прежний закреплённый SSH-клиент production. Команды выполняются из Git-репозитория. `ssh_prod` указывает на исполняемый `ssh-prod` из закрытой установки. Он проверяет ключ хоста. Из закрытого профиля экспортируйте `FACADE_TERRA_DEPLOY_HOST` (адрес SSH), `FACADE_TERRA_DEPLOY_HOSTNAME` (ожидаемый `hostname -s`) и `FACADE_TERRA_DEPLOY_APP_DIR` (абсолютный путь к Compose-проекту). Сначала применяется штатный выпуск web/API с той же версией и миграциями. Старый worker остаётся в прежнем режиме до следующих команд.

```sh
git fetch --no-tags origin main
sha=$(git rev-parse origin/main)
test "$(git cat-file -t "$sha")" = commit

source infra/local-terra/production/deploy-profile
require_terra_deployment
"$ssh_prod" "$FACADE_TERRA_DEPLOY_HOST" \
  "test \"\$(hostname -s)\" = '$FACADE_TERRA_DEPLOY_HOSTNAME' && cd '$FACADE_TERRA_DEPLOY_APP_DIR' && docker compose ps && cat published-revision"

infra/local-terra/production/stage "$sha" "$ssh_prod"
curl -fsS https://facade.ftbd.dev/readyz
```

`stage` сверяет контрольные суммы и устанавливает только producer из указанного Git SHA, оверлей Compose и read-only диагностику. Producer монтируется на чтение и использует тот же образ, что API. У существующего каталога релиза переиспользуется совпадающий манифест. Каталог состояния producer сохраняется между релизами.

На VPS выполнить из административной SSH-сессии. На новом выпуске установите `sha` в SHA шага выше. Начальный список для исторических поступлений пуст. Первая установка проходит в паузе, пока оператор проверяет закрытый канал. При обновлении сохраните установленную границу запуска, текущий журнал и действующий список исторических допусков.

```sh
test "$(hostname -s)" = "$FACADE_TERRA_DEPLOY_HOSTNAME"
cd "$FACADE_TERRA_DEPLOY_APP_DIR"
export FACADE_TERRA_RELEASE="$sha"
test "$(cat published-revision)" = "$sha"
test "$(cat "terra/releases/$sha/revision")" = "$sha"
(cd "terra/releases/$sha" && sha256sum --quiet -c SHA256SUMS)
api=$(docker compose ps -q api)
test "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api")" = "$sha"

status_script="terra/releases/$sha/status.mjs"
status() {
  docker compose exec -T worker node --env-file=/run/facade/runtime.env \
    --env-file=/run/facade/models.env --input-type=module - "$@" < "$status_script"
}
stack() {
  docker compose -f compose.yaml -f "terra/releases/$sha/compose.yaml" "$@"
}
status --require-no-active --require-preliminary-schema
grace=$(status --worker-grace)
test "$grace" -ge 60
stack config -q
if ! test -e terra/config/admission.json; then
  tmp=$(mktemp terra/config/admission.XXXXXX)
  printf '[]\n' > "$tmp"
  chown root:10001 "$tmp"
  chmod 0640 "$tmp"
  mv -T "$tmp" terra/config/admission.json
fi
: > terra/config/paused
if test -n "$(stack ps -q preliminary)"; then
  stack exec -T preliminary node --input-type=module - --terra-state /var/lib/facade-terra/state --require-no-active < "$status_script"
fi

docker compose stop -t "$grace" worker
stack up -d --no-deps api worker
status --require-no-active
stack up -d --no-deps preliminary deep
stack ps
```

`status` читает прикладную БД и внешний журнал. Перед остановкой должны отсутствовать `reserved/prepared/sending` в обоих. Если попытка началась между снимком и остановкой, worker завершает текущий ход в пределах grace, вычисленного по тайм-аутам его маршрутов. После замены подтвердите значение `FACADE_HARNESS_REPLAY_ONLY=1` в новом worker. Он продолжает индексацию и переиспользование сохранённых результатов. Если активные попытки остались, producer оставьте на паузе до сверки. Статусы `unknown` остаются в журналах, а новый producer удерживает проекты с такими попытками.

```sh
test "$(stack exec -T worker node -p 'process.env.FACADE_HARNESS_REPLAY_ONLY')" = 1
stack exec -T preliminary node -e '
 const h=require("node:http");
 h.get({socketPath:process.env.FACADE_CONVERTER_SOCKET,path:"/v1/info"},r=>{
   let text=""; r.on("data",c=>text+=c); r.on("end",()=>{
     const p=JSON.parse(text);
     if(r.statusCode!==200 || p.dwgEngine!=="oda" || !p.dwgIdentity) process.exitCode=1;
     else console.log(p.dwgEngine,p.dwgIdentity);
   });
 }).on("error",()=>{process.exitCode=1});
'
```

## 2. Закрытый канал к Mac

На Mac используйте тот же закрытый профиль. Экспортируйте `FACADE_TERRA_DEPLOY_USER` (SSH-пользователь, которому разрешены операции с сокетом) и `FACADE_TERRA_DEPLOY_KEY` (абсолютный путь к его приватному ключу). `trusted_hosts` указывает на проверенный файл known_hosts из закрытой установки. Приватный SSH-ключ и учётная запись Codex остаются на Mac. Профиль устанавливается в GUI-сессию Mac, стартует при входе пользователя и работает независимо от чата. После перезагрузки Mac транспорт восстановится при входе пользователя. Штатное чтение продолжится автоматически, если оператор не оставил паузу.

```sh
"$HOME/.local/bin/codex" login status
infra/local-terra/production/install-mac "$sha" "$trusted_hosts"
mac_run="/tmp/facade-terra-$(id -u)"
launchctl print "gui/$(id -u)/dev.ftbd.facade-terra-bridge" | awk '/state =/{print; exit}'
launchctl print "gui/$(id -u)/dev.ftbd.facade-terra-tunnel" | awk '/state =/{print; exit}'
```

LaunchAgent транспорта поднимает обратный SSH Unix-сокет на VPS, передаёт его UID 10001 с режимом 0600 и переподключается после разрыва. Сервер завершает потерянный туннель после 35 секунд без heartbeat. При переподключении очищается только прежний сокет этого профиля, когда у него нет слушателя. Caddy и сетевые порты в маршруте модели не участвуют. Для постоянной доступности Mac должен оставаться включённым и в пользовательской сессии.

На VPS после запуска двух LaunchAgent проверьте private health из контейнера.

```sh
test -S terra/transport/model.sock
stack exec -T preliminary node -e '
 const h=require("node:http");
 for (const path of ["/health", "/health/research"]) h.get({socketPath:process.env.FACADE_TERRA_PRODUCTION_SOCKET,path},r=>{
   let text=""; r.on("data",c=>text+=c); r.on("end",()=>{
     const result=JSON.parse(text);
     if(r.statusCode!==200 || result.ready!==true || result.busy!==false) process.exitCode=1;
     else console.log(text);
   });
 }).on("error",()=>{process.exitCode=1});
'
```

Здесь ожидается `{"ready":true,"busy":false}` для запуска без дополнительных ограничений на Mac. Пауза на VPS ещё действует, поэтому эта проверка не вызывает Codex и не передаёт документы.

## 3. Автоматическое чтение новых поступлений

При первом запуске под PostgreSQL advisory lock producer сохраняет точное время активации PostgreSQL в `terra/state/state/production-activation`. После снятия общей паузы он автоматически обрабатывает поступления, которые созданы **после** этой границы и запечатаны. После перезапуска используется тот же файл. Исторические поступления старше границы остаются вне автоматической очереди. Адресные попытки, по которым уже есть журнал, можно восстановить без нового вызова.

```sh
test -s terra/state/state/production-activation
test -s terra/state/state/production-research-activation
cat terra/state/state/production-activation
rm terra/config/paused
```

Для адресного пересчёта исторического поступления добавьте точные UUID проекта, поступления и актуальной редакции описи. При изменении подготовки укажите новую редакцию. У текущего отчёта инициируйте штатную переоценку. Чтобы закрыть исторический допуск, удалите его запись атомарной заменой файла.

```sh
tmp=$(mktemp terra/config/admission.XXXXXX)
jq --arg p "$project_uuid" --arg r "$receipt_uuid" --arg m "$manifest_uuid" \
  '. + [{projectId:$p,receiptId:$r,preparationId:$m}] | unique' \
  terra/config/admission.json > "$tmp"
chown root:10001 "$tmp"
chmod 0640 "$tmp"
mv -T "$tmp" terra/config/admission.json
stack exec -T preliminary node --env-file=/run/facade/runtime.env \
  infra/local-terra/producer.mjs --refresh-reading-skills "$receipt_uuid"
```

Mac обрабатывает один запрос одновременно. Отдельный лимит числа вызовов по умолчанию не установлен. При необходимости оператор может включить временный лимит на Mac. Повторное включение того же ID сохраняет израсходованный счётчик. Для снятия временного лимита удалите `limit.json`. Неизвестный исход остаётся на сверке по хэшу запроса и времени, без автоматической повторной отправки.

```sh
umask 077
mac_controls="$HOME/.local/share/facade-terra/production/controls"
tmp=$(mktemp "$mac_controls/limit.XXXXXX")
jq -n --arg id "$(uuidgen | tr 'A-Z' 'a-z')" --argjson max "$approved_calls" \
  '{id:$id,maxCalls:$max}' > "$tmp"
mv "$tmp" "$mac_controls/limit.json"
```

## 4. Пауза и откат

1. Установите общую паузу на VPS командой `: > terra/config/paused` и на Mac командой `: > "$HOME/.local/share/facade-terra/production/controls/paused"`. Проверьте `/health/research` через тот же Unix-сокет. Дождитесь `busy:false` у bridge и урегулируйте `sending` в журнале. Опубликованные версии и сохранённые ответы остаются в тех же БД и каталогах. Для возобновления обычного чтения снимите эти временные паузы.
2. Сверьте агрегаты producer по команде ниже. `responded` означает, что ответ уже сохранён и служба ещё завершает публикацию. `unknown` означает, что исход остаётся на сверке.
3. После дренирования остановите только producer командой `stack stop -t 300 preliminary deep`. Затем остановите LaunchAgent туннеля и bridge. При повторном выпуске сохраните `terra/state` и Mac ledger.
4. Если владелец отдельно возвращает прежние маршруты модели, восстановите прежний worker из базового Compose после сверки обоих журналов. Это снова разрешит прежние production-вызовы. Для восстановления только web/API используйте закреплённый предыдущий образ и штатный откат оператора. Миграции, новые заключения и оригиналы остаются на месте.

```sh
stack exec -T preliminary node --input-type=module - \
  --terra-state /var/lib/facade-terra/state --require-no-active < "$status_script"
stack stop -t 300 preliminary deep
curl -fsS https://facade.ftbd.dev/readyz
```

Возврат прежних маршрутов, когда он отдельно разрешён.

```sh
status --require-no-active
docker compose up -d --no-deps worker
curl -fsS https://facade.ftbd.dev/readyz
```

Команды остановки Mac-профиля после паузы, дренирования и остановки VPS producer.

```sh
launchctl bootout "gui/$(id -u)/dev.ftbd.facade-terra-tunnel"
launchctl bootout "gui/$(id -u)/dev.ftbd.facade-terra-bridge"
```
