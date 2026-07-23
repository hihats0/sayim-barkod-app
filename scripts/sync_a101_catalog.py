#!/usr/bin/env python3
"""Build a local A101 product catalog from public pages.

Rules:
- Only public, unauthenticated pages are requested.
- robots.txt is checked before crawling.
- No CAPTCHA, login, rate-limit, or access-control bypass is attempted.
- Requests are deliberately rate limited and identify this repository.
- If PARSE_API_KEY is present, the maintained Parse.bot A101 wrapper is used first.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.robotparser
import xml.etree.ElementTree as ET
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "a101-products.json"
USER_AGENT = "SayimBarkodCatalogBot/1.0 (+https://github.com/hihats0/sayim-barkod-app)"
REQUEST_DELAY = float(os.getenv("A101_REQUEST_DELAY", "0.65"))
MAX_PRODUCTS = int(os.getenv("A101_MAX_PRODUCTS", "12000"))
MAX_LISTING_PAGES = int(os.getenv("A101_MAX_LISTING_PAGES", "750"))
TIMEOUT = 30
A101_HOSTS = {"www.a101.com.tr", "a101.com.tr", "www.a101kapida.com", "a101kapida.com"}
START_URLS = [
    "https://www.a101.com.tr/kapida",
    "https://www.a101.com.tr/ekstra",
    "https://www.a101.com.tr/",
    "https://www.a101kapida.com/",
]
PARSE_BASE = "https://api.parse.bot/scraper/01e0d684-e029-4758-9eb5-c6214e407387"

session = requests.Session()
session.headers.update({
    "User-Agent": USER_AGENT,
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.6",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5",
})

last_request_at = 0.0
robots_by_origin: dict[str, urllib.robotparser.RobotFileParser | None] = {}
robots_sitemaps: dict[str, list[str]] = {}
diagnostics: list[str] = []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def rate_limit() -> None:
    global last_request_at
    elapsed = time.monotonic() - last_request_at
    if elapsed < REQUEST_DELAY:
        time.sleep(REQUEST_DELAY - elapsed)


def get_origin(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def load_robots(origin: str) -> urllib.robotparser.RobotFileParser | None:
    global last_request_at
    if origin in robots_by_origin:
        return robots_by_origin[origin]

    robots_url = f"{origin}/robots.txt"
    try:
        rate_limit()
        response = session.get(robots_url, timeout=TIMEOUT, allow_redirects=True)
        last_request_at = time.monotonic()

        if response.status_code == 404:
            robots_by_origin[origin] = None
            robots_sitemaps[origin] = []
            diagnostics.append(f"{robots_url}: bulunamadı; standart davranışla açık kabul edildi.")
            return None

        response.raise_for_status()
        body = response.text
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(robots_url)
        parser.parse(body.splitlines())
        robots_by_origin[origin] = parser
        robots_sitemaps[origin] = [
            line.split(":", 1)[1].strip()
            for line in body.splitlines()
            if line.lower().startswith("sitemap:") and ":" in line
        ]
        diagnostics.append(f"{robots_url}: okundu.")
        return parser
    except requests.RequestException as exc:
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(["User-agent: *", "Disallow: /"])
        robots_by_origin[origin] = parser
        robots_sitemaps[origin] = []
        diagnostics.append(f"{robots_url}: okunamadı, bu origin taranmadı ({exc.__class__.__name__}).")
        return parser


def allowed(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in A101_HOSTS:
        return False
    parser = load_robots(get_origin(url))
    return True if parser is None else parser.can_fetch(USER_AGENT, url)


def fetch(url: str, *, accept: str | None = None) -> requests.Response | None:
    global last_request_at
    if not allowed(url):
        return None

    headers = {"Accept": accept} if accept else {}
    try:
        rate_limit()
        response = session.get(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)
        last_request_at = time.monotonic()
        if response.status_code in (403, 429):
            diagnostics.append(f"{url}: erişim/rate-limit yanıtı {response.status_code}; atlandı.")
            return None
        response.raise_for_status()
        return response
    except requests.RequestException as exc:
        diagnostics.append(f"{url}: {exc.__class__.__name__}; atlandı.")
        return None


def decode_xml_response(response: requests.Response) -> str:
    content = response.content
    if response.url.endswith(".gz") or content[:2] == b"\x1f\x8b":
        content = gzip.decompress(content)
    return content.decode(response.encoding or "utf-8", errors="replace")


def common_sitemaps(origin: str) -> list[str]:
    return [
        f"{origin}/sitemap.xml",
        f"{origin}/sitemap_index.xml",
        f"{origin}/sitemap-index.xml",
        f"{origin}/sitemaps/sitemap.xml",
    ]


def discover_sitemap_urls() -> tuple[set[str], set[str]]:
    all_urls: set[str] = set()
    sitemap_urls: set[str] = set()
    queue: deque[str] = deque()

    for start in START_URLS:
        origin = get_origin(start)
        load_robots(origin)
        for item in robots_sitemaps.get(origin, []):
            queue.append(item)
        for item in common_sitemaps(origin):
            queue.append(item)

    seen_sitemaps: set[str] = set()
    while queue and len(seen_sitemaps) < 500:
        sitemap_url = queue.popleft()
        if sitemap_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sitemap_url)

        response = fetch(sitemap_url, accept="application/xml,text/xml,*/*")
        if not response:
            continue

        try:
            text = decode_xml_response(response)
            root = ET.fromstring(text)
        except (ET.ParseError, OSError, EOFError):
            continue

        tag = root.tag.rsplit("}", 1)[-1].lower()
        locs = [
            (node.text or "").strip()
            for node in root.iter()
            if node.tag.rsplit("}", 1)[-1].lower() == "loc" and node.text
        ]

        if tag == "sitemapindex":
            for loc in locs:
                queue.append(loc)
                sitemap_urls.add(loc)
        elif tag == "urlset":
            all_urls.update(locs)

    diagnostics.append(f"Sitemap keşfi: {len(all_urls)} URL, {len(seen_sitemaps)} sitemap denendi.")
    return all_urls, sitemap_urls


def is_product_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return bool(
        re.search(r"_p-\d+", path)
        or re.search(r"/product/\d+", path)
        or re.search(r"/urun/[^/]+-\d+(?:/|$)", path)
    )


def is_listing_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    if is_product_url(url):
        return False
    blocked_words = (
        "/yardim", "/hakkimizda", "/iletisim", "/sozlesme", "/kvkk",
        "/gizlilik", "/islem-rehberi", "/blog", "/kampanyalar/"
    )
    if any(word in path for word in blocked_words):
        return False
    return any(word in path for word in ("/kapida", "/ekstra", "/kategori", "/category"))


def extract_links(html: str, base_url: str) -> set[str]:
    soup = BeautifulSoup(html, "html.parser")
    links: set[str] = set()
    for node in soup.select("a[href]"):
        href = node.get("href")
        if not href:
            continue
        absolute = urljoin(base_url, href).split("#", 1)[0]
        if urlparse(absolute).netloc.lower() in A101_HOSTS:
            links.add(absolute)

    for match in re.finditer(
        r'(?:https?:\\/\\/[^"\\\s]+|\\/[^"\\\s]+)',
        html,
        flags=re.IGNORECASE,
    ):
        raw = match.group(0).replace("\\/", "/")
        if "_p-" not in raw and "/product/" not in raw:
            continue
        absolute = urljoin(base_url, raw)
        if urlparse(absolute).netloc.lower() in A101_HOSTS:
            links.add(absolute)
    return links


def discover_product_urls(sitemap_urls: set[str]) -> set[str]:
    product_urls = {url for url in sitemap_urls if is_product_url(url)}
    listing_urls = [url for url in sitemap_urls if is_listing_url(url)]

    for start in START_URLS:
        if start not in listing_urls:
            listing_urls.append(start)

    seen_listing: set[str] = set()
    queue: deque[str] = deque(listing_urls[:MAX_LISTING_PAGES])

    while queue and len(seen_listing) < MAX_LISTING_PAGES and len(product_urls) < MAX_PRODUCTS:
        url = queue.popleft()
        if url in seen_listing:
            continue
        seen_listing.add(url)

        response = fetch(url)
        if not response or "text/html" not in response.headers.get("content-type", ""):
            continue

        for link in extract_links(response.text, response.url):
            if is_product_url(link):
                product_urls.add(link)
            elif is_listing_url(link) and link not in seen_listing and len(queue) < MAX_LISTING_PAGES:
                queue.append(link)

    diagnostics.append(
        f"Ürün keşfi: {len(product_urls)} ürün URL'si, {len(seen_listing)} liste sayfası."
    )
    return set(list(product_urls)[:MAX_PRODUCTS])


def walk_json(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json(child)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def first_value(objects: list[dict[str, Any]], keys: tuple[str, ...]) -> Any:
    for obj in objects:
        lowered = {str(key).lower(): value for key, value in obj.items()}
        for key in keys:
            value = lowered.get(key.lower())
            if value not in (None, "", [], {}):
                return value
    return None


def find_barcode(objects: list[dict[str, Any]], html: str) -> str:
    candidates: list[str] = []
    barcode_keys = {
        "barcode", "barcodeno", "barcode_no", "gtin", "gtin8", "gtin12",
        "gtin13", "gtin14", "ean", "ean13", "upc", "productbarcode"
    }

    for obj in objects:
        for key, value in obj.items():
            if str(key).lower().replace("-", "_") not in barcode_keys:
                continue
            digits = re.sub(r"\D", "", str(value))
            if 8 <= len(digits) <= 14:
                candidates.append(digits)

    patterns = [
        r'(?i)(?:barkod|barcode|gtin(?:13)?|ean(?:13)?)["\s:=_-]{1,20}["\']?(\d{8,14})',
        r'(?i)"(?:barcode|gtin13|gtin|ean13|ean)"\s*:\s*"(\d{8,14})"',
    ]
    for pattern in patterns:
        candidates.extend(re.findall(pattern, html))

    return candidates[0] if candidates else ""


def parse_price(value: Any) -> float | None:
    if isinstance(value, dict):
        value = value.get("price") or value.get("value") or value.get("discounted") or value.get("normal")
    if value is None:
        return None
    text = str(value).strip().replace("₺", "").replace("TL", "").strip()
    if re.fullmatch(r"\d{3,}", text) and isinstance(value, int):
        return round(int(value) / 100, 2)
    text = text.replace(".", "").replace(",", ".") if "," in text else text
    try:
        number = float(re.sub(r"[^\d.]", "", text))
        return number if number > 0 else None
    except ValueError:
        return None


def extract_product(url: str, html: str) -> dict[str, Any] | None:
    soup = BeautifulSoup(html, "html.parser")
    json_objects: list[dict[str, Any]] = []

    for script in soup.select('script[type="application/ld+json"]'):
        try:
            parsed = json.loads(script.get_text(strip=True))
            json_objects.extend(list(walk_json(parsed)))
        except (json.JSONDecodeError, TypeError):
            continue

    for script in soup.select("script#__NEXT_DATA__, script[type='application/json']"):
        text = script.string or script.get_text()
        if not text or len(text) > 20_000_000:
            continue
        try:
            parsed = json.loads(text)
            json_objects.extend(list(walk_json(parsed)))
        except (json.JSONDecodeError, TypeError):
            continue

    product_objects = [
        obj for obj in json_objects
        if str(obj.get("@type", "")).lower() == "product"
        or ("name" in obj and any(key in obj for key in ("sku", "gtin13", "barcode", "offers", "price")))
    ]
    objects = product_objects or json_objects

    def meta(*selectors: str) -> str:
        for selector in selectors:
            node = soup.select_one(selector)
            if node:
                return clean_text(node.get("content") or node.get_text())
        return ""

    name = clean_text(first_value(objects, ("name", "title", "productName", "displayName")))
    if not name:
        name = meta('meta[property="og:title"]', 'meta[name="twitter:title"]')
    if not name and soup.title:
        name = clean_text(soup.title.get_text())
    name = re.sub(r"\s*[|\-–]\s*A101.*$", "", name, flags=re.IGNORECASE).strip()

    if not name:
        slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
        slug = re.sub(r"_p-\d+.*$", "", slug)
        name = clean_text(slug.replace("-", " ").replace("_", " ").title())

    if not name:
        return None

    brand_value = first_value(objects, ("brand", "brands", "manufacturer"))
    if isinstance(brand_value, dict):
        brand_value = brand_value.get("name")
    brand = clean_text(brand_value)

    category_value = first_value(objects, ("category", "categoryName", "category_name"))
    if isinstance(category_value, dict):
        category_value = category_value.get("name") or category_value.get("displayName")
    category = clean_text(category_value)

    image_value = first_value(objects, ("image", "images", "imageUrl", "image_url"))
    if isinstance(image_value, list):
        image_value = image_value[0] if image_value else ""
    if isinstance(image_value, dict):
        image_value = image_value.get("url") or image_value.get("src")
    image = clean_text(image_value) or meta('meta[property="og:image"]')

    sku = clean_text(first_value(objects, ("sku", "id", "productId", "product_id", "stockCode")))
    if not sku:
        match = re.search(r"(?:_p-|/product/)(\d+)", url)
        sku = match.group(1) if match else ""

    price_value = first_value(objects, ("price", "currentPrice", "discountedPrice", "offers"))
    price = parse_price(price_value)
    barcode = find_barcode(objects, html)

    available = True
    availability = clean_text(first_value(objects, ("availability", "stock", "inStock", "available"))).lower()
    if availability in {"false", "0", "outofstock", "out of stock", "stokta yok"}:
        available = False

    return {
        "id": barcode or sku or hashlib.sha1(url.encode("utf-8")).hexdigest()[:16],
        "sku": sku,
        "barcode": barcode,
        "name": name,
        "brand": brand,
        "category": category,
        "imageUrl": image,
        "url": url,
        "price": price,
        "currency": "TL",
        "available": available,
        "source": "a101-public-page",
    }


def parse_product_object(raw: dict[str, Any]) -> dict[str, Any] | None:
    name = clean_text(
        raw.get("title") or raw.get("name") or raw.get("product_name") or raw.get("displayName")
    )
    if not name:
        return None

    attributes = raw.get("attributes")
    attribute_objects = list(walk_json(attributes)) if attributes else []
    objects = [raw, *attribute_objects]
    barcode = find_barcode(objects, json.dumps(raw, ensure_ascii=False))
    sku = clean_text(raw.get("id") or raw.get("sku") or raw.get("productId"))

    image = raw.get("image") or raw.get("images") or raw.get("image_url") or raw.get("imageUrl")
    if isinstance(image, list):
        first = image[0] if image else ""
        image = first.get("url") if isinstance(first, dict) else first
    elif isinstance(image, dict):
        image = image.get("url") or image.get("src")

    category = raw.get("category")
    if isinstance(category, dict):
        category = category.get("name") or category.get("displayName")

    return {
        "id": barcode or sku or hashlib.sha1(name.encode("utf-8")).hexdigest()[:16],
        "sku": sku,
        "barcode": barcode,
        "name": name,
        "brand": clean_text(raw.get("brand") or raw.get("brands")),
        "category": clean_text(category),
        "imageUrl": clean_text(image),
        "url": clean_text(raw.get("link") or raw.get("url")),
        "price": parse_price(raw.get("price") or raw.get("current_price")),
        "currency": clean_text(raw.get("currency") or "TL"),
        "available": raw.get("available", raw.get("inStock", True)) is not False,
        "source": "a101-managed-api",
    }


def looks_like_product(obj: dict[str, Any]) -> bool:
    keys = {str(key).lower() for key in obj}
    return bool(
        ("title" in keys or "name" in keys or "product_name" in keys)
        and keys.intersection({"sku", "id", "price", "image", "images", "attributes", "category"})
    )


def sync_with_parse_api(api_key: str) -> list[dict[str, Any]]:
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    products: list[dict[str, Any]] = []
    category_ids: set[str] = set()

    def call(endpoint: str, params: dict[str, Any] | None = None) -> Any:
        response = requests.get(
            f"{PARSE_BASE}/{endpoint}",
            params=params or {},
            headers=headers,
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("data", payload)

    try:
        categories = call("get_kapida_categories")
        for obj in walk_json(categories):
            category_id = obj.get("id") or obj.get("category_id")
            if category_id and re.fullmatch(r"C\d+", str(category_id)):
                category_ids.add(str(category_id))

        for category_id in sorted(category_ids)[:80]:
            payload = None
            for params in ({"category_id": category_id}, {"id": category_id}):
                try:
                    payload = call("get_kapida_category_products", params)
                    break
                except requests.RequestException:
                    continue
            if payload is None:
                continue

            for obj in walk_json(payload):
                if looks_like_product(obj):
                    product = parse_product_object(obj)
                    if product:
                        products.append(product)

        diagnostics.append(
            f"Managed API: {len(category_ids)} kategori, {len(products)} ürün nesnesi."
        )
    except (requests.RequestException, ValueError, KeyError) as exc:
        diagnostics.append(f"Managed API kullanılamadı: {exc.__class__.__name__}.")
        return []

    return deduplicate(products)


def scrape_public_pages() -> list[dict[str, Any]]:
    discovered_urls, _ = discover_sitemap_urls()
    product_urls = discover_product_urls(discovered_urls)
    products: list[dict[str, Any]] = []

    for index, url in enumerate(sorted(product_urls), start=1):
        response = fetch(url)
        if not response:
            continue
        product = extract_product(response.url, response.text)
        if product:
            products.append(product)

        if index % 100 == 0:
            print(f"[{index}/{len(product_urls)}] {len(products)} ürün çıkarıldı.", flush=True)

    return deduplicate(products)


def deduplicate(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chosen: dict[str, dict[str, Any]] = {}
    for product in products:
        key = (
            f"b:{product.get('barcode')}"
            if product.get("barcode")
            else f"s:{product.get('sku')}"
            if product.get("sku")
            else f"u:{product.get('url') or product.get('id')}"
        )
        current = chosen.get(key)
        if current is None:
            chosen[key] = product
            continue
        current_score = sum(bool(current.get(field)) for field in ("barcode", "brand", "category", "imageUrl", "price", "url"))
        new_score = sum(bool(product.get(field)) for field in ("barcode", "brand", "category", "imageUrl", "price", "url"))
        if new_score > current_score:
            chosen[key] = product
    return sorted(chosen.values(), key=lambda item: item.get("name", "").casefold())


def load_existing() -> dict[str, Any]:
    if not OUTPUT.exists():
        return {"metadata": {}, "products": []}
    try:
        return json.loads(OUTPUT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"metadata": {}, "products": []}


def save(products: list[dict[str, Any]], status: str, message: str) -> None:
    existing = load_existing()
    if not products and existing.get("products"):
        products = existing["products"]
        status = "stale"
        message = f"Yeni senkron ürün üretmedi; önceki {len(products)} ürün korundu."

    payload = {
        "metadata": {
            "generatedAt": now_iso(),
            "status": status,
            "message": message,
            "source": "A101 public pages; optional managed API",
            "productCount": len(products),
            "barcodeCount": sum(bool(product.get("barcode")) for product in products),
            "requestDelaySeconds": REQUEST_DELAY,
            "diagnostics": diagnostics[-50:],
        },
        "products": products,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> int:
    parse_key = os.getenv("PARSE_API_KEY", "").strip()
    products: list[dict[str, Any]] = []

    if parse_key:
        products = sync_with_parse_api(parse_key)

    if not products:
        products = scrape_public_pages()

    status = "ok" if products else "no-products-found"
    message = (
        f"{len(products)} A101 ürünü senkronlandı."
        if products
        else "A101 public sayfalarından ürün çıkarılamadı. robots.txt, sitemap veya sayfa yapısı değişmiş olabilir."
    )
    save(products, status, message)
    print(message)
    for line in diagnostics[-20:]:
        print(f"- {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
