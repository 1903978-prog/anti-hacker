# SEO checklist (Google and Bing search)

How the dashboard's **SEO** score is worked out. Rated for **10bonds and
eendigo only** (public websites that need visitors from search); every other
app shows "-". SEO is shown in the table but **not counted in the overall
score**, so the overall stays comparable across apps.

Ten rules, 10 points each: **10** = done, **5** = partly done, **0** = missing
**or not checked yet** (nothing is guessed; a rule nobody could check scores 0
and says "not checked"). The score is the total out of 100. Each app's ratings
and reasons are in `reports/<app>-seo.md` (row "SEO (Google & Bing search)").

1. **Search engines can read the site.** robots.txt lets Googlebot and Bingbot
   in, no stray `noindex`, one canonical address per page (no www / non-www or
   old-domain duplicates).
2. **Sitemap sent to Google and Bing.** An up-to-date sitemap.xml, submitted
   in Google Search Console and Bing Webmaster Tools.
3. **Pages indexed.** Most sitemap pages are in Google's and Bing's index
   (Search Console "Pages" report, Bing "Site Explorer").
4. **No crawl errors.** No broken pages (404), server errors (5xx) or redirect
   chains in Search Console and Bing.
5. **Titles and descriptions.** Every page has a unique title (up to ~60
   characters, with its main search words) and a meta description.
6. **Content that matches searches.** Pages exist for the topics the target
   customers search for, with real depth (headings, 600+ words where it makes
   sense), not thin or duplicated pages.
7. **Structured data.** Valid schema.org data (Organization, Article,
   Breadcrumb, FAQ, ...) Google can read.
8. **Fast and phone-friendly.** Good Core Web Vitals (Search Console or
   PageSpeed Insights) and a layout that works on phones.
9. **Backlinks.** Other relevant websites link to the site (Search Console
   "Links" report, Bing "Backlinks"). 20+ referring sites = 10, 5-19 = 5.
10. **Found in search.** The site shows on page 1 for its target searches
    (see "Rank checks" in each report). Half or more = 10, some = 5.

## Search stats each report carries (not scored directly)

| Metric | Google (Search Console) | Bing (Webmaster Tools) | How it is read |
|---|---|---|---|
| Clicks, last 28 days | | | API, free |
| Impressions, last 28 days | | | API, free |
| Average position | | | API, free |
| Indexed pages | | | Pages report / Site Explorer |
| Crawl errors | | | Pages report / Crawl information |

Every value says **M** (measured: read from Google, Bing or a check secval or
Claude actually ran, with date) or **E** (estimate from reading code or
notes). A value nobody could read says "not connected".

## Rank checks

Each report lists 5-10 searches the site should be found for, with where it
appears in Google and Bing (position, or "not in top 10"), the date, and M or E.
Positions come free from Search Console and Bing Webmaster Tools (average
position per search). No paid rank tracker is used.
