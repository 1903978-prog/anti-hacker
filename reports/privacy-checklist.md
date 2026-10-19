# Privacy checklist (Data Protection & Privacy column)

Ten rules, scored the same way for every app. Each rule gives **10** (fully met, with evidence), **5** (partly met) or **0** (not met). The Privacy score is the sum (0-100). A rule that cannot apply to an app (for example a sign-up notice on an app only Livio uses) scores 10 and says "not needed" in the reason.

Scores are estimates (E) unless the reason names a live check.

| # | Rule | 10 = | 5 = | 0 = |
|---|---|---|---|---|
| 1 | Data map | A file lists every kind of personal data: what, where it is stored, why, how long kept | A partial list | No list |
| 2 | Collect less, no real data in code | Only needed fields; code, test files and seed data hold no real person's data | A few real records left in code | Real personal data spread in code |
| 3 | Clean git history | No real personal data in the repo's history (or it was cleaned and GitHub's cached copies purged) | Cleaned, but cached copies still on GitHub | Real personal data in history |
| 4 | Locked away | Personal data only after sign-in; API answers marked not to be cached; sign-in cookie HttpOnly and Secure | One of these missing | Personal data readable without sign-in |
| 5 | Encrypted | HTTPS only (with HSTS); backups encrypted with a strong cipher; no old weakly locked backups kept | Backups encrypted, but some old ones weakly locked or one key opens everything with no way to change it | Backups or traffic not encrypted |
| 6 | Automatic clean-up | Retention periods written down and run automatically | Written down, not automatic | None |
| 7 | A person's rights | Export and erase one person's data from a screen (not needed when the app holds only Livio's own data) | Only through the API or by hand | Not possible |
| 8 | Quiet logs | No personal data in logs; browsers never see internal error text | One of these missing | Personal data in logs |
| 9 | Outside services | Data sent to outside services kept to the minimum and listed, with each service's data-processing terms | Minimised but not listed (or listed but not minimised) | Personal data sent out freely |
| 10 | Public notice | When the public can use the site: privacy page (controller, legal basis, retention, rights, complaint) and cookie consent before any tracking. Not needed for private apps | Privacy page missing parts, or no consent banner | Nothing |
