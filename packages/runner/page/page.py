"""Reads a web page for an agent (C20), in its sandbox, with its network: never in
the Jabuti server, so a page cannot reach the server or the owner's network through
it. No model runs here: the agent reads what this prints.

    page.py read URL        the main text as Markdown, with title and description
    page.py structure URL   metadata, headings, calls to action and links, by region

Exit codes: 0 printed the page; 2 could not fetch it; 3 not a page it can read.
"""

import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_SECONDS = 20
USER_AGENT = "Mozilla/5.0 (compatible; Jabuti)"
# The longest list of links or calls to action printed; the rest are counted.
MAX_ITEMS = 150


class Page:
    def __init__(self, url, status, content_type, text):
        self.url = url
        self.status = status
        self.content_type = content_type
        self.text = text

    @property
    def is_html(self):
        return "html" in self.content_type or "xml" in self.content_type or not self.content_type


def fail(code, message):
    print(message)
    sys.exit(code)


class FetchError(Exception):
    """A page that could not be fetched, with why."""


def get(url, timeout=TIMEOUT_SECONDS):
    """The page at url after redirects, error pages included; FetchError if none came."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
    )
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        # A 404 or 500 still has a page, worth reading for its structure.
        response = error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise FetchError(f"Could not fetch {url}: {reason}") from error
    final = response.geturl()
    if urlparse(final).scheme not in ("http", "https"):
        raise FetchError(f"{url} redirected to {final}, which is not a web address.")
    try:
        body = response.read(MAX_BYTES + 1)[:MAX_BYTES]
    except (TimeoutError, OSError) as error:
        raise FetchError(f"Could not fetch {url}: {error}") from error
    charset = response.headers.get_content_charset() or "utf-8"
    try:
        text = body.decode(charset, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    return Page(final, response.status if hasattr(response, "status") else response.code, content_type, text)


def fetch(url):
    try:
        return get(url)
    except FetchError as error:
        fail(2, str(error))


def header(page, requested):
    line = f"URL: {page.url} (HTTP {page.status})"
    if page.url.rstrip("/") != requested.rstrip("/"):
        line += f"\nRedirected from: {requested}"
    return line


def read(url):
    page = fetch(url)
    if page.status >= 400:
        fail(2, f"{header(page, url)}\nThe server answered with an error page: nothing to read.")
    if not page.is_html:
        if page.content_type.startswith("text/") or "json" in page.content_type:
            print(f"{header(page, url)}\nType: {page.content_type}\n\n{page.text}")
            return
        fail(3, f"{header(page, url)}\nNot a web page ({page.content_type}): it cannot be read as text.")
    import trafilatura

    meta = trafilatura.extract_metadata(page.text, default_url=page.url)
    text = trafilatura.extract(
        page.text,
        url=page.url,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        include_comments=False,
    )
    lines = [header(page, url)]
    if meta is not None:
        for label, value in (
            ("Title", meta.title),
            ("Description", meta.description),
            ("Author", meta.author),
            ("Date", meta.date),
        ):
            if value:
                lines.append(f"{label}: {value}")
    print("\n".join(lines))
    print()
    print(text or "No main text found: the page may be built by JavaScript, or be mostly links.")


# --- structure -------------------------------------------------------------

ICON = re.compile(r"material-(symbols|icons)|^icon$|^fa-|^bi-", re.I)
REGIONS = {
    "nav": "nav",
    "header": "header",
    "footer": "footer",
    "main": "main",
    "aside": "aside",
    "form": "form",
}
ROLES = {"navigation": "nav", "banner": "header", "contentinfo": "footer", "main": "main"}
BUTTON_CLASS = re.compile(r"^(btn|button|cta)([-_].*)?$", re.I)


def clean(value, limit=100):
    value = re.sub(r"\s+", " ", value or "").strip()
    return value if len(value) <= limit else value[: limit - 1] + "…"


def region(element):
    for parent in element.parents:
        role = parent.get("role") if hasattr(parent, "get") else None
        if role in ROLES:
            return ROLES[role]
        if parent.name in REGIONS:
            return REGIONS[parent.name]
    return "body"


def button_like(element):
    """A call to action: a button, or a link styled as one."""
    if element.name in ("button", "input") or element.get("role") == "button":
        return True
    classes = element.get("class") or []
    if any(BUTTON_CLASS.match(c) for c in classes):
        return True
    # Utility CSS (Tailwind and the like): a filled, padded, rounded box.
    return (
        any(c.startswith("bg-") for c in classes)
        and any(re.match(r"p[xy]?-", c) for c in classes)
        and any(c.startswith("rounded") for c in classes)
    )


def label(element):
    if element.name == "input":
        return clean(element.get("value") or element.get("aria-label") or "")
    text = clean(element.get_text(" ", strip=True))
    if text:
        return text
    image = element.find("img")
    return clean(
        element.get("aria-label") or element.get("title") or (image.get("alt") if image else "") or ""
    )


def same_site(host, other):
    strip = lambda h: (h or "").lower().removeprefix("www.")
    return strip(host) == strip(other)


def target(page_url, element):
    """Where it leads: a path on this site, a full URL elsewhere, or what it does."""
    if element.name in ("button", "input"):
        form = element.find_parent("form")
        if form is not None:
            action = urljoin(page_url, form.get("action") or "")
            return f"(submits a form to {urlparse(action).path or '/'})", True
        return "(button)", True
    href = (element.get("href") or "").strip()
    if not href or href == "#" or href.startswith("javascript:"):
        return None, True
    if href.startswith(("mailto:", "tel:", "whatsapp:", "sms:")):
        return href, False
    absolute = urljoin(page_url, href)
    parsed = urlparse(absolute)
    if parsed.scheme not in ("http", "https"):
        return absolute, False
    if same_site(urlparse(page_url).hostname, parsed.hostname):
        path = parsed.path or "/"
        if parsed.query:
            path += f"?{parsed.query}"
        if parsed.fragment:
            path += f"#{parsed.fragment}"
        return path, True
    return absolute, False


def listing(title, items):
    """Each distinct (region, text, target) once, with how many times it appears."""
    counts = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    lines = [f"{title} ({len(counts)}):"]
    for (where, text, to), count in list(counts.items())[:MAX_ITEMS]:
        times = f" ×{count}" if count > 1 else ""
        lines.append(f'- [{where}] "{text}" → {to}{times}')
    if len(counts) > MAX_ITEMS:
        lines.append(f"- … and {len(counts) - MAX_ITEMS} more")
    if not counts:
        lines.append("- none")
    return lines


def structure(url):
    page = fetch(url)
    if not page.is_html:
        fail(3, f"{header(page, url)}\nNot a web page ({page.content_type}): it has no structure to read.")
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(page.text, "lxml")
    for junk in soup.find_all(["script", "style", "noscript", "template", "svg"]):
        junk.decompose()
    for icon in soup.find_all(class_=ICON):
        icon.decompose()

    def meta(name):
        tag = soup.find("meta", attrs={"name": name}) or soup.find("meta", attrs={"property": name})
        return clean(tag.get("content"), 300) if tag else None

    canonical = soup.find("link", rel="canonical")
    html = soup.find("html")
    lines = [header(page, url)]
    for name, value in (
        ("Title", clean(soup.title.get_text(), 300) if soup.title else None),
        ("Description", meta("description")),
        ("Canonical", canonical.get("href") if canonical else None),
        ("Robots", meta("robots")),
        ("Language", html.get("lang") if html else None),
        ("og:title", meta("og:title")),
        ("og:description", meta("og:description")),
        ("og:image", meta("og:image")),
    ):
        lines.append(f"{name}: {value if value else '(none)'}")

    images = soup.find_all("img")
    missing_alt = sum(1 for i in images if not (i.get("alt") or "").strip())
    lines.append(f"Images: {len(images)}, {missing_alt} without alt text")

    lines.append("")
    lines.append("Headings:")
    headings = soup.find_all(re.compile(r"^h[1-3]$"))
    for heading in headings:
        depth = int(heading.name[1]) - 1
        lines.append(f"{'  ' * depth}{heading.name.upper()}: {clean(heading.get_text(' ', strip=True))}")
    if not headings:
        lines.append("- none")

    ctas, internal, external = [], [], []
    candidates = soup.find_all(["a", "button"]) + soup.find_all(
        "input", attrs={"type": re.compile(r"^(submit|button)$", re.I)}
    )
    for element in candidates:
        to, inside = target(page.url, element)
        if to is None:
            continue
        item = (region(element), label(element) or "(no text)", to)
        if button_like(element):
            ctas.append(item)
        elif inside:
            internal.append(item)
        else:
            external.append(item)

    lines.append("")
    lines.extend(listing("Calls to action (buttons, and links styled as buttons)", ctas))
    lines.append("")
    lines.extend(listing("Internal links", internal))
    lines.append("")
    lines.extend(listing("External links", external))
    print("\n".join(lines))


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("read", "structure"):
        fail(3, "Usage: page.py read|structure URL")
    mode, url = sys.argv[1], sys.argv[2]
    if urlparse(url).scheme not in ("http", "https"):
        fail(3, f"Not a web address: {url}")
    read(url) if mode == "read" else structure(url)


if __name__ == "__main__":
    main()
