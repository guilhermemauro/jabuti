---
description: Turn data into an original study the site publishes, a page others cite and link to: from the company's own files (PDF, Word, Excel, slides, exports) or from public sources, with the data as CSV and an optional PDF.
---

# Data study

A study earns links and citations when it answers, with a number, a question the site's niche asks and nobody has answered: journalists, blogs and AI answers need a figure to cite, and they cite whoever published it first and clearly. Write the page in the site's language and market.

## 1. Pick the question

- One question, answerable with the data at hand, that the site's readers or the press of its niche ask. Find it in the site's search queries (Search Console), in People Also Ask, in news of the niche, and in what the owner hears from customers.
- Search before starting: if someone published the same figure recently, find an angle they missed (another period, region, segment) or another question.
- Write the question and the figure you expect to publish (such as "median days from filing to ruling, by state, 2020–2025") before touching the data. Agree it with the owner when the data is theirs.

## 2. Get the data

**The company's own data** is the strongest: nobody else has it. The owner attaches files to the conversation (they land in `uploads/`) or exports them from their systems.

- PDF: `pypdf`. Word: `python-docx`. Excel: `openpyxl`. CSV: Python's `csv`. All are installed. PowerPoint: `pip install python-pptx` first. For heavier analysis, `pip install pandas`.
- Text in PDFs and slides often needs cleaning: check a sample of what you extracted against the file before counting anything.
- Ask the owner what each column means and which rows to leave out (tests, internal accounts, duplicates). Do not guess.

**Public data**: official statistics, open-data portals, regulators, courts, registries and public APIs. The sources that fit this site belong in its brief. Download with the shell, keep the file, and record the URL, the date you got it and its license or terms.

**A survey** of the site's customers or audience: you write the questions (neutral, one idea each) and the owner runs it. Report the number of answers and how people were reached.

Keep everything under `studies/<slug>/` in the workspace: `raw/` (never published), `analysis.py`, `data.csv` (what is published), `findings.md`.

## 3. Privacy: a hard rule for company data

- Publish only aggregates. No names, e-mails, documents, addresses, case numbers, or anything that points to one person or one customer.
- Leave out any group with fewer than 10 people or records, and say in the methodology that small groups were left out.
- No confidential business figures (revenue, number of customers, prices paid) unless the owner says that figure is public.
- Before anything is published, show the owner every figure and the CSV exactly as they will appear, and get an explicit yes. Raw files never go into the site's repository.

## 4. Analyze

- Do it in `analysis.py`, so it runs again from `raw/` and gives the same numbers. Next year's update reruns it.
- Give the base with every figure (n = …), the period, and medians or ranges where an average would be pulled by a few large values. Look at outliers before deciding what they are.
- A difference between groups or years is a finding only if the groups are large enough to tell. A correlation is not a cause: write "is associated with", never "causes".
- Write `findings.md`: 3 to 7 findings, each one full sentence with the number, the base and the period, readable on its own. The main one first.

## 5. Publish: a page first

The page is what people cite and link to, and what search engines and AI answers read and quote. A PDF alone keeps the links to itself, links to nothing on the site and is quoted less. Build the page as follows:

- **Title** with the question or the main number. **First paragraph:** the main finding in one sentence with its number.
- **Key findings:** the sentences from `findings.md`, as a list. Each must make sense quoted alone.
- **Charts:** images whose alt text states what the chart shows. Each is followed by an HTML table with its data. Never put a number only inside an image.
- **Methodology:** the source and when it was collected, the period, the base, what was left out and why, how each figure was computed, and the limits.
- **Date published and date updated**, and the author: a real person the owner names, with their role.
- **How to cite:** a ready sentence ("Source: <Organization>, <study title>, <year>") and the page's URL.
- **Downloads:** `data.csv` with the aggregated data, and the PDF if there is one.
- **Structured data:** JSON-LD `Article` for the page and `Dataset` for the CSV.
- **Internal links:** link the study from the site's posts on the same topic, and the study to them. `site_crawl`'s `links.csv` shows which posts those are.

**The PDF** is only a complement, for the press and for presentations. Put the page's URL on its cover. If the host allows headers, serve it with `Link: <page URL>; rel="canonical"`, so it does not compete with the page in search. To make it, print the page's HTML: install a renderer with the packages tool if needed, or ask the owner what their site uses.

Publish through the site's usual flow (a branch and the owner's approval, or the plan's experiment), like any other change.

## 6. Get it cited

- List who would cite it: journalists who cover the niche, blogs and newsletters, associations, and sites that already link to older figures on the topic (search for them).
- For each kind, draft a short e-mail: the main finding in the first line, why it matters to their readers, the page's link, and an offer of more detail. **The owner sends them; never send anything yourself.**
- Update the study on the same URL every year, with the new data and the date updated: the links it earned keep counting. Note the update date in your plan or notes.
