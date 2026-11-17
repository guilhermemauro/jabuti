---
description: Find the questions people typed in Google and Bing before reaching the site (long and question-shaped queries from Search Console and Bing Webmaster Tools), group them by intent, and turn each group into a fix, a new section or a content brief.
---

# Search questions

Long queries are people asking something in their own words: a question, a problem, a comparison. Each has little volume, but together they show what the audience wants to know, which page Google picked to answer it, and where the site has no answer. They are also where AI answers (Google's AI Mode, Copilot) draw from.

## 1. Pull the queries

Pull the same period in both engines: the last 3 months is a good default.

**Google Search Console** (`search_analytics`, dimensions `query` and `page`). The filter runs on Google's side, in RE2, so only matching rows come back. Run two pulls:

- **Long queries**, 8 words or more:
  `filters: [{ dimension: "query", operator: "includingRegex", expression: "^(?:\\S+\\s+){7,}\\S+$" }]`
  Change `{7,}` to `{5,}` for 6 words or more on a small site, where 8 returns too few rows.
- **Question words** at the start, in the site's languages. Queries come lowercase. RE2's `\b` knows only ASCII letters, so end each word with `(\s|$)`, never `\b`:
  - Portuguese: `^(como|o que|oque|qual|quais|quando|onde|por que|porque|pq|quanto|quantos|quantas|quem|pode|posso|é possível|vale a pena|existe|tem como|o que é|diferença entre)(\s|$)`
  - English: `^(how|what|why|when|where|which|who|can|should|is|are|does|do|will|vs)(\s|$)`
  - Spanish: `^(cómo|como|qué|que|cuál|cuáles|cuándo|dónde|por qué|cuánto|cuántos|quién|se puede|puedo|vale la pena)(\s|$)`

**Bing Webmaster Tools** (`search_performance`, report `queries`). Bing has no filter: it returns its top queries, weekly. In the shell, sum each query over the weeks in the period, then apply the same two patterns with Python's `re` (where `\b` and `\s` do work with accents).

## 2. Clean and merge

In a script under `questions/` in the workspace:

- One table: query, engine, clicks, impressions, position, and for Google the page that showed.
- Drop branded queries (the brand and its misspellings, from the brief) unless the question is about the brand; those go apart, as support or product questions.
- Group by intent: queries that would be satisfied by the same answer. Normalize first (accents, stop words, word order), then read the groups and fix them by hand; a word-overlap grouping alone mixes different questions.

## 3. Read each group

For each group, its total impressions, clicks, CTR and the best position, and the pages Google showed for it:

- **Answered and ranking** (position up to about 5, CTR in line with the site's at that position): leave it. Note the page as the one that owns this question.
- **Seen but not clicked** (impressions, position up to about 10, low CTR): the page ranks but the result does not promise the answer. Propose a title, description or a heading with the question and a direct answer under it.
- **Answered badly** (a page shows, position past 10, or several pages trade places for the same group): the answer is missing, buried or split. Propose a section with the question as heading and a short direct answer first, in the page that should own it; merge or link the others to it.
- **No page for it** (the page shown is off-topic, or the home): a content gap. If the group is worth it, write a content brief for redator with the queries as the questions to answer.

Order by impressions of the group, then by effort.

## 4. Limits to state in the report

- Google hides rare queries for privacy, and long queries are rare: the rows are a sample, and their sum is well below the total. Say so; never present the sum as the site's question traffic.
- Bing gives only its top queries, so long ones are scarce there.
- Very long queries, especially ones that read like instructions to a chatbot, may come from AI Mode or from prompts people pasted into search. That is a hypothesis to state as one, not a fact: neither tool says where a query was typed.
- One query with a few impressions is anecdote. Act on groups, and on single queries only when their impressions justify it.

## 5. Report

A table per kind (seen but not clicked, answered badly, no page), each row a group: its main question, 2 to 3 example queries, impressions, clicks, position, the page, and the change proposed. Then the content briefs, if any. Save the groups and their numbers in your notes, dated, so the next run shows which questions moved.
