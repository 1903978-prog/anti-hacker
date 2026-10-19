# eendigo SEO and GEO report

Checked 19/10/2026 around 11:10 UTC by Claude, from Cosmin's notes about the
site (19/10), secval's own speed check, and a few web searches. **Both
scores are estimates (E)** and mostly a floor: rules nobody could check yet
score 0 and say "not checked". Rules are in `reports/seo-checklist.md` and
`reports/geo-checklist.md`.

What I could not check from here: the live site (this workspace's network
blocks eendigo.com), its pages, robots.txt and sitemap, and Google Search
Console and Bing Webmaster Tools (not connected for eendigo.com). The compplan
SEO & GEO section built in the "EEN OM 2 - COMPPLAN" chat can crawl the site
and read both once it is released and connected; its numbers would replace
these.

## Scores

| Area | Score | Reason (evidence) |
|---|---|---|
| SEO (Google & Bing search) | 20 | 1 Search engines can read the site: 5/10 (WordPress with one address, eendigo.com moves to www.eendigo.com per Cosmin; robots.txt and noindex not checked); 2 Sitemap sent to Google and Bing: 5/10 (WordPress makes /wp-sitemap.xml by default; not checked live, submission unknown); 3 Pages indexed: 0/10 (a web search for "eendigo" and "site:eendigo.com" on 19/10 found no eendigo.com page; Search Console not connected); 4 No crawl errors: 0/10 (not checked); 5 Titles and descriptions: 0/10 (not checked; no SEO plugin is known on the site); 6 Content that matches searches: 0/10 (not checked); 7 Structured data: 0/10 (not checked; the Hello Elementor theme adds none by default); 8 Fast and phone-friendly: 5/10 (home page answers fast, secval Speed 90 measured 19/10; Core Web Vitals not measured); 9 Backlinks: 5/10 (Eendigo is listed on other sites found by web search: syncgtm.com agency directory, remotejobs.org, delucru.md; whether they link to the site was not checked); 10 Found in search: 0/10 (eendigo.com not found for any of the 4 searches below). Estimate. |
| GEO (AI assistants' answers) | 10 | 1 AI crawlers allowed: 0/10 (robots.txt not checked); 2 llms.txt: 0/10 (not checked); 3 Readable without JavaScript: 5/10 (WordPress and Elementor send the text in the page HTML; not checked live); 4 Answer-first content: 0/10 (not checked); 5 Clear identity: 0/10 (not checked); 6 Trust signals: 0/10 (not checked); 7 Mentioned on trusted sites: 5/10 (named on syncgtm.com, remotejobs.org and delucru.md; no press or Wikipedia found); 8 In Bing's and Google's index: 0/10 (no page found in web search, see SEO rule 3); 9 Cited in AI answers: 0/10 (not measured); 10 Kept fresh: 0/10 (not checked). Estimate. |

## Search stats (Google and Bing)

| Metric | Google | Bing | Source |
|---|---|---|---|
| Clicks, last 28 days | not connected | not connected | Search Console / Bing not set up for eendigo.com |
| Impressions, last 28 days | not connected | not connected | same |
| Average position | not connected | not connected | same |
| Indexed pages | none found by web search on 19/10 | none found by web search on 19/10 | M (web search tool, not Google or Bing themselves) |
| Crawl errors | not connected | not connected | same |

## Rank checks (19/10/2026, web search tool, top 9 results)

| Search | Language | Result | Source |
|---|---|---|---|
| eendigo | brand | not in the results | M (web search tool, not Google) |
| site:eendigo.com | index check | no pages | M (web search tool, not Google) |
| Eendigo consulting pricing sales go-to-market | EN | eendigo.com not in the results; listings on syncgtm.com, remotejobs.org, delucru.md | M (web search tool, not Google) |
| commercial excellence pricing consulting firm B2B Europe | EN | not in the results (Bain, consultancy.eu, Vendavo) | M (web search tool, not Google) |

## Next free steps

1. Cosmin adds eendigo.com to Google Search Console (DNS TXT in Namecheap)
   and imports it into Bing Webmaster Tools; submit the sitemap.
2. Release the compplan SEO & GEO section so the crawl fills in the "not
   checked" rules.
3. Free WordPress plugin for titles, descriptions and schema (Yoast or Rank
   Math free), plus an llms.txt file.
