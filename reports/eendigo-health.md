# eendigo health report

Written 19/10/2026 11:05 UTC from Cosmin's answers (relayed by Livio, 09:30 UTC). **All scores are rough estimates (E)**: there is no code to read (WordPress site, no GitHub repo) and this workspace's network blocks eendigo.com, so nothing was checked live. Security, Speed and Reliability are measured by secval's scans (proven 19/10/2026); the dashboard shows those measured scores instead of the estimates below.

## Scores

| # | Area | Score | Reason (evidence) |
|---|---|---|---|
| 1 | Security & Access Control | ~55 (estimate) | WordPress + Elementor Pro on Namecheap shared hosting (LiteSpeed). Admin login at /wp-admin is public. Unknown: two-factor login for admins, plugin/core update routine, login-attempt limits, security headers. secval scan pending. |
| 2 | Data Protection & Privacy | ~55 (estimate) | Elementor Forms is installed, so contact-form entries (names, emails) may be stored in the database. Unknown: privacy page, how long form entries are kept, cookie banner. |
| 3 | Data Integrity & Consistency | ~70 (estimate) | Standard WordPress MySQL database; content edited by hand in Elementor. Low risk for a brochure site. |
| 4 | Data Persistence & Recovery | ~25 (estimate) | No backup plugin on the site. Namecheap's own hosting backups not confirmed. No restore ever tested. |
| 5 | Database Design & Structure | ~55 (estimate) | Standard WordPress schema (not ours to change). One database on the same hosting account. No backups confirmed, no restore tested. |
| 6 | UX & Interface | ~70 (estimate) | Built with Elementor Pro and Hello Elementor theme (common, mobile-ready). Not checked in a browser. |
| 7 | Performance & Scalability | ~60 (estimate) | Shared hosting with LiteSpeed (fast web server, caching possible with the free LiteSpeed Cache plugin; unknown if active). Not measured. |
| 8 | Reliability & Error Handling | ~60 (estimate) | Single shared server. No uptime monitor known. |
| 9 | Code Quality & Maintainability | ~50 (estimate) | No code under version control; changes made directly in the live admin. Plugin list not reviewed. |
| 10 | Deployment & Operational Readiness | ~40 (estimate) | No deploy pipeline or staging copy; edits go straight to the live site. No rollback except backups (none confirmed). |

## Infrastructure (from Cosmin; not checked live)

- **Site:** WordPress, Elementor Pro, Hello Elementor theme. Admin: https://www.eendigo.com/wp-admin/
- **Host:** Namecheap shared hosting (LiteSpeed).
- **Domain and DNS:** Namecheap, nameservers dns1/dns2.namecheaphosting.com (DNS is edited in the hosting cPanel, Zone Editor).
- **Database:** MySQL on the same Namecheap account (pages, admin users, possibly form entries).
- **GitHub:** none.
- **secval ownership:** proven 19/10/2026 (dashboard shows the row as proven). Method: DNS TXT: record name `_secval-challenge` (full name `_secval-challenge.eendigo.com`), value = the code from secval. The file method fails if eendigo.com redirects to www (secval refuses redirects when checking the file).

## 3 biggest gaps

1. **No backups confirmed.** Free fix: UpdraftPlus (free plugin) with a weekly backup to Google Drive.
2. **Admin login exposed** with no known two-factor or attempt limit. Free fix: a free 2FA plugin (e.g. WP 2FA) and keep WordPress and plugins auto-updating.
3. **No staging or rollback**: every edit goes live straight away.
