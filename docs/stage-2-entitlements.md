# Stage 2 — серверные entitlement и месячная квота

Дата проверки: 2026-10-27. Все изменения локальные; commit, deploy и применение SQL в Supabase не выполнялись.

## Фактически проверено на живом Supabase

Проект из `.env`: `vzmpwstfddznsvypudhj`. После resume Data API отвечает 200. В URL есть завершающий `/`; для прямых HTTP-запросов его нужно убирать, иначе `//rest/v1/` возвращает неподходящий ответ. supabase-js нормализует URL самостоятельно.

Сохранён безопасный снимок OpenAPI: `docs/supabase-schema-observed.json`. В нём нет ключей или текстов вопросов.

- `questions`: id bigint (primary key), created_at timestamptz с default, store_domain text NOT NULL, question_text text NOT NULL, product_context text nullable.
- Существующих строк: 20. Они не изменялись.
- В Data API пока только `questions` и `store_settings`; RPC Stage 1/2 отсутствуют.
- Нужные для INSERT миграции 001 поля и типы совпадают. Но OpenAPI не подтверждает identity/default у id и не показывает triggers, constraints целиком и определения RLS. Поэтому полного PASS совместимости пока нет.
- Anon-ключ получил 206 и count 20 при `questions?select=id&limit=1`: текущие вопросы читаются анонимно. Это реальное наблюдение доступа, а не определение конкретной RLS-политики. Закрытие существующих политик относится к Stage 3 и требует проверки реальной конфигурации.
- Supabase/Vercel установлены по данным менеджера плагинов, но в текущем наборе инструментов нет их SQL/deployment API. service key в .env позволяет Data API, но не произвольный SQL. Database URL и management token не настроены. Для проверки каталогов подготовлен `scripts/supabase-readonly-preflight.sql` (BEGIN READ ONLY).

## Изменения Stage 2

- Новая миграция создана Supabase CLI: `supabase/migrations/20261027142546_server_entitlements_and_monthly_quota.sql`. Применяется после существующей `migrations/001_chat_request_idempotency.sql`.
- `cc_stores` — owner_id, стабильный store ID, домен, план, quota_override, статус, access_start/access_until, monthly_anchor, настройки. Новые записи по умолчанию inactive. Данные Auth user_metadata не импортируются как права.
- `cc_usage_periods` хранит расход по месячным периодам. Периоды вычисляются от исходного anchor в UTC; Jan 31 → Feb 28/29 → Mar 31. Для годового доступа квота всё равно обновляется помесячно.
- `claim_chat_request` под блокировкой строки магазина проверяет доступ, текущий расход + ещё не завершённые резервы и резервирует один ответ до AI. Блокировка не удерживается во время сетевого AI-запроса.
- Completion использует тот же порядок блокировок: store → request. В одной транзакции создаёт question, увеличивает месячный used, закрывает reservation и сохраняет ответ.
- Ошибка/timeout не расходуют quota. Устаревший reservation перестаёт занимать слот; поздний worker не может создать вторую запись. Снижение лимита и pause во время AI перепроверяются перед успешным completion.
- Старые вопросы сохраняются. При первой инициализации периода учитываются только старые строки внутри этого месяца. Новые события получают cc_request_id и явную привязку к периоду, чтобы ответ на границе месяца не считался дважды.
- Закрытые функции размещены в cc_private; публичные RPC — SECURITY INVOKER wrappers, вызываемые service_role. Authenticated может читать свои новые store/usage строки по RLS, но не редактировать тариф/лимиты. Anon не читает новые таблицы.
- `api/chat.js` больше не ищет plan/limit через listUsers/user_metadata и не считает all-time questions. Authoritative решение приходит из DB reservation. При ошибке DB допуска к AI нет.
- Платный тон и white-label/exit intent/theme gating опираются на серверный plan. Переданный покупателем systemInstruction не определяет голос бренда. Универсальная база знаний/prompt injection остаются Stage 8; UI developer/mock сохранён для тестов, полномочия этим UI не выдаются.
- `api/account.js` проверяет Supabase user через getUser(token), выбирает только его store и возвращает authoritative snapshot. PATCH разрешает настройки, домен и ограниченную manual cancellation flag, но не plan/limit/owner/access_until. Для Paddle cancellation возвращается ошибка до реализации billing integration; оплаченный доступ frontend не продлевает.
- Кабинет, Insights и локальная admin overview читают plan/limits из protected store. Админские изменения плана/лимита/days/pause записывают protected store; user_metadata остаётся только compatibility mirror. Механизм админского JWT/email allowlist сохранён.
- Config route общий для Express и Vercel. Config URL виджета выводится из data-api (или data-config), чтобы тестовый/custom backend не обращался к случайному localhost:3000.

## Результаты проверок

Базовые Stage 1: исходные 28/28 PASS до изменений.

Финальный набор: 44/44 PASS на момент записи отчёта (`npm test`). Реальные SQL-функции выполнялись в PGlite. Проверены:

- 25 разных конкурентных ID при quota=1: одна генерация/запись, 24 отказа;
- повторная доставка одного ID;
- возврат reservation после AI failure;
- unknown/inactive/paused/expired store, лимит 0;
- подмена plan/query_limit/user_metadata и попытки редактировать entitlement через account API;
- owner isolation по RLS новых таблиц, запрет прямых frontend writes и закрытых RPC;
- Jan 31, високосный февраль, граница месяца, исключение старой all-time истории;
- attribution ответа к зарезервированному месяцу;
- pause и downgrade во время генерации;
- проверка владения store и token failure в account handler;
- сохранение настроек и cancellation flag без продления access_until;
- все прежние тесты widget, idempotency, rollback и counters.

Реальный браузер + HTTP + PGlite + synthetic AI:

1. Вопрос через настоящий widget UI → синтетический ответ → rows=1, usage=1, generations=1; поле ввода снова доступно.
2. Новый запрос и повтор с тем же request_id → одинаковый ответ, только одна дополнительная запись (rows=2, usage=2).
3. 12 параллельных запросов за последним слотом → accepted=1, blocked=11, rows=3, usage=3, reserved=0, generations=3.

Стенд воспроизводится: `node tests/fixtures/integration-server.js` (напечатанный localhost URL). Он использует отдельную БД в памяти и не читает .env. Для чистого повторения нужно перезапустить стенд. Screenshot сохранён в папке visualizations текущего чата.

Это НЕ live Supabase write/AI тест. Параллельные handler-вызовы и SQL проверены поверх одного PGlite engine; нагрузка на несколько реальных PostgreSQL connections/Vercel instances ещё не проверялась.

## Что нужно до применения

1. Выполнить read-only preflight в правильном Supabase и проверить RLS/triggers/identity id. Ничего не менять.
2. Выбрать отдельный тестовый проект/branch. Согласовать применение 001 и Stage 2; текущий восстановленный проект используется существующим приложением и без разрешения не меняется.
3. Подготовить проверенное соответствие owner UUID → store/domain и вручную подтверждённые plan/access dates. Не копировать непроверенные user_metadata.plan как оплаченные права. Без provisioned store запросы правильно получают отказ.
4. Применить обе миграции на test окружении, затем одной версией проверить API/widget/account и реальные вопросы. Отдельно проверить ограничения/таймаут Vercel и разрешённую длительность функций.
5. Только после этого согласовывать production rollout. SQL добавляет таблицы/колонки/индексы и не удаляет старые questions; отзыв browser INSERT из 001 требует согласованной выкладки.

Оставшиеся границы: существующие questions RLS, доказательство происхождения storefront request (Stage 3), полный API abuse control, Vercel admin parity (Stage 4), Paddle lifecycle (Stage 5), onboarding новых stores (Stage 6), подлинные analytics events (Stage 7). Ни одна из них не объявлена завершённой текущими тестами.

Следующий практический шаг: read-only preflight каталогов и тестовое применение после согласования. Если SQL-доступ не появится, Stage 3 можно продолжать локально, сохраняя live-проверку как незавершённую.

После финальных правок периода/счётчика: targeted usage suite 18/18 PASS; синтаксис 6 inline scripts dashboard/insights/admin PASS. В админке обработан query_limit=0, чтобы не получался NaN. Изолированный браузерный стенд после проверки остановлен.

