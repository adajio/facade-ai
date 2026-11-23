# Проверка области действия V7 и M3 для Guide offset 44/51 мм

23 ноября 2026 года. Проверка использует исходный пакет на SSD-стенде `127.0.0.1:18449` и замороженный срез SHA‑256 `c1a1919248094302812c392b047f7a7fbc38c3d991aa5dc9f3d5056ec89dc202`. В срезе 20 наблюдений и 321 событие. Для обеих версий используется готовый индекс из 9 блоков и 111 строк. Исходная версия приложения — `174188af8a831e21b86098af25d5a1e8d91efef4`, версия оценки — 3. [Проверка среза до переключения](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/before/freeze.json>)

## Две страницы PDF

Исходный файл `22-guide-elevations.pdf` скачан как инженер. SHA‑256 `5b228b23ba3deec90fb46f3d00c846b249d7a2cc7d4df1ee12d4ce0cb6fad478`. Обе полные страницы отрисованы Poppler и сопоставлены с буквальным текстом и рамками строк из индекса. [Полная страница 1](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/originals/guide-page-1.png>) · [Полная страница 2](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/originals/guide-page-2.png>) · [Индексированные адреса и цитаты](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/originals/pdf-indexed-lines.json>)

| Вид и фасад | Заголовок и идентичность | Исполнение и редакция | Размер |
| --- | --- | --- | --- |
| Страница 1, north sector, `FX-00AB-Q`, `Atrium-C2A4`, оси `D4-D8` | `1.0.0.0` название вида, `1.0.2.0` фасад, корпус и оси | `1.0.3.0` «Mark: LK-00AB \| Variant: V7» при `x=47, y=152.1`. `1.0.1.0` «Document role: drawing \| Stage: RD \| Revision: M3 \| current» при `x=47, y=84.1` | `1.0.4.0` «Guide offset: 44 mm», исходная числовая опора в правом окне `x=414, y=186.1` |
| Страница 2, south sector, `FX-00AB-T`, `Pylon-03DA`, оси `D4-D8` | `2.0.0.0` название вида, `2.0.2.0` фасад, корпус и оси | `2.0.3.0` та же марка и `V7`, `2.0.1.0` та же `M3 current` и печатная `RD` | `2.0.4.0` «Guide offset: 51 mm» по другому фасаду |

На первой странице заголовок, строка фасада, исполнение и размер образуют один адресуемый вид. Строка размера повторяет фасад, корпус и оси. Страница 2 служит отрицательным контролем. По одному совпадению марки, осей, исполнения и редакции нельзя переносить размер между этими видами. Строки `1.0.5.0` и `2.0.5.0` содержат лишь «Detail reference: view 2 / east line».

## Книга XLSX

Оригинал `31-element-register.xlsx` скачан как инженер. SHA‑256 `64d2b67e1aa35fa7e7f457ab273e6096ba829b7efd3752702c4bc9d40ab16835`. Прямой разбор всех трёх листов по XLSX XML подтвердил следующие адреса. [Ячейки книги](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/originals/xlsx-cells.json>)

| Адрес | Печатное содержание |
| --- | --- |
| `Current data!A1` | Роль `schedule`, печатная `RD`, `M3 current` |
| `Current data!E3:I3` | Марка `LK-00AB`, `V7`, `M3`, 51; `I3` привязывает 51 мм к `FX-00AB-Q`, `Atrium-C2A4`, `D4-D8` и `M3 current` |
| `Current data!I4` | 51 мм и те же марка, исполнение и редакция для `FX-00AB-T`, `Pylon-03DA` |
| `Archived values!I3` | 35 мм для `FX-00AB-Q`, пометка `M3 superseded` в самой строке |
| `Survey and limits!I3`, `I4` | 46 мм с явной ролью `Measurement` и 37 мм с ролью `Limit` для `FX-00AB-Q` |

В записи `Current data!I3` указана роль источника `Schedule`. Назначение самого значения и правило приоритета между чертежом и ведомостью остаются открытыми.

## Исходная оценка и допуск

В версии 3 открыта одна карточка `44 мм / 51 мм` с поводом для проверки сопоставимости. У PDF исполнения и редакции в карточке ещё нет, у XLSX указаны `V7` и `M3 current`. В PDF и XLSX сохранены два адресных предложения стадии `RD`, по строке `1.0.1.0` и ячейке `Current data!A1`. Стадия проекта не подтверждена, закреплённого каталога и подтверждённых типов фасада нет. Штатный выбор каталога под владельцем вернул `stage_unknown`. [Исходные ответы API](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/before/readout.json>)

Общий уровень, `FX-00AB-Q` и `FX-00AB-T` получили `needs_review`. Вопросов каталога и допустимых пунктов письма по 0. В реестре пусто. Допуск письма проверен чтением, подтверждения и письма в этом прогоне не создавались.

## Карточка на итоговой версии

На `fa00eebf33bf0419d0ba5b7012f43ea30070b6f4` штатная оценка версии 4 выдала одну карточку для `FX-00AB-Q`. Новая часть карточки связывает размер 44 мм на странице 1 с исполнением `V7` марки `LK-00AB` и с пометкой `M3 current` в заголовке листа. В заголовке видна печатная `RD`. Причины `variant_unproven` и `revisions_unproven` сняты с этой карточки. [Итоговый экран](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-card.png>) · [Штатная оценка API](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/readout.json>)

В Chrome проверены оба основных открытия и четыре адресные кнопки контекста PDF. Открытия исходных файлов и сохранённых представлений дали HTTP 200, SHA‑256 совпали. Для кнопок названия вида, области, исполнения и редакции показаны строки `1.0.0.0`, `1.0.2.0`, `1.0.3.0`, `1.0.1.0` соответственно, все на странице 1. В контексте `FX-00AB-T` карточек нет. Запись `Current data!I4` осталась отдельным наблюдением. [PDF 44 мм](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-source-pdf-p1.png>) · [XLSX 51 мм в I3](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-source-xlsx-i3.png>) · [Основание V7](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-v7-pdf-p1.png>) · [Основание M3 и RD](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-m3-pdf-p1.png>) · [Протокол Chrome](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/browser.json>)

## Допуск к сверке и письму

44 и 51 мм остаются кандидатной парой. Сопоставимость требует подтверждения (`comparability_unproven`). Стадия проекта ожидает решения владельца (`project_stage_unconfirmed`), а стадия по выбранной опоре ведомости `I3` остаётся открытой (`source_stage_unproven`). Печатная `RD` из заголовков обоих материалов доступна как основание. Рабочий каталог не закреплён, штатный выбор каталога возвращает `stage_unknown`. Требуются правило сопоставимости чертежа и ведомости с приоритетом источников (`comparison_rule_unproven`) и назначение каждого значения (`value_role_unproven`). Штатная пакетная оценка показала ноль проверенных пар. [Адресные основания RD](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/stage-witnesses.json>) · [Причины в карточке](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-card.png>)

| Контекст | Исход | Допустимые пункты письма |
| --- | --- | ---: |
| Общий уровень | `needs_review` | 0 |
| `FX-00AB-Q` | `needs_review` | 0 |
| `FX-00AB-T` | `needs_review` | 0 |

Реестр писем пуст. Кнопка создания черновика недоступна. В ходе проверки решений, черновиков и отправок не создано. [Экран письма](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/engineering-letters.png>) · [Контроль записей решений, стадий и писем](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/domain.txt>)

## История, целостность и доступ

Ответы API для исторических версий 2 и 3 совпали с сохранёнными ответами, включая все 20 наблюдений в каждой версии. В Chrome версия 3 показала прежнюю карточку с открытыми вопросами исполнения и редакции. Текущая версия 4 использует тот же frozen-срез и тот же индекс. До и после совпали контрольные суммы 20 наблюдений, 321 события, 34 доказательств, 20 фактов, 15 заданий, двух грантов, шести оригиналов и индекса из девяти блоков и 111 строк. Новых эффектов и попыток моделей 0, расход $0. Совпали контрольные суммы шлюза и внешнего журнала. [Историческая карточка](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/historical-card.png>) · [Итоговая проверка записей](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/freeze-after.json>) · [Внешний журнал](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/journal.txt>)

Проверку выполнили `./verify-scope-version.sh fa00eebf33bf0419d0ba5b7012f43ea30070b6f4` и Chrome 157 под инженером. На точном SHA прошло 35 регрессионных проверок, включая неоднозначные и устаревшие заголовки. Промежуточный `8c369ed7` впервые сформировал оценку 4. Итоговый образ вернул ту же текущую оценку через штатный API. [Версия образа](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/image-fa00eebf33bf0419d0ba5b7012f43ea30070b6f4.txt>) · [Проверки классификации](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/evidence/scope/after/row-tests.log>)

Итоговая версия доступна инженеру. Логин `pkgintake_guide_live_engineer`. [Карточка на стенде](http://127.0.0.1:18449/projects/e82f9682-4fd0-4c8f-897f-79550fc0a7cb/completeness?context=f368b523-acaf-4b4d-a712-2bc8fc676ac2) · [Локальный файл пароля](</Volumes/ADATA SE920/OrbStack/.facade-ai-guide-offset-composition-20261123/credentials/engineer>)
