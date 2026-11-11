# CyberSite

Программа для Windows, которая оживляет [severeclaw.github.io](https://severeclaw.github.io):
показывает на сайте мой статус Discord и статусы друзей, меняет фон на игру, в которую я играю,
и пишет в Discord, кто заходил на сайт.

**Скачать:** [последняя версия](https://github.com/SevereClaw/CyberSite/releases/latest) → `CyberSite-Setup-….exe`.
Дальше программа обновляется сама.

## Как устроено

- Бот сидит на твоём Discord-сервере и видит статусы участников (тебя и друзей из настроек).
- Статусы и статистика гостей выкладываются в публичный gist на GitHub, сайт читает их оттуда.
- Сайт сообщает о заходах через ntfy.sh, бот их принимает и пишет в выбранный канал.
- Аватарки гостей появляются только у тех, кто сам нажал «Отметиться» на сайте (Discord или Telegram).

## Первый запуск

Если раньше бот запускался через `start.bat`, программа сама найдёт старый `config.json`
(в «Загрузках», на рабочем столе, в «Документах») и перенесёт настройки и статистику.
Не нашла — перетащи `config.json` в окно или нажми «Перенести из config.json».

С нуля: открой «Настройки», у каждого поля есть подсказка, где взять значение.

1. **Бот Discord:** [Developer Portal](https://discord.com/developers/applications) → New Application → Bot →
   Reset Token. Там же включи **PRESENCE INTENT** и **SERVER MEMBERS INTENT**. Пригласи бота: OAuth2 → URL Generator → `bot`.
2. **ID сервера и канала:** включи режим разработчика в Discord, ПКМ → Копировать ID.
3. **Токен GitHub:** [создать](https://github.com/settings/tokens/new?scopes=gist&description=CyberSite) — classic, только `gist`.
4. **Отметки гостей (по желанию):** Discord Client Secret (+ Redirect `https://severeclaw.github.io/` в OAuth2)
   и токен Telegram-бота (`/newbot`, затем `/setdomain` → `severeclaw.github.io` в @BotFather).

## Где что лежит

Настройки и статистика — в `%APPDATA%\CyberSite` (кнопка «Папка с настройками»).
Обновления и переустановка их не трогают.

Discord в России заблокирован: программе нужен VPN в режиме **TUN** (системный прокси она не использует).

## Разработка

```
npm install
npm start          # запустить из исходников
npm run dist       # собрать установщик (делает GitHub Actions при каждом push в main)
```
