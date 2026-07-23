#!/usr/bin/env python3
"""Bounded A101 sync used by GitHub Actions.

Uses the public unauthenticated WAW search service and public sitemap URLs.
It deliberately avoids the slower listing-page crawl so every run completes
within a predictable window.
"""

from __future__ import annotations

import os

import sync_a101_catalog as base
import sync_a101_catalog_fast as fast


def main() -> int:
    base.TIMEOUT = int(os.getenv("A101_HTTP_TIMEOUT", "12"))
    products: list[dict] = []

    parse_key = os.getenv("PARSE_API_KEY", "").strip()
    if parse_key:
        products.extend(base.sync_with_parse_api(parse_key))

    products.extend(fast.sync_waw_search())

    try:
        discovered_urls, _ = base.discover_sitemap_urls()
        sitemap_products = [
            product
            for url in discovered_urls
            if (product := fast.product_from_url(url))
        ]
        products.extend(sitemap_products)
        base.diagnostics.append(
            f"Hızlı sitemap keşfi: {len(sitemap_products)} ürün URL'si."
        )
    except Exception as exc:  # diagnostics should survive source changes
        base.diagnostics.append(
            f"Sitemap keşfi atlandı: {exc.__class__.__name__}: {exc}"
        )

    products = fast.merge_products(products)
    barcode_count = sum(bool(item.get("barcode")) for item in products)
    sku_count = sum(bool(item.get("sku")) for item in products)
    status = "ok" if products else "no-products-found"
    message = (
        f"{len(products)} A101 ürünü senkronlandı; "
        f"{barcode_count} gerçek barkod, {sku_count} A101 ürün kodu."
        if products
        else "A101 public arama ve sitemap kaynaklarından ürün çıkarılamadı."
    )

    base.save(products, status, message)
    print(message)
    for line in base.diagnostics[-40:]:
        print(f"- {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
