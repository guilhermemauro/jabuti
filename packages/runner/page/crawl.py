"""Crawls a site's internal links for an agent (C20), in its sandbox, with its network:
never in the Jabuti server. No model runs here: the agent reads what this prints.

    crawl.py URL MAX_PAGES

Follows the links from URL within its host, breadth first, then fetches the sitemap's
pages no link reached. Writes crawl/<host>/pages.csv (one row per page) and links.csv
(one row per internal link) in the current folder, the agent's workspace, and prints
what to fix: broken links, links through redirects, orphan and deep pages, generic
anchors, one anchor for several pages, duplicate titles, pages kept out of the index.
Respects robots.txt.

Exit codes: 0 crawled; 2 could not fetch the start page; 3 bad arguments.
"""

import csv
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

from page import USER_AGENT, FetchError, clean, fail, get, label, region, same_site

WORKERS = 4
PAGE_TIMEOUT_SECONDS = 15
# Stops fetching here and reports what it has: the tool kills the script later.
TIME_LIMIT_SECONDS = 240
MAX_SITEMAP_URLS = 20_000
MAX_SITEMAP_FILES = 50
# Lines per list printed; the files have all.
SHOWN = 15
DEEP = 3
# Links to these are files, not pages: neither fetched nor counted.
ASSET = re.compile(
    r"\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|pdf|zip|gz|rar|css|js|mjs|json|xml|txt|csv|"
    r"xlsx?|docx?|pptx?|mp4|mp3|webm|mov|wav|woff2?|ttf|eot)$",
    re.I,
)
# Not content: links here are the same on every page.
CHROME = {"nav", "header", "footer"}
GENERIC = {
    "aqui", "clique aqui", "clique", "saiba mais", "leia mais", "veja mais", "ver mais",
    "acesse", "confira", "veja", "continue lendo", "continuar lendo", "este link", "link",
    "here", "click here", "read more", "learn more", "more", "see more", "this link",
    "continue reading", "(no text)",
}


def normalize(url):
    """The page's address: scheme and host in lower case, no fragment, "/" for no path."""
    parsed = urlparse(url)
    return urlunparse(
        (parsed.scheme.lower(), (parsed.netloc or "").lower(), parsed.path or "/", "", parsed.query, "")
    )


class Site:
    def __init__(self, start):
        self.start = start
        self.host = urlparse(start).hostname or ""
        self.robots = RobotFileParser()
        self.robots.parse([])
        self.sitemaps = []
        self.deadline = time.monotonic() + TIME_LIMIT_SECONDS

    def inside(self, url):
        parsed = urlparse(url)
        return parsed.scheme in ("http", "https") and same_site(self.host, parsed.hostname)

    def crawlable(self, url):
        return self.inside(url) and not ASSET.search(urlparse(url).path)

    def read_robots(self):
        origin = f"{urlparse(self.start).scheme}://{urlparse(self.start).netloc}"
        try:
            page = get(f"{origin}/robots.txt", PAGE_TIMEOUT_SECONDS)
            if page.status < 400:
                self.robots.parse(page.text.splitlines())
        except FetchError:
            pass
        self.sitemaps = self.robots.site_maps() or [f"{origin}/sitemap.xml"]

    def sitemap_urls(self):
        """The pages the sitemaps list, following sitemap indexes."""
        found, queue, read = [], list(self.sitemaps), 0
        while queue and read < MAX_SITEMAP_FILES and len(found) < MAX_SITEMAP_URLS:
            url = queue.pop(0)
            read += 1
            try:
                page = get(url, PAGE_TIMEOUT_SECONDS)
            except FetchError:
                continue
            if page.status >= 400:
                continue
            # Accepted: a gzipped sitemap (.xml.gz) reads as no pages.
            text = page.text
            locs = [loc.strip() for loc in re.findall(r"<loc>\s*([^<]+?)\s*</loc>", text)]
            if "<sitemapindex" in text:
                queue.extend(locs)
            else:
                found.extend(normalize(loc) for loc in locs if self.inside(loc))
        return list(dict.fromkeys(found))[:MAX_SITEMAP_URLS]

    def visit(self, url):
        """One page: its row, and its internal links as (target, anchor, region, nofollow)."""
        row = {"url": url, "status": "", "redirect_to": "", "title": "", "h1": "", "words": "",
               "canonical": "", "noindex": "", "outlinks": 0, "external_links": 0, "error": ""}
        if time.monotonic() > self.deadline:
            return None
        if not self.robots.can_fetch(USER_AGENT, url):
            row["status"] = "robots"
            row["error"] = "blocked by robots.txt"
            return row, []
        try:
            page = get(url, PAGE_TIMEOUT_SECONDS)
        except FetchError as error:
            row["status"] = "error"
            row["error"] = str(error)
            return row, []
        row["status"] = page.status
        final = normalize(page.url)
        if final != url:
            row["redirect_to"] = final
            return row, []
        if page.status >= 400 or not page.is_html:
            return row, []
        return row, self.parse(row, page)

    def parse(self, row, page):
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(page.text, "lxml")
        for junk in soup.find_all(["script", "style", "noscript", "template", "svg"]):
            junk.decompose()
        row["title"] = clean(soup.title.get_text(), 200) if soup.title else ""
        h1 = soup.find("h1")
        row["h1"] = clean(h1.get_text(" ", strip=True), 200) if h1 else ""
        canonical = soup.find("link", rel="canonical")
        if canonical and canonical.get("href"):
            row["canonical"] = normalize(urljoin(page.url, canonical["href"].strip()))
        robots = soup.find("meta", attrs={"name": re.compile(r"^robots$", re.I)})
        row["noindex"] = "yes" if robots and "noindex" in (robots.get("content") or "").lower() else ""
        links = []
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            to = normalize(urljoin(page.url, href))
            if not self.inside(to):
                if urlparse(to).scheme in ("http", "https"):
                    row["external_links"] += 1
                continue
            if ASSET.search(urlparse(to).path) or to == row["url"]:
                continue
            nofollow = "nofollow" in (a.get("rel") or [])
            links.append((to, label(a) or "(no text)", region(a), "yes" if nofollow else ""))
        row["outlinks"] = len({link[0] for link in links})
        for chrome in soup.find_all(["nav", "header", "footer"]):
            chrome.decompose()
        body = soup.find("main") or soup.body or soup
        row["words"] = len(body.get_text(" ", strip=True).split())
        return links


def crawl(start, max_pages):
    site = Site(start)
    site.read_robots()
    sitemap = site.sitemap_urls()
    rows, links, depth_of = {}, [], {start: 0}
    seen = {start}
    stopped = False

    def run(batch, depth):
        nonlocal stopped
        found = []
        with ThreadPoolExecutor(WORKERS) as pool:
            for url, result in zip(batch, pool.map(site.visit, batch)):
                if result is None:
                    stopped = True
                    continue
                row, page_links = result
                rows[url] = row
                if depth is not None:
                    depth_of[url] = depth
                for to, anchor, where, nofollow in page_links:
                    links.append({"source": url, "target": to, "anchor": anchor,
                                  "region": where, "nofollow": nofollow})
                    found.append(to)
                if row["redirect_to"] and site.crawlable(row["redirect_to"]):
                    found.append(row["redirect_to"])
        return found

    frontier, depth = [start], 0
    while frontier and len(rows) < max_pages and not stopped:
        batch = frontier[: max_pages - len(rows)]
        found = run(batch, depth)
        frontier = []
        for to in found:
            if to not in seen and site.crawlable(to):
                seen.add(to)
                frontier.append(to)
        depth += 1
    # Pages only the sitemap knows: fetched for their status, their own links not followed.
    unreached = [u for u in sitemap if u not in seen and site.crawlable(u)]
    if not stopped and len(rows) < max_pages:
        extra = unreached[: max_pages - len(rows)]
        seen.update(extra)
        run(extra, None)
    left = len([u for u in seen if u not in rows]) + len([u for u in sitemap if u not in seen])
    return site, sitemap, rows, links, depth_of, left, stopped


def report(start, max_pages, started):
    # The address the start redirects to (https, www) is where the crawl starts.
    try:
        first = get(start, PAGE_TIMEOUT_SECONDS)
    except FetchError as error:
        fail(2, str(error))
    if normalize(first.url) != start and same_site(urlparse(start).hostname, urlparse(first.url).hostname):
        start = normalize(first.url)
    site, sitemap, rows, links, depth_of, left, stopped = crawl(start, max_pages)
    if start not in rows or rows[start]["status"] in ("error", "robots"):
        fail(2, f"Could not crawl {start}: {rows.get(start, {}).get('error') or 'no answer'}")

    in_sitemap = set(sitemap)
    sources, content_sources = {}, {}
    for link in links:
        sources.setdefault(link["target"], set()).add(link["source"])
        if link["region"] not in CHROME:
            content_sources.setdefault(link["target"], set()).add(link["source"])

    def ok(url):
        row = rows.get(url)
        return (row is not None and isinstance(row["status"], int) and row["status"] < 400
                and not row["redirect_to"])

    def indexable(url):
        row = rows[url]
        return ok(url) and not row["noindex"] and row["canonical"] in ("", url)

    folder = os.path.join("crawl", re.sub(r"[^a-z0-9.-]", "-", site.host) or "site")
    os.makedirs(folder, exist_ok=True)
    columns = ["url", "status", "redirect_to", "depth", "in_sitemap", "inlinks", "content_inlinks",
               "outlinks", "external_links", "title", "h1", "words", "canonical", "noindex", "error"]
    with open(os.path.join(folder, "pages.csv"), "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, columns)
        writer.writeheader()
        for url, row in rows.items():
            depth = depth_of.get(url)
            writer.writerow({**row, "depth": "" if depth is None else depth,
                             "in_sitemap": "yes" if url in in_sitemap else "",
                             "inlinks": len(sources.get(url, ())),
                             "content_inlinks": len(content_sources.get(url, ()))})
    with open(os.path.join(folder, "links.csv"), "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, ["source", "target", "anchor", "region", "nofollow"])
        writer.writeheader()
        writer.writerows(links)

    out = []

    def section(title, items, line):
        out.append("")
        out.append(f"{title} ({len(items)}):")
        for item in items[:SHOWN]:
            out.append(f"- {line(item)}")
        if len(items) > SHOWN:
            out.append(f"- … and {len(items) - SHOWN} more in the files")
        if not items:
            out.append("- none")

    def path(url):
        parsed = urlparse(url)
        return url if not same_site(site.host, parsed.hostname) else (parsed.path + (f"?{parsed.query}" if parsed.query else ""))

    def linked_from(url):
        found = sorted(sources.get(url, ()))
        more = f" and {len(found) - 1} more" if len(found) > 1 else ""
        return f"linked from {path(found[0])}{more}" if found else "linked from no page"

    seconds = time.monotonic() - started
    out.append(f"Crawled {start}: {len(rows)} pages in {seconds:.0f}s, {len(links)} internal links.")
    if stopped:
        out.append(f"Stopped at the {TIME_LIMIT_SECONDS}s limit: {left} pages not fetched.")
    elif left:
        out.append(f"Stopped at max_pages {max_pages}: {left} more pages found, not fetched.")
    out.append(f"Sitemap: {len(sitemap)} pages ({', '.join(site.sitemaps)}).")
    out.append(f"Files: {folder}/pages.csv (one row per page), {folder}/links.csv (one row per "
               "internal link, with its anchor and region). Content links are those outside "
               "nav, header and footer.")

    broken = [u for u, r in rows.items() if not r["redirect_to"] and u in sources
              and (r["status"] == "error" or (isinstance(r["status"], int) and r["status"] >= 400))]
    section("Broken internal links: pages that answer with an error, linked from the site", broken,
            lambda u: f"{path(u)} ({rows[u]['status']}{': ' + rows[u]['error'] if rows[u]['error'] else ''}), {linked_from(u)}")

    redirects = [u for u, r in rows.items() if r["redirect_to"] and u in sources]
    section("Internal links through a redirect: link to the final address instead", redirects,
            lambda u: f"{path(u)} → {path(rows[u]['redirect_to'])}, {linked_from(u)}")

    orphans = [u for u in rows if ok(u) and u in in_sitemap and u != start and u not in sources]
    section("Orphans: in the sitemap, linked from no crawled page", orphans, path)

    unlinked = [u for u in rows if ok(u) and u != start and u in sources and u not in content_sources]
    section("Linked only from menus, header or footer, never from content", unlinked, path)

    deep = sorted((u for u in rows if ok(u) and (depth_of.get(u) or 0) > DEEP), key=lambda u: -depth_of[u])
    section(f"Deep: more than {DEEP} clicks from the start page", deep,
            lambda u: f"{path(u)} ({depth_of[u]} clicks)")

    top = sorted((u for u in rows if indexable(u) and content_sources.get(u)),
                 key=lambda u: -len(content_sources[u]))
    section("Most linked from content: where internal authority goes", top[:10],
            lambda u: f"{path(u)} (from {len(content_sources[u])} page{'s' if len(content_sources[u]) > 1 else ''})")

    generic = {}
    for link in links:
        anchor = link["anchor"].lower().strip(" .:!→»>")
        if link["region"] not in CHROME and anchor in GENERIC:
            generic.setdefault(anchor, []).append(link)
    section("Generic anchors in content: say what the target is about instead",
            sorted(generic.items(), key=lambda g: -len(g[1])),
            lambda g: f'"{g[0]}" ×{len(g[1])}, e.g. {path(g[1][0]["source"])} → {path(g[1][0]["target"])}')

    targets = {}
    for link in links:
        anchor = link["anchor"].lower().strip()
        if link["region"] not in CHROME and anchor not in GENERIC and len(anchor) > 3 and ok(link["target"]):
            targets.setdefault(anchor, set()).add(link["target"])
    shared = sorted(((a, t) for a, t in targets.items() if len(t) > 1), key=lambda x: -len(x[1]))
    section("One anchor for several pages: they may compete for the same search", shared,
            lambda x: f'"{x[0]}" → {", ".join(path(t) for t in sorted(x[1])[:4])}')

    titles = {}
    for u, r in rows.items():
        if indexable(u) and r["title"]:
            titles.setdefault(r["title"].lower(), []).append(u)
    duplicates = [(t, us) for t, us in titles.items() if len(us) > 1]
    section("Duplicate titles", duplicates,
            lambda x: f'"{rows[x[1][0]]["title"]}": {", ".join(path(u) for u in x[1][:4])}')

    def why(u):
        r = rows[u]
        if r["redirect_to"]:
            return f"redirects to {path(r['redirect_to'])}"
        if not ok(u):
            return f"{r['status']}{': ' + r['error'] if r['error'] else ''}"
        return "noindex" if r["noindex"] else f"canonical {path(r['canonical'])}"

    kept_out = [u for u in rows if ok(u) and not indexable(u)]
    section("Kept out of the index (noindex, or canonical to another page)", kept_out,
            lambda u: f"{path(u)}: {why(u)}")

    bad_sitemap = [u for u in sitemap if u in rows and not indexable(u)]
    section("In the sitemap but not indexable", bad_sitemap, lambda u: f"{path(u)}: {why(u)}")

    thin = sorted((u for u in rows if indexable(u) and isinstance(rows[u]["words"], int)
                   and rows[u]["words"] < 300), key=lambda u: rows[u]["words"])
    section("Under 300 words outside menus", thin, lambda u: f"{path(u)} ({rows[u]['words']} words)")
    print("\n".join(out))


def main():
    if len(sys.argv) != 3 or not sys.argv[2].isdigit():
        fail(3, "Usage: crawl.py URL MAX_PAGES")
    url, max_pages = sys.argv[1], int(sys.argv[2])
    if urlparse(url).scheme not in ("http", "https"):
        fail(3, f"Not a web address: {url}")
    report(normalize(url), max(1, max_pages), time.monotonic())


if __name__ == "__main__":
    main()
