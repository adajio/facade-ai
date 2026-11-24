const ruNumber = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
const ruDate = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });
const labels: Record<string, string> = {
  queued: 'В очереди',
  leased: 'В работе',
  done: 'Завершено',
  waiting_route: 'Ожидается маршрут',
  response_pending: 'Ожидается ответ маршрута',
  job_not_waiting: 'Доступен только для ожидающей работы',
  no_resumable_stop: 'Для этой остановки ручное продолжение недоступно',
  continuation_requested: 'Запрос уже принят',
  operator_reconcile_attempt: 'Техническому оператору нужно сверить журнал отправок',
  operator_reconcile_route: 'Техническому оператору нужно сверить журнал маршрута',
  research_profile_unavailable: 'Ожидается доступный профиль чтения',
  research_route_not_approved: 'Ожидается разрешённый маршрут',
  research_gateway_unconfigured: 'Ожидается настройка маршрута чтения',
  route_denied: 'Ожидается разрешение на маршрут',
  original_only: 'Доступен оригинал',
  cad_external_reference: 'Содержимое внешних ссылок не раскрыто',
  cad_font_substitution: 'Шрифты на схеме могут быть заменены',
  cad_entity_type_unsupported: 'Тип объекта доступен по адресу, схема для него неполная',
  cad_entity_geometry_unavailable: 'Геометрия объекта недоступна для схемы',
  cad_converted_handle_unverified: 'Адрес относится к производной DWG',

  pending: 'Ожидает',
  running: 'В работе',
  uploading: 'Передача',
  processing: 'Обрабатывается',
  open: 'Открыта',
  sealed: 'Зафиксирована',
  complete: 'Завершено',
  completed: 'Завершено',
  ready: 'Готово',
  partial: 'Частично',
  stopped: 'Остановлено',
  failed: 'Ошибка',
  canceled: 'Отменено',
  cancelled: 'Отменено',
  held: 'На удержании',
  covered: 'Покрыто',
  sufficient: 'Достаточно',
  missing: 'Подтверждена нехватка',
  conflict: 'Противоречие',
  insufficient: 'Есть подтверждённые проблемы',
  internal_review: 'Требуется внутренняя сверка',
  unknown: 'Требуется внутренняя сверка',
  mixed: 'Смешанный исход',
  confirmed: 'Подтверждено',
  draft: 'Черновик',
  sent: 'Отправлено',
  needs_review: 'Требуется пересмотр',
  project_manager: 'Владелец проекта',
  engineer: 'Инженер',
  viewer: 'Просматривающий',
  org_admin: 'Администратор организации',
  operator: 'Оператор',
  technical_operator: 'Технический оператор',
  confirmed_missing: 'Подтверждена нехватка',
  confirmed_conflict: 'Подтверждённое противоречие',
  confirmed_problems: 'Есть подтверждённые проблемы',
  excluded: 'Исключено решением инженера',
  can_start: 'Можно начать',
  cannot_start: 'Начинать нельзя',
  can_start_with_limitations: 'Можно начать с ограничениями',
  received: 'Получено',
  not_demonstrated: 'Получение не установлено',
  readable: 'Читаемо',
  unreadable: 'Нечитаемо',
  empty: 'Поиск завершён без находок',
  searching: 'Идёт поиск',
  verified: 'Проверено',
  explicit_non_delivery: 'Свидетельство непередачи',
  exhaustive_inventory: 'Проверенная опись',
  review_incomplete: 'Сверка ещё не завершена',
  applicability_unknown: 'Применимость не установлена',
  comparison_unresolved: 'Сопоставимость требует проверки',
  repeated_rejected_action: 'Инструмент повторил отклонённое действие',
  turn_limit: 'Исчерпан предел ходов',
  input_size_limit: 'Превышен размер входа',
  effect_conflict: 'Сохранённый запрос требует сверки',
  route_bound_unavailable: 'Предел расходов требует сверки',
  analysis_prior_effect: 'Техническому оператору нужно сверить прежнюю отправку по этому месту',
  unknown_charge: 'Исход отправки требует сверки',
  route_receipt_mismatch: 'Квитанция не совпала с маршрутом',
  http_429: 'Маршрут ограничил запросы',
  invalid_arguments: 'Инструмент отклонил аргументы',
  unit_not_in_evidence: 'Единица не связана с исходной цитатой',
};

export function label(value: unknown, placeholder = '—'): string {
  if (typeof value !== 'string' || !value) return placeholder;
  return labels[value] ?? value;
}

export function count(value?: number | null): string {
  return typeof value === 'number' ? ruNumber.format(value) : '—';
}

export function bytes(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  const power = Math.min(units.length - 1, value === 0 ? 0 : Math.floor(Math.log(value) / Math.log(1024)));
  return count(value / 1024 ** power) + ' ' + units[power];
}

export function date(value?: string | null): string {
  const instant = value && new Date(value);
  return !instant || isNaN(instant.getTime()) ? '—' : ruDate.format(instant);
}

export function text(value: unknown, fallback = '—') {
  return typeof value === 'string' && value ? value : fallback;
}
