# Бот «Аят дня»
Каждый день присылает новый аят: картинка, текст, перевод (Кулиев), аудио (Мишари Альафаси).
Работает для любого пользователя. Старт: отправь боту `2:255`.

## Деплой
1. Создай бота у @BotFather → токен.
2. Cloudflare → My Profile → API Tokens → шаблон «Edit Cloudflare Workers». Account ID — в разделе Workers.
3. В GitHub-репозитории: Settings → Secrets and variables → Actions, добавь 4 секрета:
   `BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WEBHOOK_SECRET` (любая случайная строка).
4. Push в main → Actions сам задеплоит и подключит webhook.
