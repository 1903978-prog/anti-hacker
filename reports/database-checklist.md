# Database best-practice checklist

How the dashboard's **Database** score is worked out. Ten rules, 10 points
each: **10** = done, **5** = partly done, **0** = missing. The score is the
total out of 100. Each app's ratings and reasons are in its
`<app>-health.md` report (row "Database Design & Structure").

1. **One master database.** All the app's business data lives in one
   database, the single source of truth. Copies (test, shadow, backups) are
   only copies, never edited as a second master.
2. **No duplicated data.** Each fact is stored once. No tables that repeat
   the same records, no columns copying values that already live elsewhere
   (except deliberate, documented caches).
3. **Links between records.** Related records point to each other with
   foreign keys the database enforces (for example, an invoice points to its
   client), so links cannot break.
4. **Unique IDs and rules.** Every table has a primary key; unique, not-null
   and check rules stop bad or double entries at the database level.
5. **Versioned schema changes.** The table design lives in the code and
   changes go through tracked migrations, never by hand on production.
6. **Backups and proven restores.** Automatic backups, kept off the main
   server, with a restore that has actually been tested.
7. **Indexes on main lookups.** Columns the app searches or joins on often
   have indexes, so pages stay fast as data grows.
8. **Sensitive data protected.** Passwords hashed, personal data kept to
   what is needed, and private data encrypted or masked where it matters.
9. **No secrets in code.** Database passwords and connection strings come
   from settings (environment variables), never written in the code.
10. **Clear naming and a documented schema.** Tables and columns follow one
    naming style, and the design is written down so anyone can follow it.
