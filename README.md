# WatchMatch

Смотрите видео синхронно с друзьями: комнаты по коду, чат, реакции, вход через Google,
темы в стиле «жидкого стекла».

```
main.py          FastAPI: WebSocket комнат, вход через Google, настройки пользователя
rooms.py         вся логика комнат (чистый Python, покрыта тестами)
auth.py          проверка Google ID-токена, подписанные токены сессии
store.py         SQLite: пользователи и их настройки
settings.py      проверка настроек интерфейса
frontend/        сайт (HTML/CSS/JS без сборки)
tests/           pytest
```

## Запуск локально

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# сайт: http://localhost:8000/app/
```

Без `GOOGLE_CLIENT_ID` работает гостевой режим, кнопки Google просто не показываются.

## Переменные окружения (на сервере)

| Переменная | Зачем |
|---|---|
| `FRONTEND_ORIGIN` | адреса сайта через запятую, например `https://watchmatchh.vercel.app`. Нужна и для CORS, и для проверки `Origin` у WebSocket |
| `GOOGLE_CLIENT_ID` | включает вход через Google |
| `SESSION_SECRET` | длинная случайная строка для подписи сессий. Без неё при каждом перезапуске все вылетят из аккаунтов |
| `DB_PATH` | путь к файлу SQLite (по умолчанию `watchmatch.db`) |
| `MAX_MEMBERS` | людей в комнате (по умолчанию 12) |

Секрет можно сгенерировать так: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

## Вход через Google

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create credentials → **OAuth client ID** → тип **Web application**.
2. В **Authorized JavaScript origins** добавьте адрес сайта (`https://watchmatchh.vercel.app`, для разработки `http://localhost:8000`). Redirect URI не нужен.
3. Скопируйте Client ID в `GOOGLE_CLIENT_ID` на сервере. Секрет клиента не нужен.
4. Первый вход через Google создаёт аккаунт, это и есть регистрация.

## Деплой

- **Бэкенд** (Render, Railway, Fly): команда запуска лежит в `Procfile`. SQLite хранится в файле,
  поэтому на бесплатных тарифах без постоянного диска аккаунты и настройки пропадут после
  пересоздания контейнера. Для постоянства подключите диск и укажите `DB_PATH` на него.
  Комнаты хранятся в памяти, запускайте **один процесс** (без нескольких воркеров).
- **Фронтенд** (Vercel): задеплойте папку `frontend/` и впишите адрес бэкенда в `frontend/config.js`:
  `window.WM_API = "https://ваш-бэкенд.onrender.com";`

## Протокол WebSocket

Первое сообщение клиента: `{"t":"hello","name":"Аня","token":"<необязательно>"}`.
Дальше `play`, `pause`, `seek`, `rate`, `load`, `countdown`, `chat`, `react`, `party`, `rename`,
`control`, `host`, `ping`. Полный список в docstring `rooms.py`.

## Что есть

- Состояние комнаты на сервере: новичок сразу попадает в нужную секунду
- Хост и передача пульта, режим «пульт у всех», обратный отсчёт 3-2-1
- YouTube и прямые ссылки на видео (.mp4, .webm)
- Чат с командами (`/help`), реакции поверх видео, конфетти, попкорн, землетрясение, диско
- 7 тем, свой акцент, настройка стекла, режим кино, звуки; настройки синхронизируются с аккаунтом
- Пасхалки: код Konami, двойной клик по логотипу

## Тесты

```bash
pip install pytest
python -m pytest tests -q
```
