#!/usr/bin/env python3
"""Fast A101 catalog synchronizer.

Combines two public, unauthenticated sources:
1. A101's public WAWLabs search service for rich product data and GTIN/barcode.
2. Public A101 sitemap/product URLs for broad SKU/name coverage.

No login, CAPTCHA bypass, private token, or access-control bypass is used.
Requests are rate-limited and the crawler identifies this repository.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from typing import Any
from urllib.parse import unquote, urlparse

import requests

import sync_a101_catalog as base

WAW_SEARCH_URLS = [
    "https://a101-ecom.wawlabs.com/search",
    "https://a101.wawlabs.com/search",
]
WAW_DELAY = float(os.getenv("A101_WAW_DELAY", "0.45"))
WAW_RESULTS_PER_PAGE = 60
WAW_MAX_PAGES = int(os.getenv("A101_WAW_MAX_PAGES", "60"))
WAW_QUERIES = [
    item.strip()
    for item in os.getenv(
        "A101_WAW_QUERIES",
        "a,e,i,ı,o,ö,u,ü,süt,su,çay,kahve,peynir,yoğurt,ekmek,çikolata,"
        "temizlik,bebek,ev,elektronik,giyim,oyuncak,kişisel bakım,mutfak,atıştırmalık",
    ).split(",")
    if item.strip()
]

session = requests.Session()
session.headers.update({
    "User-Agent": base.USER_AGENT,
    "Accept": "application/json",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
})


def text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def digits(value: Any) -> str:
    found = re.sub(r"\D", "", str(value or ""))
    return found if 6 <= len(found) <= 18 else ""


def walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def image_url(raw: dict[str, Any]) -> str:
    images = raw.get("image") or raw.get("images") or raw.get("imageUrl") or raw.get("image_url")
    if isinstance(images, str):
        return images
    if isinstance(images, dict):
        return text(images.get("url") or images.get("src"))
    if isinstance(images, list):
        product_images = [item for item in images if isinstance(item, dict) and item.get("imageType") == "product"]
        candidates = product_images or images
        if candidates:
            first = candidates[0]
            return text(first.get("url") if isinstance(first, dict) else first)
    return ""


def parse_price(value: Any) -> float | None:
    if isinstance(value, dict):
        value = (
            value.get("discounted")
            or value.get("normal")
            or value.get("price")
            or value.get("value")
        )
        if isinstance(value, int) and value >= 1000:
            return round(value / 100, 2)
    if value is None:
        return None
    raw = str(value).replace("₺", "").replace("TL", "").strip()
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        number = float(re.sub(r"[^\d.]", "", raw))
        return number if number > 0 else None
    except ValueError:
        return None


def looks_like_product(obj: dict[str, Any]) -> bool:
    keys = {str(key).lower() for key in obj}
    has_name = bool(keys.intersection({"title", "name", "product_name", "seoname", "seo_name"}))
    has_identity = bool(keys.intersection({"id", "baseid", "sku", "barcode"}))
    has_product_data = bool(keys.intersection({"price", "image", "images", "attributes", "category", "link", "seourl"}))
    return has_name and has_identity and has_product_data


def parse_waw_product(raw: dict[str, Any]) -> dict[str, Any] | None:
    attributes = raw.get("attributes") if isinstance(raw.get("attributes"), dict) else {}
    name = text(
        raw.get("title")
        or raw.get("name")
        or raw.get("product_name")
        or raw.get("seo_name")
        or attributes.get("name")
    )
    if not name:
        return None

    sku = digits(raw.get("id") or raw.get("baseId") or raw.get("sku") or attributes.get("productId"))
    barcode = digits(
        raw.get("barcode")
        or raw.get("gtin13")
        or raw.get("gtin")
        or attributes.get("barcode")
        or attributes.get("Barkod")
        or attributes.get("GTIN")
        or attributes.get("EAN")
    )
    brand = text(raw.get("brand") or attributes.get("brandLabel") or attributes.get("brand"))
    category = text(raw.get("category") or attributes.get("category") or attributes.get("cl2") or attributes.get("cl1"))
    url = text(
        raw.get("seoUrl")
        or raw.get("link")
        or raw.get("url")
        or attributes.get("url")
    )
    if url.startswith("/"):
        url = f"https://www.a101.com.tr{url}"
    if not url and sku:
        url = f"https://www.a101kapida.com/product/{sku}"

    available = raw.get("available", raw.get("inStock", raw.get("isEnabled", True))) is not False
    price = parse_price(raw.get("price") or attributes.get("discountedText"))

    return {
        "id": barcode or sku or hashlib.sha1((name + url).encode("utf-8")).hexdigest()[:16],
        "sku": sku,
        "barcode": barcode,
        "name": name,
        "brand": brand,
        "category": category,
        "imageUrl": image_url(raw),
        "url": url,
        "price": price,
        "currency": "TL",
        "available": available,
        "source": "a101-public-search",
    }


def extract_products(payload: Any) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    seen_objects: set[int] = set()
    for obj in walk(payload):
        object_id = id(obj)
        if object_id in seen_objects or not looks_like_product(obj):
            continue
        seen_objects.add(object_id)
        product = parse_waw_product(obj)
        if product:
            parsed.append(product)
    return merge_products(parsed)


def find_total(payload: Any) -> int | None:
    totals: list[int] = []
    for obj in walk(payload):
        for key in ("total_item_count", "totalItemCount", "total", "total_count", "count"):
            value = obj.get(key)
            if isinstance(value, int) and value >= 0:
                totals.append(value)
    return max(totals) if totals else None


def fetch_waw_page(query: str, page: int) -> tuple[list[dict[str, Any]], int | None, str | None]:
    params = {
        "q": query,
        "pn": page,
        "rpp": WAW_RESULTS_PER_PAGE,
        "filter": "available:true",
    }
    for endpoint in WAW_SEARCH_URLS:
        try:
            response = session.get(endpoint, params=params, timeout=35)
            if response.status_code in (403, 429):
                base.diagnostics.append(f"WAW {response.status_code}: {endpoint}; bu endpoint atlandı.")
                continue
            response.raise_for_status()
            payload = response.json()
            return extract_products(payload), find_total(payload), endpoint
        except (requests.RequestException, ValueError):
            continue
    return [], None, None


def sync_waw_search() -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    endpoint_used = ""

    for query_index, query in enumerate(WAW_QUERIES, start=1):
        previous_signature = ""
        empty_pages = 0
        expected_pages: int | None = None

        for page in range(1, WAW_MAX_PAGES + 1):
            products, total, endpoint = fetch_waw_page(query, page)
            endpoint_used = endpoint_used or endpoint or ""
            if total is not None:
                expected_pages = max(1, math.ceil(total / WAW_RESULTS_PER_PAGE))

            signature = "|".join(sorted(product.get("id", "") for product in products))
            if not products or signature == previous_signature:
                empty_pages += 1
            else:
                empty_pages = 0
                collected.extend(products)
            previous_signature = signature

            if empty_pages >= 1:
                break
            if expected_pages is not None and page >= expected_pages:
                break
            if len(products) < WAW_RESULTS_PER_PAGE and total is None:
                break
            time.sleep(WAW_DELAY)

        print(
            f"WAW [{query_index}/{len(WAW_QUERIES)}] {query!r}: toplam benzersiz {len(merge_products(collected))}",
            flush=True,
        )

    result = merge_products(collected)
    base.diagnostics.append(
        f"Public WAW araması: {len(result)} ürün; endpoint={endpoint_used or 'erişilemedi'}."
    )
    return result


def product_from_url(url: str) -> dict[str, Any] | None:
    path = unquote(urlparse(url).path)
    if not base.is_product_url(url):
        return None
    tail = path.rstrip("/").rsplit("/", 1)[-1]
    sku_match = re.search(r"(?:_p-|/product/)(\d+)", url)
    sku = sku_match.group(1) if sku_match else ""
    slug = re.sub(r"_p-\d+.*$", "", tail)
    if tail.isdigit() and "/product/" in path:
        name = f"A101 Ürün {tail}"
    else:
        name = text(slug.replace("-", " ").replace("_", " ").title())
    if not name:
        return None
    return {
        "id": sku or hashlib.sha1(url.encode("utf-8")).hexdigest()[:16],
        "sku": sku,
        "barcode": "",
        "name": name,
        "brand": "",
        "category": "",
        "imageUrl": "",
        "url": url,
        "price": None,
        "currency": "TL",
        "available": True,
        "source": "a101-public-sitemap",
    }


def sync_sitemap_products() -> list[dict[str, Any]]:
    discovered_urls, _ = base.discover_sitemap_urls()
    product_urls = {url for url in discovered_urls if base.is_product_url(url)}

    if not product_urls:
        base.diagnostics.append("Sitemap ürün URL'si vermedi; sınırlı kategori keşfi denendi.")
        original_limit = base.MAX_LISTING_PAGES
        base.MAX_LISTING_PAGES = min(original_limit, 180)
        product_urls = base.discover_product_urls(discovered_urls)

    products = [product for url in product_urls if (product := product_from_url(url))]
    products = merge_products(products)
    base.diagnostics.append(f"Public sitemap/kategori keşfi: {len(products)} ürün URL'si.")
    return products


def merge_products(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    sku_index: dict[str, int] = {}
    barcode_index: dict[str, int] = {}
    url_index: dict[str, int] = {}

    def richness(product: dict[str, Any]) -> int:
        return sum(bool(product.get(field)) for field in (
            "barcode", "sku", "name", "brand", "category", "imageUrl", "url", "price"
        ))

    for product in products:
        sku = digits(product.get("sku"))
        barcode = digits(product.get("barcode"))
        url = text(product.get("url"))
        candidate_indexes = [
            sku_index.get(sku) if sku else None,
            barcode_index.get(barcode) if barcode else None,
            url_index.get(url) if url else None,
        ]
        index = next((item for item in candidate_indexes if item is not None), None)

        if index is None:
            index = len(merged)
            merged.append(product.copy())
        else:
            current = merged[index]
            richer, poorer = (product, current) if richness(product) >= richness(current) else (current, product)
            combined = richer.copy()
            for key, value in poorer.items():
                if combined.get(key) in (None, "", [], {}):
                    combined[key] = value
            merged[index] = combined

        final = merged[index]
        final_sku = digits(final.get("sku"))
        final_barcode = digits(final.get("barcode"))
        final_url = text(final.get("url"))
        if final_sku:
            sku_index[final_sku] = index
        if final_barcode:
            barcode_index[final_barcode] = index
        if final_url:
            url_index[final_url] = index

    return sorted(merged, key=lambda item: text(item.get("name")).casefold())


def main() -> int:
    products: list[dict[str, Any]] = []

    parse_key = os.getenv("PARSE_API_KEY", "").strip()
    if parse_key:
        products.extend(base.sync_with_parse_api(parse_key))

    products.extend(sync_waw_search())
    products.extend(sync_sitemap_products())
    products = merge_products(products)

    status = "ok" if products else "no-products-found"
    barcode_count = sum(bool(item.get("barcode")) for item in products)
    sku_count = sum(bool(item.get("sku")) for item in products)
    message = (
        f"{len(products)} A101 ürünü senkronlandı; {barcode_count} gerçek barkod, {sku_count} A101 ürün kodu."
        if products
        else "A101'nin public kaynaklarından ürün çıkarılamadı."
    )
    base.save(products, status, message)
    print(message)
    for line in base.diagnostics[-30:]:
        print(f"- {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
