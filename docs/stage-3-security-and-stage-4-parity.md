# Stage 3 и подготовка Stage 4 — 2026-10-27

Изменения локальные. Production SQL, RLS, данные и настройки не изменялись; commit/deploy не выполнялись.

## Фактический preflight

Пользователь выполнил `scripts/supabase-readonly-preflight.sql` в SQL Editor. Краткий результат сохранён в `supabase-preflight-confirmed.json` без ключей и содержимого вопросов.

`questions.id` — bigint GENERATED ALWAYS AS IDENTITY; created_at имеет default; обязательны store_domain и question_text; product_context nullable. Единственное ограничение — PK, пользовательских триггеров нет. INSERT миграции 001 не задаёт id и совместим с этой структурой. Это проверка определения, а не заявление об успешном применении SQL к Supabase.

RLS включён. Подтверждены политики anon SELECT USING true и INSERT WITH CHECK true; политика authenticated использует user_metadata.store_domain. Это небезопасная конфигурация. Факт эксплуатации посторонними не установлен. Наличие широких UPDATE/DELETE grants само по себе не доказывает возможность этих операций: соответствующие RLS-политики в снимке отсутствуют.

## Stage 3

- Вопросы, email, домены, названия тарифов и сообщения toast выводятся как текст. Динамические admin onclick заменены addEventListener; ID/email записываются через dataset. URL-параметры ID кодируются.
- Сохранены все кнопки админки, ADMIN_EMAILS и проверка Supabase JWT. Макеты и темы не перерабатывались.
- Добавлены widget sessions: серверный HMAC, срок 5 минут, привязка store ID/origin/epoch. Смена домена или владельца отзывает прежние сессии. Проверенный store ID/epoch перепроверяются под блокировкой при резервировании квоты.
- Обычная storefront-сессия выдаётся только для подтверждённого домена и соответствующего HTTPS origin. Подтверждение — DNS TXT `_claritycart-verification.<domain>` со случайным серверным challenge. GET/POST `/api/verify-domain?store_id=<id>` требуют Bearer пользователя-владельца.
- Для local/first-party preview разрешена сессия владельца после getUser(token). Developer UI/mock разрешается только после серверного подтверждения admin email из ADMIN_EMAILS. Тестовый выбор тарифа не меняет authoritative entitlement.
- Настройки `previewAccessToken` нужны только для авторизованного preview. Нельзя встраивать настоящий Supabase access token в публичный storefront/snippet. В тестовом стенде используется фиктивный токен.
- Chat принимает Authorization: Widget <session>. Подписи, origin, store, epoch, размер/структура входа проверяются до AI. Ограничения: body 32 KiB, question 2000 символов, title 500, description 16000, price 100, глубина/число узлов JSON ограничены.
- Ограничения частоты хранятся в БД, а не в памяти инстанса: 30 session requests/IP/min, 30 chat requests/IP/min, 120 chat requests/store/min. SQL использует атомарный UPSERT. IP хранится только как HMAC bucket, срок хранения bucket — до суток. Это фиксированные календарные окна, а не sliding window.
- На localhost IP берётся из socket, произвольный X-Forwarded-For игнорируется. На Vercel используется платформенный x-vercel-forwarded-for; реальные заголовки/прокси-конфигурация ещё требуют preview-проверки.
- Origin и публичная сессия не являются абсолютной защитой от ботов: HTTP-клиент способен имитировать Origin. Ограничения частоты и authoritative quota остаются обязательными. При реальном abuse возможна дополнительная платформенная защита; она сейчас не настраивалась.

## Подготовленная миграция Stage 3

`supabase/migrations/20261027152654_widget_security_and_store_binding.sql`, после 001 и Stage 2:

- Добавляет DNS challenge, verified_at и epoch, приватные rate buckets и service-only RPC.
- Отзывает клиентские grants на questions, включая column-level grants; authenticated получает только SELECT через owner policies. Старые политики не удаляются, но обязательная RESTRICTIVE policy ограничивает их результат стабильным store ID.
- Не использует изменяемый user_metadata как право доступа.
- Legacy questions с cc_store_id NULL сохраняются, но не становятся доступными по одному совпадению домена. Учёт legacy тоже переведён на явно назначенный cc_store_id в ещё не применённой миграции Stage 2.
- Перед включением новых API нужны проверенные owner/store записи и согласованное назначение cc_store_id старым вопросам. Сделать это до первого создания usage period; автоматический перенос прав из старых user_metadata запрещён. История не удаляется, но без mapping не будет видна клиенту и не попадёт в новый месячный расход.

## Stage 4

- server.js экспортирует фабрику Express app; слушает порт только при прямом запуске. Vercel entrypoints admin/webhook/live-sync/health/validate-domain используют тот же app. Node API chat/config/account/session/verification используют общие модули.
- Local proxy передаёт Origin/Authorization. При отсутствии local AI key widget-session также проксируется в тот же remote API; локальной записи usage на proxy path нет.
- Live-sync и cancellation feedback требуют проверенного владельца; присланные email/plan не определяют полномочия. Preview cache содержит только оформление, не права или квоты.
- Общая AI-инструкция теперь одинакова для local/Vercel и не требует выдуманного превосходства над конкурентами. Полноценная knowledge pipeline/prompt-injection проверка остаётся Stage 8.
- Express блокирует доступ к backend/SQL/docs/tests и нормализует URL перед проверкой. API-файлы не раздаются как static source.
- `npm run build` копирует 14 явно разрешённых public assets в dist. Backend, SQL, docs, tests и .env исключены. vercel.json подготовлен для static output + Node API; maxDuration 60. Настройки живого проекта не изменены.

## Выполненные проверки

- DOM/XSS unit tests: внешние значения остаются текстом, inline handlers отсутствуют, admin actions получают исходные аргументы без выполнения кода.
- Реальный браузер `/xss`: PASS=true, executed=0, attackElements=0, literalText=true. Использованы реальные функции render из admin/dashboard, но синтетические данные.
- Реальный браузер widget: после получения подписанной preview-сессии показан синтетический AI-ответ, поле ввода снова доступно. Никакого платного AI или Supabase INSERT.
- Stage 3 PGlite: подпись/expiry, чужие origin/store, DNS challenge, отзыв epoch, новые RLS поверх широких старых политик и column grants, неизменяемые права, входные лимиты, изоляция unmapped history.
- Stage 4: 6/6 HTTP-проверок общего Express/Vercel entry, admin auth/self-protection/pause, idempotency между двумя app instances, JSON errors, скрытие исходников и proxy headers.
- Дополнительно на структуре из preflight прошли сценарии quota=1, повторная доставка, месячный legacy count и attribution через границу месяца. Полный аудит/перезапуск всех этапов не проводился.
- При медленном параллельном прогоне один тест календарного IP-window пересёк границу минуты. Для его точечной перепроверки время фиксируется только в PGlite через freezeRateClock; production SQL не изменяется ради теста. Результат окончательной перепроверки фиксируется отдельно.

## Не проверено и следующий шаг

Миграции не применены к Supabase; нет live write/AI/deployment теста. Проверки PGlite не заменяют нагрузку на несколько реальных PostgreSQL connections/Vercel instances. Реальный DNS TXT не публиковался; resolver в тестах подставной. Остаются подготовка legacy mapping, server-only WIDGET_SESSION_SECRET (32+ случайных символа), отдельная test DB/branch и разрешение на применение/preview deployment.

После согласованного тестового применения проверить целиком owner → DNS/preview → session → chat → reservation/commit → replay → кабинет. Production остаётся отдельным согласованием. Затем Stage 5: Paddle lifecycle; текущая cancellation feedback не заявляется как отмена подписки Paddle. Auto-color SSRF (Stage 10), Google onboarding, реальные analytics и privacy/pricing остаются незавершёнными; они не скрыты текущими security тестами.
# Final verification note

The isolated IP-rate-limit retest passed (1/1) with a fixed clock in the test database. The previous combined run passed 32/33; its sole failure was a test assumption that the requests stayed within one calendar minute. The deterministic retest covers that failure; the complete combined suite was not rerun. Production rate-limit SQL still uses the real clock.

The additional selective Stage 1/2 regression run reported passes for concurrent quota=1, same-ID replay, explicitly mapped legacy monthly usage, and month-boundary attribution. That long-running command was stopped; no full-run success is claimed.

