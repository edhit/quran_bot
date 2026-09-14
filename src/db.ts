import type { Env } from "./env";

export interface User {
  id: number;
  name: string | null;
  tz_offset: number;
  plan_hour: number;
  nudge_hour: number;
  goal_years: number;
  days_per_week: number;
  new_ayat_per_day: number;
  near_window_days: number;
  far_cycle_days: number;
  cursor_surah: number;
  cursor_ayah: number;
  partner_chat_id: string | null;
  paused: number;
  state: string | null;
  created_at: string;
}

export interface Ayah {
  n: number;
  surah: number;
  ayah: number;
  page: number;
  juz: number;
  hizb: number;
  text_uthmani: string;
  text_plain: string;
}

export interface PageRow {
  user_id: number;
  page: number;
  status: string;
  ayat_done: number;
  memorized_at: string | null;
  stability: number;
  last_review: string | null;
  next_review: string | null;
  reps: number;
  lapses: number;
  last_score: number | null;
}

export interface Task {
  id: number;
  user_id: number;
  date: string;
  kind: "new" | "near" | "far" | "weak" | "connect";
  page: number | null;
  from_n: number;
  to_n: number;
  status: string;
  score: number | null;
  done_at: string | null;
}

export class Db {
  constructor(private d1: D1Database) {}

  // ---------- пользователь ----------
  async user(id: number): Promise<User | null> {
    return this.d1.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
  }

  async createUser(id: number, name: string | null): Promise<User> {
    await this.d1
      .prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)")
      .bind(id, name)
      .run();
    return (await this.user(id))!;
  }

  async updateUser(id: number, patch: Partial<User>): Promise<void> {
    const keys = Object.keys(patch) as (keyof User)[];
    if (!keys.length) return;
    const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    await this.d1
      .prepare(sql)
      .bind(...keys.map((k) => patch[k] as never), id)
      .run();
  }

  async allUsers(): Promise<User[]> {
    const r = await this.d1.prepare("SELECT * FROM users WHERE paused = 0").all<User>();
    return r.results ?? [];
  }

  async setState(id: number, state: unknown | null): Promise<void> {
    await this.updateUser(id, { state: state === null ? null : JSON.stringify(state) });
  }

  // ---------- текст Корана ----------
  async ayahByKey(surah: number, ayah: number): Promise<Ayah | null> {
    return this.d1
      .prepare("SELECT * FROM ayat WHERE surah = ? AND ayah = ?")
      .bind(surah, ayah)
      .first<Ayah>();
  }

  async ayahByN(n: number): Promise<Ayah | null> {
    return this.d1.prepare("SELECT * FROM ayat WHERE n = ?").bind(n).first<Ayah>();
  }

  async range(fromN: number, toN: number): Promise<Ayah[]> {
    const r = await this.d1
      .prepare("SELECT * FROM ayat WHERE n BETWEEN ? AND ? ORDER BY n")
      .bind(fromN, toN)
      .all<Ayah>();
    return r.results ?? [];
  }

  async pageAyat(page: number): Promise<Ayah[]> {
    const r = await this.d1
      .prepare("SELECT * FROM ayat WHERE page = ? ORDER BY n")
      .bind(page)
      .all<Ayah>();
    return r.results ?? [];
  }

  async surahName(id: number): Promise<{ name_ar: string; name_ru: string } | null> {
    return this.d1
      .prepare("SELECT name_ar, name_ru FROM surahs WHERE id = ?")
      .bind(id)
      .first();
  }

  async totalAyat(): Promise<number> {
    const r = await this.d1.prepare("SELECT COUNT(*) AS c FROM ayat").first<{ c: number }>();
    return r?.c ?? 0;
  }

  // ---------- страницы ----------
  async page(userId: number, page: number): Promise<PageRow | null> {
    return this.d1
      .prepare("SELECT * FROM pages WHERE user_id = ? AND page = ?")
      .bind(userId, page)
      .first<PageRow>();
  }

  async upsertPage(userId: number, page: number, patch: Partial<PageRow>): Promise<void> {
    await this.d1
      .prepare("INSERT OR IGNORE INTO pages (user_id, page) VALUES (?, ?)")
      .bind(userId, page)
      .run();
    const keys = Object.keys(patch).filter(
      (k) => k !== "user_id" && k !== "page"
    ) as (keyof PageRow)[];
    if (!keys.length) return;
    await this.d1
      .prepare(
        `UPDATE pages SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE user_id = ? AND page = ?`
      )
      .bind(...keys.map((k) => patch[k] as never), userId, page)
      .run();
  }

  async memorizedPages(userId: number): Promise<PageRow[]> {
    const r = await this.d1
      .prepare(
        "SELECT * FROM pages WHERE user_id = ? AND status = 'memorized' ORDER BY page"
      )
      .bind(userId)
      .all<PageRow>();
    return r.results ?? [];
  }

  async countMemorized(userId: number): Promise<number> {
    const r = await this.d1
      .prepare("SELECT COUNT(*) AS c FROM pages WHERE user_id = ? AND status = 'memorized'")
      .bind(userId)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  // ---------- задачи ----------
  async tasksForDay(userId: number, date: string): Promise<Task[]> {
    const r = await this.d1
      .prepare("SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY id")
      .bind(userId, date)
      .all<Task>();
    return r.results ?? [];
  }

  async task(id: number): Promise<Task | null> {
    return this.d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>();
  }

  async addTask(
    userId: number,
    date: string,
    kind: Task["kind"],
    page: number | null,
    fromN: number,
    toN: number
  ): Promise<number> {
    const r = await this.d1
      .prepare(
        "INSERT INTO tasks (user_id, date, kind, page, from_n, to_n) VALUES (?,?,?,?,?,?) RETURNING id"
      )
      .bind(userId, date, kind, page, fromN, toN)
      .first<{ id: number }>();
    return r!.id;
  }

  async closeTask(id: number, status: string, score: number | null): Promise<void> {
    await this.d1
      .prepare("UPDATE tasks SET status = ?, score = ?, done_at = datetime('now') WHERE id = ?")
      .bind(status, score, id)
      .run();
  }

  /** Незакрытые задачи прошлых дней — это и есть «долг». */
  async debt(userId: number, today: string): Promise<Task[]> {
    const r = await this.d1
      .prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND date < ? AND status = 'open' ORDER BY date, id"
      )
      .bind(userId, today)
      .all<Task>();
    return r.results ?? [];
  }

  // ---------- проверки ----------
  async addCheck(row: {
    user_id: number;
    task_id: number | null;
    from_n: number;
    to_n: number;
    accuracy: number;
    words_total: number;
    errors_json: string;
    transcript: string;
    report: string;
    seconds: number;
  }): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO checks
         (user_id, task_id, from_n, to_n, accuracy, words_total, errors_json, transcript, report, seconds)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        row.user_id,
        row.task_id,
        row.from_n,
        row.to_n,
        row.accuracy,
        row.words_total,
        row.errors_json,
        row.transcript,
        row.report,
        row.seconds
      )
      .run();
  }

  async recentChecks(userId: number, limit = 30) {
    const r = await this.d1
      .prepare("SELECT * FROM checks WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(userId, limit)
      .all<any>();
    return r.results ?? [];
  }

  async noteConfusion(userId: number, key: string, similar: string, note: string) {
    await this.d1
      .prepare(
        `INSERT INTO confusions (user_id, ayah_key, similar, note)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id, ayah_key, similar)
         DO UPDATE SET hits = hits + 1, last_seen = datetime('now'), note = excluded.note`
      )
      .bind(userId, key, similar, note)
      .run();
  }

  async topConfusions(userId: number, limit = 10) {
    const r = await this.d1
      .prepare(
        "SELECT * FROM confusions WHERE user_id = ? ORDER BY hits DESC, last_seen DESC LIMIT ?"
      )
      .bind(userId, limit)
      .all<any>();
    return r.results ?? [];
  }

  // ---------- дневник ----------
  async bumpDay(
    userId: number,
    date: string,
    patch: { new_done?: number; reviews?: number; checks?: number; score?: number }
  ) {
    await this.d1
      .prepare("INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)")
      .bind(userId, date)
      .run();
    await this.d1
      .prepare(
        `UPDATE days SET
           new_done  = new_done + ?,
           reviews   = reviews  + ?,
           checks    = checks   + ?,
           avg_score = CASE WHEN ? IS NULL THEN avg_score
                            WHEN avg_score IS NULL THEN ?
                            ELSE (avg_score * checks + ?) / (checks + 1) END
         WHERE user_id = ? AND date = ?`
      )
      .bind(
        patch.new_done ?? 0,
        patch.reviews ?? 0,
        patch.checks ?? 0,
        patch.score ?? null,
        patch.score ?? null,
        patch.score ?? 0,
        userId,
        date
      )
      .run();
  }

  async days(userId: number, limit = 400) {
    const r = await this.d1
      .prepare("SELECT * FROM days WHERE user_id = ? ORDER BY date DESC LIMIT ?")
      .bind(userId, limit)
      .all<any>();
    return r.results ?? [];
  }

  // ---------- словарь ----------
  async addWord(userId: number, w: { word: string; root?: string; meaning: string; note?: string; ayah_key?: string }) {
    await this.d1
      .prepare(
        `INSERT INTO vocab (user_id, word, root, meaning, note, ayah_key)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id, word) DO NOTHING`
      )
      .bind(userId, w.word, w.root ?? null, w.meaning, w.note ?? null, w.ayah_key ?? null)
      .run();
  }

  async dueWords(userId: number, today: string, limit = 10) {
    const r = await this.d1
      .prepare("SELECT * FROM vocab WHERE user_id = ? AND due <= ? ORDER BY due, id LIMIT ?")
      .bind(userId, today, limit)
      .all<any>();
    return r.results ?? [];
  }

  async updateWord(id: number, patch: Record<string, unknown>) {
    const keys = Object.keys(patch);
    await this.d1
      .prepare(`UPDATE vocab SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .bind(...keys.map((k) => patch[k] as never), id)
      .run();
  }

  async vocabStats(userId: number, today: string) {
    return this.d1
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN due <= ? THEN 1 ELSE 0 END) AS due,
                SUM(CASE WHEN reps >= 3 THEN 1 ELSE 0 END) AS learned
         FROM vocab WHERE user_id = ?`
      )
      .bind(today, userId)
      .first<{ total: number; due: number; learned: number }>();
  }

  // ---------- кэш ----------
  async cacheGet(k: string): Promise<string | null> {
    const r = await this.d1.prepare("SELECT v FROM cache WHERE k = ?").bind(k).first<{ v: string }>();
    return r?.v ?? null;
  }

  async cacheSet(k: string, v: string): Promise<void> {
    await this.d1
      .prepare("INSERT INTO cache (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind(k, v)
      .run();
  }
}

export const db = (env: Env) => new Db(env.DB);
