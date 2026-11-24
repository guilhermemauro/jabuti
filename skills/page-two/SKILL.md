---
description: Find the pages that rank at the bottom of page one or on page two for queries with real impressions (Search Console), work out from the page and the results above it why they stay there, and propose one measured change per page: content, internal links, or title when the click rate is the problem.
---

# Page two

A page in positions 8 to 20 already convinces Google it is relevant; what it lacks is usually narrower than what a new page needs. That makes it the cheapest traffic to win, but only where the impressions are real and the reason it stays down is found in the data, not assumed.

## 1. Pull

`search_analytics`, dimensions `page` and `query`, the last 28 days, final data. One pull; everything below is a script under `page-two/` in the workspace.

From the same file, compute the **site's own click rate by position**: drop branded queries (the brand and its misspellings, from the brief), round each row's position, and per position divide the sum of clicks by the sum of impressions. Note the impressions behind each figure; a position with a few hundred is noise. Use this curve, never a published industry one: those mix other sites, markets and years.

## 2. Pick the candidates

- Rows with position 8 to 20, not branded. The position is an average over every time the page showed: 11 may be 6 on some searches and 18 on others. Treat it as a range, not a rank.
- **Two pages for one query** (each with a fifth or more of its impressions): not a page-two case. The pages split the signal; propose consolidating (merge, link or redirect the weaker one) and leave them out of the rest.
- Group the remaining rows by page. Rank pages by the clicks they could gain: for each query, impressions × (the site's CTR at position 3 − its CTR now), summed. It is an upper bound, a way to order the pages, not a forecast; say so wherever you show it.
- Take the top 3 to 5 pages. A page whose impressions come from one query with little volume is anecdote: skip it.

## 3. Split by device

For each pick, pull `query` and `device`, filtered on the page (`page` equals its URL), same dates. When mobile and desktop differ by 3 positions or more, the cause is likely on one device (layout, speed, an interstitial): check the page on that device before touching its content. Every baseline below is per device.

## 4. Find why it stays there

Read the page with `page_structure`: its title, H1, headings, and where the answer to each top query sits.

Read what ranks above it. With a search connector (`search` on serper), search the top 2 or 3 queries in the site's language and market, then read the top 3 results with `web_read`. Without one, say the comparison was not made; never describe a results page you did not read.

For each query group, answer from what you read:

- **Intent and format:** do the top results answer with a list, a table, a tool, a how-to, a definition? Is the page the same kind?
- **The answer:** do they answer in the first paragraph where the page buries it, or cover a part of the question the page skips? Name the section.
- **Freshness:** do they cite newer figures, prices or versions?
- **Internal links:** with `site_crawl`, count from `links.csv` the links into the page from the main region of other pages (menus and footers link to everything), and compare with the site's pages in the top 3. A page few others link to from their text is one the site itself calls minor.
- **Click rate:** compare the page's CTR with the site's curve at its position. When it is well below and the position is already 8 to 10, the result does not promise the answer: the title and description are the change, not the content.

## 5. Propose one change per page

Each change is an experiment (`plan`, `propose_change`), so it is measured, not assumed:

- One kind per experiment (`content`, `links` or `title`) where you can: two at once make the result unreadable.
- `urls` the page; `change` what changes, before and after for a title; `hypothesis` the cause you found and its evidence; `metric` position for content and links, CTR for a title; `baseline` the metric per device, 28 days, GSC, with its dates.
- Name control pages: others in positions 8 to 20 you leave unchanged, read over the same dates.
- Larger content changes go to redator as a content brief: the queries, what the top results cover that the page lacks, the section to add or rewrite, the links. Publishing stays with you.

Do not propose what does not change what a searcher or a crawler sees: repeating the query, adding words for length, a new date with no new content, a new URL.

A rewritten page needs a recrawl before it can move: check the last crawl with `inspect_url` before reading a result. Content and links take weeks to show; a title shows in CTR within days of the recrawl.

## 6. Report

One table, a row per page: its top 3 queries, impressions, position and CTR per device, the site's CTR at that position, the cause found, the change, its kind, and the clicks it could gain (upper bound). Then the consolidations, if any, and the comparisons you could not make.

Save in your notes, dated: the site's CTR curve with its sample sizes, the candidates and their numbers, so the next run sees which moved.
