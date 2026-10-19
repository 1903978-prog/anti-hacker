# GEO checklist (found and cited by AI assistants)

How the dashboard's **GEO** (generative engine optimisation) score is worked
out: how ready a site is to be read, trusted and cited by ChatGPT, Claude,
Perplexity, Copilot and Google's AI Overviews / Gemini. Rated for **10bonds
and eendigo only**; other apps show "-". Not counted in the overall score.

Ten rules, 10 points each: **10** = done, **5** = partly done, **0** = missing
or not checked yet. Ratings and reasons are in `reports/<app>-seo.md` (row
"GEO (AI assistants' answers)").

1. **AI crawlers allowed.** robots.txt lets the search and user crawlers of
   AI assistants read the public pages: OAI-SearchBot, ChatGPT-User,
   Claude-SearchBot, Claude-User, PerplexityBot, Bingbot, Googlebot.
2. **llms.txt.** A short `/llms.txt` that tells AI assistants what the site
   is and which pages matter most.
3. **Readable without JavaScript.** The main text is in the page HTML itself
   (AI crawlers mostly do not run scripts).
4. **Answer-first content.** Pages open with a short direct answer, use
   question headings, tables and FAQs that an assistant can quote.
5. **Clear identity.** Organization data (name, logo, address, `sameAs` links
   to LinkedIn and other official profiles) so assistants know who is behind
   the site.
6. **Trust signals.** Named authors or experts, sources for facts and
   figures, and visible "updated on" dates.
7. **Mentioned on trusted sites.** The brand is named on other sites
   assistants read: press, industry directories, LinkedIn, reviews,
   Wikipedia/Wikidata.
8. **In Bing's and Google's index.** ChatGPT and Copilot search through Bing;
   AI Overviews and Gemini through Google. Not indexed = not cited.
9. **Cited in AI answers.** A fixed list of test questions is asked to the
   assistants; the share of answers that cite or name the site. Half or more
   = 10, any = 5. Free manual mode (paste the answers); the automatic test
   uses paid APIs and stays off unless Livio turns it on.
10. **Kept fresh.** Main pages and data updated within the last 12 months.
