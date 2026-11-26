# Локальный GitHub Actions Runner

Workflow `Facade CI` запускает четыре задания на PR и коммитах в `main`. На GitHub у `main` обязательны `Build`, `Typecheck`, `Tests` и `Contracts`. Политика репозитория требует подтверждения запуска для внешних форков.

Сборка использует Node.js 24, Poppler, Tesseract, Python и jsonschema 4.26.0. Для каждого задания контроллер получает одноразовую конфигурацию GitHub и запускает свежий контейнер. Контейнер подключён только к изолированной сети и выходит через прокси с разрешёнными доменами. Контроллер работает вне контейнера. GitHub CLI должен быть авторизован у владельца хоста.

## Установка на хосте

OrbStack должен хранить данные на внешнем SSD. Из корня репозитория выполните команды для сетей и образов этого раннера.

```sh
docker --context orbstack network create --internal --subnet 172.31.250.0/28 \
  --opt com.docker.network.bridge.gateway_mode_ipv4=isolated facade-ai-ci-private
docker --context orbstack network create --subnet 172.31.250.16/28 facade-ai-ci-uplink
docker --context orbstack build --target runner -t facade-ai-ci-runner:2.338.2 infra/ci
docker --context orbstack build --target proxy -t facade-ai-ci-proxy:1 infra/ci
docker --context orbstack run -d --name facade-ai-ci-proxy --restart unless-stopped \
  --network facade-ai-ci-uplink --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 facade-ai-ci-proxy:1
docker --context orbstack network connect --alias facade-ci-proxy \
  facade-ai-ci-private facade-ai-ci-proxy
```

На Mac установите `run-local.sh` в `~/Library/Application Support/Facade AI CI` и запустите через пользовательский LaunchAgent `com.adajio.facade-ai-ci` с `RunAtLoad` и `KeepAlive`. Добавьте пути к `gh`, `jq` и `docker` в `PATH` агента и направьте журналы в `~/Library/Logs/Facade AI CI`. Образы, рабочие каталоги и данные заданий находятся на внешнем SSD в хранилище OrbStack.

Права администратора GitHub требуются локальному контроллеру для получения конфигурации. Проверьте состояние агента командой `launchctl print "gui/$(id -u)/com.adajio.facade-ai-ci"` и онлайн-статус раннера в Actions. Когда Mac, SSD или OrbStack недоступны, задания ожидают подключения раннера.

## Локальное наблюдение за Contracts (этап A)

Из корня checkout на Linux или macOS запустите существующую проверку контрактов под внешним наблюдением. Нужен интерпретатор с `jsonschema==4.26.0`, как в образе CI. В локальном профиле проекта доступен офлайн-кэш uv.

```sh
uv run --offline --with jsonschema==4.26.0 python -B infra/ci/observer/observe.py --reports .local/contracts-runs
python3 -B infra/ci/observer/observe.py --reports .local/contracts-runs --synthetic-hang
python3 -B -m unittest discover -s infra/ci/observer -p 'test_*.py' -v
```

Первая команда запускает [штатный валидатор](../../contracts/check_examples.py) отдельной группой процессов. После успешного выхода она возвращает 0, если получены квитанции всех групп схем. Один раз учитывается каждая строка результата известной группы. Сырые потоки исполнителя в отчёт не попадают. По умолчанию режим `observe-only` записывает время без порогов. Для оценки предложенного порога можно передать `--observe-stage-ms`, `--observe-attempt-ms` или `--observe-silence-ms`. Первое превышение оставляет запись `would_stop`, проверка продолжается. Для полного отключения запустите напрямую `python3 contracts/check_examples.py` в том же окружении. В обычном PR действует прямой вызов.

Вторая команда запускает только встроенную синтетическую фикстуру. После создания дочернего процесса она повторяет одну квитанцию и heartbeat. Тестовый предел тишины равен 400 мс, пределы этапа и попытки — 5 и 6 секунд. При остановке наблюдатель посылает SIGTERM своей группе, при необходимости SIGKILL и проверяет исчезновение группы. Ожидаемый код CLI при этой демонстрации — 1. Результат остановки находится в поле `cancellation`. Ctrl+C или SIGTERM запрашивает остановку запущенной оператором группы.

Путь к журналу печатается до запуска исполнителя. В каталоге отчётов хранится один JSONL на UUID запуска. Наблюдатель сбрасывает на диск каждую запись, включая `queued`, `started`, новые контрольные точки и терминальный исход. `queue_ms` здесь измеряет локальное ожидание до создания процесса. Ожидание слота GitHub Actions измеряется отдельно по данным Actions. У выбранной команды один этап, поэтому его абсолютные часы и часы попытки стартуют вместе. До первой надёжной контрольной точки применимы только абсолютные пределы.

При повторной доставке укажите тот же `--run-id UUID` и каталог. Блокировка исключает параллельный запуск. Завершённый результат переиспользуется при совпадении SHA, входов, среды и режима. После потери наблюдателя повторное обращение фиксирует `observer_lost` по последнему сохранённому событию. Состояние процесса остаётся неподтверждённым. Сигналы по сохранённому PID не отправляются. Независимому запуску соответствует новый UUID. Автоматических повторов в этапе A нет.

Встроенные аренды, контрольные точки и остановки исследований принадлежат [продуктовому worker](../../src/modules/harness/README.md). У наблюдателя нет подключения к базе worker, шлюзу моделей или релизу. Его обслуживает разработчик харнеса. Python переиспользует среду единственной выбранной проверки и POSIX API стандартной библиотеки. При выборе следующей точки запуска границу адаптера следует пересмотреть.
