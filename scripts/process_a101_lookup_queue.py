#!/usr/bin/env python3
"""Process one queued barcode/name mapping using the maintained A101 Kapıda API."""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import requests

PARSE_API_BASE = "https://api.parse.bot/scraper/01e0d684-e029-4758-9eb5-c6214e407387"
TIMEOUT = 30


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", clean(value).lower())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9çğıöşü.,]+", " ", text).strip()


def tokens(value: Any) -> list[str]:
    ignored = {
        "ve", "ile", "icin", "için", "adet", "paket", "urun", "ürün",
        "sivi", "sıvı", "deterjani", "deterjanı", "aromali", "aromalı",
        "cesitleri", "çeşitleri",
    }
    return [token for token in normalize(value).split() if len(token) > 1 and token not in ignored]


def quantities(value: Any) -> list[str]:
    matches = re.findall(r"\b\d+(?:[.,]\d+)?\s*(?:ml|l|lt|litre|g|gr|kg|li|lu)\b", normalize(value))
    return [
        item.replace(" ", "").replace("litre", "l").replace("lt", "l").replace("gr", "g")
        for item in matches
    ]


def parse_price(value: Any) -> float | None:
    if isinstance(value, dict):
        value = value.get("discounted") or value.get("normal") or value.get("price") or value.get("value")
        if isinstance(value, int) and value >= 1000:
            return round(value / 100, 2)
    if value in (None, ""):
        return None
    raw = str(value).replace("₺", "").replace("TL", "").strip()
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        number = float(re.sub(r"[^\d.]", "", raw))
        return number if number > 0 else None
    except ValueError:
        return None


def image_url(raw: dict[str, Any]) -> str:
    images = raw.get("image") or raw.get("images") or raw.get("imageUrl") or raw.get("image_url")
    if isinstance(images, str):
        return images
    if isinstance(images, dict):
        return clean(images.get("url") or images.get("src"))
    if isinstance(images, list) and images:
        preferred = next(
            (item for item in images if isinstance(item, dict) and item.get("imageType") == "product"),
            images[0],
        )
        return clean(preferred.get("url") or preferred.get("src")) if isinstance(preferred, dict) else clean(preferred)
    return ""


def walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def extract_products(payload: Any) -> list[dict[str, Any]]:
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    candidates = []
    if isinstance(data, dict):
        candidates.extend([
            data.get("products"),
            data.get("page_content"),
            data.get("pageContent"),
        ])
        res = data.get("res")
        if isinstance(res, list) and res and isinstance(res[0], dict):
            candidates.extend([res[0].get("page_content"), res[0].get("pageContent")])
    direct = next((item for item in candidates if isinstance(item, list)), None)
    raws = direct or [
        obj for obj in walk(data)
        if isinstance(obj, dict)
        and (obj.get("title") or obj.get("name") or obj.get("product_name"))
        and (obj.get("id") or obj.get("sku") or obj.get("productId"))
        and (obj.get("price") is not None or obj.get("image") or obj.get("images") or obj.get("link"))
    ]

    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raws:
        name = clean(raw.get("title") or raw.get("name") or raw.get("product_name"))
        sku = clean(raw.get("id") or raw.get("sku") or raw.get("productId"))
        key = sku or name
        if not name or key in seen:
            continue
        seen.add(key)
        products.append({
            "sku": sku,
            "name": name,
            "brand": clean(raw.get("brand") or raw.get("brands")),
            "category": clean(raw.get("category") or raw.get("category_name")),
            "image_url": image_url(raw),
            "url": clean(raw.get("link") or raw.get("url") or raw.get("seoUrl")),
            "price": parse_price(raw.get("price") or raw.get("current_price") or raw.get("discounted_price")),
            "available": raw.get("available", raw.get("inStock", True)) is not False,
        })
    return products


def choose(products: list[dict[str, Any]], query: str, brand_hint: str) -> dict[str, Any] | None:
    query_tokens = tokens(query)
    brand_tokens = tokens(brand_hint)
    query_quantities = quantities(query)
    ranked: list[tuple[float, dict[str, Any]]] = []

    for product in products:
        title_tokens = tokens(product["name"])
        title_set = set(title_tokens)
        matched = sum(token in title_set for token in query_tokens)
        coverage = matched / len(query_tokens) if query_tokens else 0
        precision = matched / len(title_tokens) if title_tokens else 0
        brand_match = 0.18 if brand_tokens and any(token in title_set for token in brand_tokens) else 0
        title_quantities = quantities(product["name"])
        quantity_match = 0
        if query_quantities:
            quantity_match = 0.32 if any(item in title_quantities for item in query_quantities) else -0.22
        availability = 0.03 if product.get("available", True) else -0.08
        score = coverage * 0.62 + precision * 0.18 + brand_match + quantity_match + availability
        ranked.append((score, product))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked[0][1] if ranked and ranked[0][0] >= 0.48 else None


def supabase_headers(key: str, *, prefer: str | None = None) -> dict[str, str]:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def main() -> int:
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.getenv("SUPABASE_ANON_KEY", "")
    parse_key = os.getenv("PARSE_API_KEY", "")
    store_id = os.getenv("A101_STORE_ID", "")

    if not all((supabase_url, supabase_key, parse_key)):
        print("SUPABASE_URL, SUPABASE_ANON_KEY veya PARSE_API_KEY eksik; kuyruk işlenmedi.")
        return 0

    now = datetime.now(timezone.utc).isoformat()
    queue_url = (
        f"{supabase_url}/rest/v1/product_lookup_queue"
        f"?select=barcode,name_hint,brand_hint,status,attempts,next_attempt_at,updated_at"
        f"&status=eq.pending&name_hint=neq.&next_attempt_at=lte.{quote(now)}"
        f"&order=updated_at.asc&limit=1"
    )
    response = requests.get(queue_url, headers=supabase_headers(supabase_key), timeout=TIMEOUT)
    response.raise_for_status()
    items = response.json()
    if not items:
        print("İşlenecek ürün kuyruğu yok.")
        return 0

    item = items[0]
    barcode = clean(item.get("barcode"))
    name_hint = clean(item.get("name_hint"))
    brand_hint = clean(item.get("brand_hint"))

    params = {"page": 1, "limit": 60, "query": name_hint}
    if store_id:
        params["store_id"] = store_id
    api_response = requests.get(
        f"{PARSE_API_BASE}/search_kapida_products",
        params=params,
        headers={"X-API-Key": parse_key, "Accept": "application/json"},
        timeout=TIMEOUT,
    )
    if api_response.status_code == 429:
        print("Parse ücretsiz sorgu limiti doldu; kayıt kuyrukta bırakıldı.")
        return 0
    api_response.raise_for_status()

    product = choose(extract_products(api_response.json()), name_hint, brand_hint)
    queue_item_url = f"{supabase_url}/rest/v1/product_lookup_queue?barcode=eq.{quote(barcode)}"

    if product:
        product_row = {
            "barcode": barcode,
            "name": product["name"],
            "brand": product.get("brand", ""),
            "image_url": product.get("image_url", ""),
            "source": "a101-kapida",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        upsert = requests.post(
            f"{supabase_url}/rest/v1/products?on_conflict=barcode",
            headers=supabase_headers(supabase_key, prefer="resolution=merge-duplicates,return=minimal"),
            data=json.dumps(product_row, ensure_ascii=False).encode("utf-8"),
            timeout=TIMEOUT,
        )
        upsert.raise_for_status()
        delete = requests.delete(queue_item_url, headers=supabase_headers(supabase_key), timeout=TIMEOUT)
        delete.raise_for_status()
        print(f"Öğrenildi: {barcode} -> {product['name']}")
        return 0

    attempts = int(item.get("attempts") or 0) + 1
    failed = attempts >= 3
    next_attempt = datetime.now(timezone.utc) + timedelta(hours=min(48, 2**attempts))
    update = {
        "attempts": attempts,
        "status": "failed" if failed else "pending",
        "next_attempt_at": next_attempt.isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    patch = requests.patch(
        queue_item_url,
        headers=supabase_headers(supabase_key, prefer="return=minimal"),
        data=json.dumps(update).encode("utf-8"),
        timeout=TIMEOUT,
    )
    patch.raise_for_status()
    print(f"Eşleşme bulunamadı: {barcode}; attempts={attempts}; status={update['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
