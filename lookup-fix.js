const A101_SEARCH_BASE = 'https://www.a101.com.tr/arama?k=';
const A101_READER_BASE = 'https://r.jina.ai/http://www.a101.com.tr/arama?k=';

window.fetchProductFromInternet = async function fetchProductFromInternet(barcode) {
  const catalogProduct = await fetchOpenFoodFactsV2(barcode);
  const searchText = catalogProduct?.name || barcode;

  let a101Match = null;
  try {
    a101Match = await fetchA101Match(searchText);
  } catch (_) {
    // A101 tarafı geçici olarak erişilemezse genel barkod sonucu kullanılmaya devam eder.
  }

  if (a101Match) {
    return {
      barcode,
      name: a101Match.name,
      brand: catalogProduct?.brand || extractBrand(a101Match.name),
      imageUrl: catalogProduct?.imageUrl || '',
      source: 'a101',
      a101Url: a101Match.url
    };
  }

  if (catalogProduct) {
    return {
      ...catalogProduct,
      a101Url: `${A101_SEARCH_BASE}${encodeURIComponent(catalogProduct.name)}`
    };
  }

  return null;
};

async function fetchOpenFoodFactsV2(barcode) {
  const fields = [
    'code',
    'status',
    'product_name',
    'product_name_tr',
    'brands',
    'image_front_small_url',
    'image_front_url',
    'quantity'
  ].join(',');

  const response = await fetchWithTimeout(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${encodeURIComponent(fields)}`,
    10000,
    { headers: { Accept: 'application/json' } }
  );

  if (!response.ok) return null;
  const payload = await response.json();
  if (payload.status !== 1 || !payload.product) return null;

  const sourceProduct = payload.product;
  const name = cleanText(sourceProduct.product_name_tr || sourceProduct.product_name);
  if (!name) return null;

  const quantity = cleanText(sourceProduct.quantity);
  const fullName = quantity && !name.toLocaleLowerCase('tr-TR').includes(quantity.toLocaleLowerCase('tr-TR'))
    ? `${name} ${quantity}`
    : name;

  return {
    barcode,
    name: fullName,
    brand: cleanText(sourceProduct.brands),
    imageUrl: sourceProduct.image_front_small_url || sourceProduct.image_front_url || '',
    source: 'openfoodfacts'
  };
}

async function fetchA101Match(query) {
  const normalizedQuery = cleanText(query);
  if (!normalizedQuery || /^\d+$/.test(normalizedQuery)) return null;

  const readerUrl = `${A101_READER_BASE}${encodeURIComponent(normalizedQuery)}`;
  const response = await fetchWithTimeout(readerUrl, 12000, {
    headers: { Accept: 'text/plain' }
  });
  if (!response.ok) return null;

  const markdown = await response.text();
  const candidates = parseA101Candidates(markdown);
  if (!candidates.length) return null;

  const queryTokens = tokenizeProductName(normalizedQuery);
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: productMatchScore(queryTokens, tokenizeProductName(candidate.name)) }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.score >= 0.34 ? ranked[0] : null;
}

function parseA101Candidates(markdown) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    /\[([^\]\n]{3,220})\]\((https?:\/\/www\.a101\.com\.tr\/kapida\/[^)\s]+_p-\d+[^)]*)\)/gi,
    /\[([^\]\n]{3,220})\]\((\/kapida\/[^)\s]+_p-\d+[^)]*)\)/gi
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
      const name = cleanA101Title(match[1]);
      const rawUrl = match[2];
      const url = rawUrl.startsWith('http') ? rawUrl : `https://www.a101.com.tr${rawUrl}`;
      if (!name || seen.has(url)) continue;
      seen.add(url);
      candidates.push({ name, url });
    }
  });

  return candidates;
}

function cleanA101Title(value) {
  return cleanText(String(value || '')
    .replace(/Peşin Fiyatına\s*\d+\s*Taksit/gi, '')
    .replace(/%\s*\d+\s*İNDİRİM/gi, '')
    .replace(/₺[\d.,]+/g, '')
    .replace(/Sepete Ekle/gi, '')
    .replace(/^\d+\s+/, ''));
}

function tokenizeProductName(value) {
  const ignored = new Set(['ve', 'ile', 'icin', 'için', 'adet', 'paket', 'urun', 'ürün']);
  return cleanText(value)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !ignored.has(token));
}

function productMatchScore(queryTokens, titleTokens) {
  if (!queryTokens.length || !titleTokens.length) return 0;
  const titleSet = new Set(titleTokens);
  const matches = queryTokens.filter((token) => titleSet.has(token)).length;
  const coverage = matches / queryTokens.length;
  const precision = matches / titleTokens.length;
  return (coverage * 0.8) + (precision * 0.2);
}

function extractBrand(name) {
  const firstToken = cleanText(name).split(/\s+/)[0] || '';
  return firstToken.length >= 2 ? firstToken : '';
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timeout);
  }
}

window.showProduct = function showProduct(product, manual) {
  els.productCard.classList.remove('hidden');
  els.productBarcode.textContent = product.barcode;
  els.productName.textContent = product.name || 'Ürün adı gerekli';

  const sourceLabel = product.source === 'a101'
    ? 'A101 kataloğunda bulundu'
    : product.source === 'openfoodfacts'
      ? 'Barkod veritabanında bulundu'
      : '';

  els.productBrand.textContent = manual
    ? 'İnternet kataloglarında bulunamadı'
    : [product.brand, sourceLabel].filter(Boolean).join(' • ') || 'Marka bilgisi yok';

  els.manualProductFields.classList.toggle('hidden', !manual);
  els.manualProductName.value = product.name || '';
  els.manualProductBrand.value = product.brand || '';
  els.quantityInput.value = '1';

  if (product.imageUrl) {
    els.productImage.src = product.imageUrl;
    els.productImage.classList.remove('hidden');
  } else {
    els.productImage.removeAttribute('src');
    els.productImage.classList.add('hidden');
  }

  let a101Link = document.getElementById('a101ProductLink');
  if (!a101Link) {
    a101Link = document.createElement('a');
    a101Link.id = 'a101ProductLink';
    a101Link.className = 'secondary-button a101-product-link';
    a101Link.target = '_blank';
    a101Link.rel = 'noopener noreferrer';
    els.productCard.querySelector('.product-summary').insertAdjacentElement('afterend', a101Link);
  }

  const a101Url = product.a101Url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name || product.barcode)}`;
  a101Link.href = a101Url;
  a101Link.textContent = product.source === 'a101' ? 'A101 ürününü aç' : 'A101’de ara';
  a101Link.classList.toggle('hidden', manual && !product.name);

  if (manual) setTimeout(() => els.manualProductName.focus(), 50);
  else setTimeout(() => els.quantityInput.select(), 50);
};
