# 10bonds SEO and GEO report

Checked 19/10/2026 around 11:10 UTC by Claude, from the code on `main`
(commit `e99dc8b`) and a few web searches. **Both scores are estimates (E).**
Rules are in `reports/seo-checklist.md` and `reports/geo-checklist.md`.

What I could not check from here: the live site (this workspace's network
blocks 10bonds.com), and Google Search Console and Bing Webmaster Tools (no
access from here). The 10bonds admin page (Admin, then SEO) already reads
Search Console and Bing when their keys are set on Fly; its numbers were not
read here.

## Scores

| Area | Score | Reason (evidence) |
|---|---|---|
| SEO (Google & Bing search) | 55 | 1 Search engines can read the site: 10/10 (`app/robots.ts` allows all crawlers except admin, account and API; self canonical and hreflang on every language page; fly.dev and www move to 10bonds.com permanently in `middleware.ts`); 2 Sitemap sent to Google and Bing: 5/10 (`app/sitemap.ts` lists every public page in 4 languages; submission in Search Console and Bing not verified); 3 Pages indexed: 0/10 (a web search for "10bonds" and "site:10bonds.com" on 19/10 found no 10bonds page; the domain went live on 19/10, so this is expected for now; Search Console not read); 4 No crawl errors: 5/10 (error and not-found pages exist and old addresses redirect once; Search Console crawl report not read); 5 Titles and descriptions: 10/10 (the site's own SEO checks enforce titles up to 60 characters and descriptions of 70-160, `lib/seo/rubric.ts`); 6 Content that matches searches: 10/10 (guides, bond comparison pages, yield curves and calculators in Italian, French, German and English, built around a seeded keyword list, `lib/seo/keywordsSeed.ts`); 7 Structured data: 10/10 (Article, Dataset, ItemList and Breadcrumb JSON-LD on guides and comparison pages); 8 Fast and phone-friendly: 5/10 (phone layout and 1-hour cache, but the machine sleeps when idle, so the first visit is slow; Core Web Vitals not measured); 9 Backlinks: 0/10 (new domain, no links found or imported); 10 Found in search: 0/10 (not found for any of the 4 searches below). Estimate. |
| GEO (AI assistants' answers) | 45 | 1 AI crawlers allowed: 10/10 (`app/robots.ts` names OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Bingbot and Googlebot); 2 llms.txt: 0/10 (no llms.txt file or route in the code); 3 Readable without JavaScript: 10/10 (Next.js renders the pages on the server); 4 Answer-first content: 5/10 (the site checks its guides for a short first answer, question headings and FAQs, `lib/seo/geo.ts`; how many guides pass was not read); 5 Clear identity: 5/10 (Organization data on pages, but no logo, address or `sameAs` profile links); 6 Trust signals: 5/10 (public methodology page, sources and review dates on guides; reviewer profiles with real credentials still to add); 7 Mentioned on trusted sites: 0/10 (a web search for the brand found no mention on other sites); 8 In Bing's and Google's index: 0/10 (no page found in web search, see SEO rule 3); 9 Cited in AI answers: 0/10 (not measured: the weekly citation test in `scripts/ai-citations.mjs` needs paid AI keys and is off; free manual mode exists in the admin page, not run); 10 Kept fresh: 10/10 (bond data updated daily and dated on every page). Estimate. |

## Search stats (Google and Bing)

| Metric | Google | Bing | Source |
|---|---|---|---|
| Clicks, last 28 days | not connected here | not connected here | E: readable in 10bonds Admin, SEO |
| Impressions, last 28 days | not connected here | not connected here | E: readable in 10bonds Admin, SEO |
| Average position | not connected here | not connected here | E |
| Indexed pages | none found by web search on 19/10 | none found by web search on 19/10 | M (web search tool, not Google or Bing themselves) |
| Crawl errors | not connected here | not connected here | E |

## Rank checks (19/10/2026, web search tool, top 9 results)

| Search | Language | Result | Source |
|---|---|---|---|
| 10bonds | brand | not in the results | M (web search tool, not Google) |
| site:10bonds.com | index check | no pages | M (web search tool, not Google) |
| 10BONDS bond finder yield duration euro | EN | not in the results (cbonds pages instead) | M (web search tool, not Google) |
| migliori obbligazioni 2026 confronto rendimento duration | IT | not in the results (rankia.it, businessonline.it, qualebroker.com, altroconsumo.it) | M (web search tool, not Google) |
| Google and Bing positions for the seeded keywords | IT, FR, DE, EN | not read | E: Search Console and Bing give them free once connected |

## Next free steps

1. Make sure 10bonds.com (not only 10bonds.fly.dev) is a property in Search
   Console and Bing Webmaster Tools, and submit https://10bonds.com/sitemap.xml.
2. Add an `/llms.txt` route (code change in 10bonds).
3. Add logo, address and `sameAs` profile links to the Organization data.
4. Run the free manual citation test once in the 10bonds admin page.
