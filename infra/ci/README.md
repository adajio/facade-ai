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
