-- ============================================================================
--  Схема базы (Cloudflare D1 / SQLite)
-- ============================================================================

-- ---------- Статические данные Корана (заполняются scripts/seed-quran.mjs) --
CREATE TABLE IF NOT EXISTS surahs (
  id            INTEGER PRIMARY KEY,      -- 1..114
  name_ar       TEXT NOT NULL,
  name_ru       TEXT NOT NULL,
  ayah_count    INTEGER NOT NULL,
  revelation    TEXT NOT NULL,            -- makkah | madinah
  page_start    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ayat (
  n             INTEGER PRIMARY KEY,      -- сквозной номер 1..6236
  surah         INTEGER NOT NULL,
  ayah          INTEGER NOT NULL,
  page          INTEGER NOT NULL,         -- страница мусхафа Медины (1..604)
  juz           INTEGER NOT NULL,
  hizb          INTEGER NOT NULL,
  text_uthmani  TEXT NOT NULL,            -- для показа
  text_plain    TEXT NOT NULL             -- imlaei simple: для сверки с распознаванием
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ayat_key  ON ayat(surah, ayah);
CREATE INDEX        IF NOT EXISTS idx_ayat_page ON ayat(page);

-- ---------- Пользователь ---------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,  -- telegram chat id
  name              TEXT,
  tz_offset         INTEGER NOT NULL DEFAULT 180,  -- минуты от UTC (Медина = 180)
  plan_hour         INTEGER NOT NULL DEFAULT 5,    -- утренний план, местное время
  nudge_hour        INTEGER NOT NULL DEFAULT 21,   -- вечерняя проверка
  goal_years        REAL    NOT NULL DEFAULT 11,   -- за сколько лет закончить
  days_per_week     INTEGER NOT NULL DEFAULT 6,
  new_ayat_per_day  INTEGER NOT NULL DEFAULT 0,    -- 0 = считать автоматически из цели
  near_window_days  INTEGER NOT NULL DEFAULT 30,   -- что считается «ближним» повторением
  far_cycle_days    INTEGER NOT NULL DEFAULT 30,   -- за сколько дней прогонять весь выученный объём
  cursor_surah      INTEGER NOT NULL DEFAULT 1,    -- где остановился в заучивании
  cursor_ayah       INTEGER NOT NULL DEFAULT 1,
  partner_chat_id   TEXT,
  paused            INTEGER NOT NULL DEFAULT 0,
  state             TEXT,                          -- JSON: ожидаемый следующий ввод
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Прогресс по страницам (единица хифза — страница мусхафа) -------
CREATE TABLE IF NOT EXISTS pages (
  user_id       INTEGER NOT NULL,
  page          INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'learning',  -- learning | memorized
  ayat_done     INTEGER NOT NULL DEFAULT 0,           -- сколько аятов страницы пройдено
  memorized_at  TEXT,
  stability     REAL    NOT NULL DEFAULT 1.0,         -- дни: за сколько прочность падает до ~37%
  last_review   TEXT,
  next_review   TEXT,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  last_score    REAL,
  PRIMARY KEY (user_id, page)
);
CREATE INDEX IF NOT EXISTS idx_pages_due ON pages(user_id, status, next_review);

-- ---------- План на день ---------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  date       TEXT    NOT NULL,            -- локальная дата YYYY-MM-DD
  kind       TEXT    NOT NULL,            -- new | near | far | weak | connect
  page       INTEGER,
  from_n     INTEGER NOT NULL,            -- сквозные номера аятов
  to_n       INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open',   -- open | done | skipped
  score      REAL,
  done_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(user_id, date, status);

-- ---------- Проверки чтения -----------------------------------------------
CREATE TABLE IF NOT EXISTS checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  task_id      INTEGER,
  from_n       INTEGER NOT NULL,
  to_n         INTEGER NOT NULL,
  accuracy     REAL    NOT NULL,          -- 0..1 по словам
  words_total  INTEGER NOT NULL,
  errors_json  TEXT    NOT NULL,          -- [{type, expected, got, ayah, hint}]
  transcript   TEXT,
  report       TEXT,                      -- разбор от Claude
  seconds      INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checks_user ON checks(user_id, created_at);

-- ---------- Муташабихат: схожие места, где ты путаешься --------------------
CREATE TABLE IF NOT EXISTS confusions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  ayah_key   TEXT NOT NULL,               -- "6:71" — где ошибся
  similar    TEXT NOT NULL,               -- "6:12" — на что съехал
  note       TEXT,
  hits       INTEGER NOT NULL DEFAULT 1,
  last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conf ON confusions(user_id, ayah_key, similar);

-- ---------- Дневной журнал (серии, статистика) -----------------------------
CREATE TABLE IF NOT EXISTS days (
  user_id     INTEGER NOT NULL,
  date        TEXT    NOT NULL,
  new_done    INTEGER NOT NULL DEFAULT 0,
  reviews     INTEGER NOT NULL DEFAULT 0,
  checks      INTEGER NOT NULL DEFAULT 0,
  avg_score   REAL,
  PRIMARY KEY (user_id, date)
);

-- ---------- Арабские слова (отдельный SRS) ---------------------------------
CREATE TABLE IF NOT EXISTS vocab (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  word      TEXT NOT NULL,
  root      TEXT,
  meaning   TEXT NOT NULL,
  note      TEXT,
  ayah_key  TEXT,
  due       TEXT NOT NULL DEFAULT (date('now')),
  interval  REAL NOT NULL DEFAULT 0,
  ease      REAL NOT NULL DEFAULT 2.5,
  reps      INTEGER NOT NULL DEFAULT 0,
  lapses    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_word ON vocab(user_id, word);
CREATE INDEX        IF NOT EXISTS idx_vocab_due  ON vocab(user_id, due);

-- ---------- Кэш внешнего контента (перевод, тафсир, разбор слов) -----------
CREATE TABLE IF NOT EXISTS cache (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
