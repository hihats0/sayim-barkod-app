const A101_SEARCH_BASE = 'https://www.a101.com.tr/arama?k=';
const A101_LIVE_ENDPOINTS = [
  'https://a101-ecom.wawlabs.com/search',
  'https://a101.wawlabs.com/search'
];
const OPEN_FOOD_FACTS_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product/';
const LOCAL_LOOKUP_QUEUE_KEY = 'sayim-barkod-lookup-queue-v2';
const LEARNED_PAGE_SIZE = 60;

const catalogState = {
  products: [],
  visible: LEARNED_PAGE_SIZE,
  loading: false,
  queueRunning: false
};

const originalShowProduct = window.showProduct;

document.addEventListener('DOMContentLoaded', () => {
  bindLearnedCatalogUi();
  bindManualEnrichment();
  loadLearnedProducts();
  setTimeout(() => {
    loadLearnedProducts();
    processLookupQueue();
  }, 1200);
});

window.addEventListener('online', () => processLookupQueue());

function bindLearnedCatalogUi() {
  const catalogView = document.getElementById('catalogView');
  const searchInput = document.getElementById('catalogSearchInput');
  const reloadButton = document.getElementById('reloadCatalogButton');
  const loadMoreButton = document.getElementById('loadMoreCatalogButton');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const isCatalog = tab.dataset.tab === 'catalog';
      catalogView.classList.toggle('active', isCatalog);
      if (!isCatalog) return;

      document.getElementById('scanView').classList.remove('active');
      document.getElementById('listView').classList.remove('active');
      if (typeof stopScanner === 'function') stopScanner();
      loadLearnedProducts();
    });
  });

  searchInput.addEventListener('input', () => {
    catalogState.visible = LEARNED_PAGE_SIZE;
    renderLearnedCatalog();
  });

  reloadButton.addEventListener('click', async () => {
    reloadButton.disabled = true;
    reloadButton.textContent = 'Aranıyor…';
    try {
      await processLookupQueue(true);
      await loadLearnedProducts();
    } finally {
      reloadButton.disabled = false;
      reloadButton.textContent = 'Eksikleri tekrar ara';
    }
  });

  loadMoreButton.addEventListener('click', () => {
    catalogState.visible += LEARNED_PAGE_SIZE;
    renderLearnedCatalog();
  });
}

function bindManualEnrichment() {
  const saveButton = document.getElementById('saveCountButton');
  saveButton.addEventListener('click', () => {
    const manualFields = document.getElementById('manualProductFields');
    if (manualFields.classList.contains('hidden')) return;

    const barcode = normalizeBarcodeKey(document.getElementById('barcodeInput').value);
    const name = cleanText(document.getElementById('manualProductName').value);
    const brand = cleanText(document.getElementById('manualProductBrand').value);
    if (!barcode || !name) return;

    queueProductLookup({ barcode, name, brand });
    setTimeout(() => processLookupQueue(), 500);
  }, true);
}

window.fetchProductFromInternet = async function fetchProductOnDemand(barcode) {
  const normalizedBarcode = normalizeBarcodeKey(barcode);
  if (!normalizedBarcode) return null;

  if (!navigator.onLine) {
    await queueProductLookup({ barcode: normalizedBarcode });
    return null;
  }

  const exactA101 = await findA101Product(normalizedBarcode, normalizedBarcode);
  if (exactA101) {
    await completeQueuedLookup(normalizedBarcode);
    return mapLiveA101Product(exactA101, normalizedBarcode);
  }

  const openFoodProduct = await fetchOpenFoodFacts(normalizedBarcode);
  if (openFoodProduct) {
    const byName = await findA101Product(openFoodProduct.name, normalizedBarcode);
    if (byName) {
      await completeQueuedLookup(normalizedBarcode);
      return mapLiveA101Product(byName, normalizedBarcode);
    }

    await queueProductLookup({
      barcode: normalizedBarcode,
      name: openFoodProduct.name,
      brand: openFoodProduct.brand
    });

    return {
      ...openFoodProduct,
      a101Url: `${A101_SEARCH_BASE}${encodeURIComponent(openFoodProduct.name)}`
    };
  }

  await queueProductLookup({ barcode: normalizedBarcode });
  return null;
};

async function findA101Product(query, expectedBarcode) {
  const products = await searchA101Live(query, 3);
  if (!products.length) return null;

  const exact = products.find((product) => barcodesEqual(product.barcode, expectedBarcode));
  if (exact) return exact;

  return null;
}

async function searchA101Live(query, maxPages = 2) {
  const cleanedQuery = cleanText(query);
  if (!cleanedQuery) return [];

  for (const endpoint of A101_LIVE_ENDPOINTS) {
    const collected = [];
    const seen = new Set();

    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const url = new URL(endpoint);
        url.searchParams.set('q', cleanedQuery);
        url.searchParams.set('pn', String(page));
        url.searchParams.set('rpp', '60');

        const response = await fetchWithTimeout(url.toString(), 9000, {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`A101 HTTP ${response.status}`);

        const payload = await response.json();
        const pageProducts = extractA101Products(payload);
        let added = 0;

        pageProducts.forEach((product) => {
          const key = product.barcode || product.sku || product.url || product.name;
          if (!key || seen.has(key)) return;
          seen.add(key);
          collected.push(product);
          added += 1;
        });

        if (!pageProducts.length || added === 0 || pageProducts.length < 60) break;
      }

      if (collected.length) return collected;
    } catch (_) {
      // Try the next public A101 endpoint. Network/CORS failures are queued for retry.
    }
  }

  return [];
}

function extractA101Products(payload) {
  const products = [];
  const seenObjects = new Set();

  walkJson(payload, (raw) => {
    if (seenObjects.has(raw) || !looksLikeA101Product(raw)) return;
    seenObjects.add(raw);
    const product = normalizeA101Product(raw);
    if (product?.name && (product.barcode || product.sku)) products.push(product);
  });

  return products;
}

function walkJson(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((child) => walkJson(child, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visit(value);
  Object.values(value).forEach((child) => walkJson(child, visit));
}

function looksLikeA101Product(raw) {
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
  const name = raw.title || raw.name || raw.product_name || raw.seo_name || attributes.name;
  const identity = raw.id || raw.baseId || raw.sku || raw.barcode || attributes.barcode || attributes.Barkod;
  const productData = raw.price || raw.images || raw.image || raw.category || raw.brand || raw.seoUrl || attributes.url;
  return Boolean(name && identity && productData);
}

function normalizeA101Product(raw) {
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
  const barcode = normalizeBarcodeKey(
    raw.barcode || raw.gtin13 || raw.gtin || attributes.barcode || attributes.Barkod || attributes.GTIN || attributes.EAN
  );
  const sku = normalizeBarcodeKey(raw.id || raw.baseId || raw.sku || attributes.productId);
  const name = cleanText(raw.title || raw.name || raw.product_name || raw.seo_name || attributes.name);
  const brand = cleanText(raw.brand || attributes.brandLabel || attributes.brand || raw.Marka);
  const category = cleanText(raw.category || attributes.category || attributes.cl2 || attributes.cl1);
  const imageUrl = extractA101Image(raw);
  let url = cleanText(raw.seoUrl || raw.link || raw.url || attributes.url);
  if (url.startsWith('/')) url = `https://www.a101.com.tr${url}`;
  if (!url && sku) url = `https://www.a101kapida.com/product/${sku}`;

  return {
    id: barcode || sku,
    sku,
    barcode,
    name,
    brand,
    category,
    imageUrl,
    url,
    price: parseA101Price(raw.price || attributes.discountedText),
    source: 'a101-live'
  };
}

function extractA101Image(raw) {
  const images = raw.images || raw.image || raw.imageUrl || raw.image_url;
  if (typeof images === 'string') return images;
  if (images && !Array.isArray(images) && typeof images === 'object') return images.url || images.src || '';
  if (!Array.isArray(images)) return '';
  const preferred = images.find((item) => item && typeof item === 'object' && item.imageType === 'product') || images[0];
  return typeof preferred === 'string' ? preferred : (preferred?.url || preferred?.src || '');
}

function parseA101Price(value) {
  if (value && typeof value === 'object') {
    const raw = value.discounted ?? value.normal ?? value.price ?? value.value;
    if (Number.isInteger(raw) && raw >= 1000) return raw / 100;
    value = raw;
  }
  if (value == null || value === '') return null;
  const textValue = String(value).replace(/₺|TL/gi, '').trim();
  const normalized = textValue.includes(',')
    ? textValue.replace(/\./g, '').replace(',', '.')
    : textValue;
  const number = Number.parseFloat(normalized.replace(/[^\d.]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mapLiveA101Product(product, scannedBarcode) {
  return {
    barcode: normalizeBarcodeKey(scannedBarcode || product.barcode || product.sku),
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    source: 'a101-live',
    a101Url: product.url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name)}`,
    category: product.category,
    price: product.price,
    a101Sku: product.sku,
    gtin: product.barcode
  };
}

async function fetchOpenFoodFacts(barcode) {
  const fields = [
    'code', 'status', 'product_name', 'product_name_tr', 'brands',
    'image_front_small_url', 'image_front_url', 'quantity'
  ].join(',');

  try {
    const response = await fetchWithTimeout(
      `${OPEN_FOOD_FACTS_ENDPOINT}${encodeURIComponent(barcode)}.json?fields=${encodeURIComponent(fields)}`,
      9000,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    );
    if (!response.ok) return null;

    const payload = await response.json();
    if (payload.status !== 1 || !payload.product) return null;
    const raw = payload.product;
    const baseName = cleanText(raw.product_name_tr || raw.product_name);
    if (!baseName) return null;
    const quantity = cleanText(raw.quantity);
    const name = quantity && !normalizeSearch(baseName).includes(normalizeSearch(quantity))
      ? `${baseName} ${quantity}`
      : baseName;

    return {
      barcode,
      name,
      brand: cleanText(raw.brands),
      imageUrl: raw.image_front_small_url || raw.image_front_url || '',
      source: 'openfoodfacts'
    };
  } catch (_) {
    return null;
  }
}

async function queueProductLookup(item) {
  const barcode = normalizeBarcodeKey(item.barcode);
  if (!barcode) return;

  const queued = {
    barcode,
    name_hint: cleanText(item.name),
    brand_hint: cleanText(item.brand),
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (state.supabase) {
    try {
      const { error } = await state.supabase.from('product_lookup_queue').upsert(queued, { onConflict: 'barcode' });
      if (!error) return;
    } catch (_) {
      // Fall back to the local queue when the optional queue table is not installed yet.
    }
  }

  const localQueue = loadLocalQueue();
  const current = localQueue.find((entry) => entry.barcode === barcode);
  if (current) {
    current.name_hint = queued.name_hint || current.name_hint;
    current.brand_hint = queued.brand_hint || current.brand_hint;
    current.next_attempt_at = new Date().toISOString();
  } else {
    localQueue.push(queued);
  }
  saveLocalQueue(localQueue);
}

async function processLookupQueue(force = false) {
  if (catalogState.queueRunning || !navigator.onLine) return;
  catalogState.queueRunning = true;

  try {
    const items = await getQueuedLookups(force);
    for (const item of items.slice(0, 8)) {
      let found = await findA101Product(item.barcode, item.barcode);
      if (!found && item.name_hint) found = await findA101Product(item.name_hint, item.barcode);

      if (found) {
        const product = mapLiveA101Product(found, item.barcode);
        await persistProduct(product);
        await completeQueuedLookup(item.barcode);
      } else {
        await postponeQueuedLookup(item);
      }
    }

    await loadLearnedProducts();
  } finally {
    catalogState.queueRunning = false;
  }
}

async function getQueuedLookups(force) {
  const now = new Date().toISOString();
  if (state.supabase) {
    try {
      let query = state.supabase
        .from('product_lookup_queue')
        .select('barcode,name_hint,brand_hint,status,attempts,next_attempt_at,updated_at')
        .eq('status', 'pending')
        .order('updated_at', { ascending: true })
        .limit(20);
      if (!force) query = query.lte('next_attempt_at', now);
      const { data, error } = await query;
      if (!error) return data || [];
    } catch (_) {
      // Use local queue below.
    }
  }

  return loadLocalQueue().filter((item) => force || !item.next_attempt_at || item.next_attempt_at <= now);
}

async function completeQueuedLookup(barcode) {
  if (state.supabase) {
    try {
      const { error } = await state.supabase.from('product_lookup_queue').delete().eq('barcode', barcode);
      if (!error) return;
    } catch (_) {
      // Remove from local queue below.
    }
  }
  removeQueuedLookup(barcode);
}

async function postponeQueuedLookup(item) {
  const attempts = (Number(item.attempts) || 0) + 1;
  const delayMinutes = Math.min(360, 5 * (2 ** Math.min(attempts, 6)));
  const nextAttempt = new Date(Date.now() + delayMinutes * 60_000).toISOString();

  if (state.supabase) {
    try {
      const { error } = await state.supabase
        .from('product_lookup_queue')
        .update({ attempts, next_attempt_at: nextAttempt, updated_at: new Date().toISOString() })
        .eq('barcode', item.barcode);
      if (!error) return;
    } catch (_) {
      // Update local queue below.
    }
  }

  const queue = loadLocalQueue();
  const current = queue.find((entry) => entry.barcode === item.barcode);
  if (current) {
    current.attempts = attempts;
    current.next_attempt_at = nextAttempt;
    current.updated_at = new Date().toISOString();
    saveLocalQueue(queue);
  }
}

function loadLocalQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_LOOKUP_QUEUE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveLocalQueue(queue) {
  localStorage.setItem(LOCAL_LOOKUP_QUEUE_KEY, JSON.stringify(queue.slice(-500)));
}

function removeQueuedLookup(barcode) {
  const normalized = normalizeBarcodeKey(barcode);
  saveLocalQueue(loadLocalQueue().filter((item) => item.barcode !== normalized));
}

async function loadLearnedProducts() {
  if (catalogState.loading) return;
  catalogState.loading = true;
  setCatalogStatus('Öğrenilen ürünler yükleniyor…');

  try {
    const products = [];
    Object.values(state.products || {}).forEach((product) => products.push(normalizeLearnedProduct(product)));

    if (state.supabase) {
      const { data, error } = await state.supabase
        .from('products')
        .select('barcode,name,brand,image_url,source,updated_at')
        .order('updated_at', { ascending: false })
        .limit(5000);
      if (!error) data.forEach((row) => products.push(normalizeLearnedProduct(row)));
    }

    const byBarcode = new Map();
    products.filter((product) => product.barcode && product.name).forEach((product) => {
      const current = byBarcode.get(product.barcode);
      if (!current || productRichness(product) > productRichness(current)) byBarcode.set(product.barcode, product);
    });

    catalogState.products = [...byBarcode.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    catalogState.visible = Math.max(catalogState.visible, LEARNED_PAGE_SIZE);
    updateCatalogBadge();
    renderLearnedCatalog();
  } catch (error) {
    setCatalogStatus(`Ürün hafızası açılamadı: ${friendlyCatalogError(error)}`);
  } finally {
    catalogState.loading = false;
  }
}

function normalizeLearnedProduct(raw) {
  return {
    id: normalizeBarcodeKey(raw.barcode),
    barcode: normalizeBarcodeKey(raw.barcode),
    name: cleanText(raw.name || raw.product_name),
    brand: cleanText(raw.brand),
    imageUrl: raw.imageUrl || raw.image_url || '',
    source: raw.source || 'manual',
    updatedAt: raw.updated_at || '',
    url: raw.a101Url || raw.a101_url || ''
  };
}

function productRichness(product) {
  return ['name', 'brand', 'imageUrl', 'url'].reduce((score, key) => score + (product[key] ? 1 : 0), 0)
    + (product.source === 'a101-live' ? 3 : 0);
}

function renderLearnedCatalog() {
  const list = document.getElementById('catalogList');
  const empty = document.getElementById('catalogEmptyState');
  const moreButton = document.getElementById('loadMoreCatalogButton');
  const query = normalizeSearch(document.getElementById('catalogSearchInput').value);

  if (catalogState.loading) {
    list.innerHTML = '';
    empty.textContent = 'Ürün hafızası yükleniyor…';
    empty.classList.remove('hidden');
    moreButton.classList.add('hidden');
    return;
  }

  const filtered = catalogState.products.filter((product) => {
    if (!query) return true;
    return normalizeSearch(`${product.name} ${product.brand} ${product.barcode}`).includes(query);
  });
  const shown = filtered.slice(0, catalogState.visible);

  list.innerHTML = shown.map(renderLearnedProduct).join('');
  empty.classList.toggle('hidden', shown.length > 0);
  if (!shown.length) {
    empty.textContent = catalogState.products.length
      ? 'Aramana uygun öğrenilmiş ürün bulunamadı.'
      : 'Henüz ürün öğrenilmedi. Bir raf ürününün barkodunu okut; bulunduğunda buraya ve ortak veritabanına kaydedilir.';
  }

  moreButton.classList.toggle('hidden', filtered.length <= catalogState.visible);
  moreButton.textContent = `Daha fazla göster (${Math.min(catalogState.visible, filtered.length)}/${filtered.length})`;
  list.querySelectorAll('[data-select-product]').forEach((button) => {
    button.addEventListener('click', () => selectLearnedProduct(button.dataset.selectProduct));
  });

  const queueCount = loadLocalQueue().length;
  setCatalogStatus(`${catalogState.products.length.toLocaleString('tr-TR')} ürün öğrenildi${queueCount ? ` • ${queueCount} barkod tekrar aranacak` : ''}.`);
}

function renderLearnedProduct(product) {
  const key = escapeHtml(product.barcode);
  const image = product.imageUrl
    ? `<img class="catalog-product-image" src="${escapeAttribute(product.imageUrl)}" alt="" loading="lazy" />`
    : '<div class="catalog-product-placeholder">A101</div>';
  const source = product.source === 'a101-live'
    ? 'A101’den bulundu'
    : product.source === 'openfoodfacts'
      ? 'Genel barkod verisi'
      : 'Elle öğrenildi';
  const meta = [product.brand, source, `Barkod: ${product.barcode}`].filter(Boolean).map(escapeHtml).join(' • ');

  return `
    <article class="catalog-product">
      ${image}
      <div class="catalog-product-copy">
        <h3>${escapeHtml(product.name)}</h3>
        <p class="count-meta">${meta}</p>
      </div>
      <div class="catalog-product-actions">
        <button class="catalog-select" type="button" data-select-product="${key}">Sayıma seç</button>
        <a class="catalog-open" href="${escapeAttribute(product.url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name)}`)}" target="_blank" rel="noopener noreferrer">A101’de ara</a>
      </div>
    </article>
  `;
}

function selectLearnedProduct(barcode) {
  const product = catalogState.products.find((item) => item.barcode === barcode);
  if (!product) return;

  state.currentProduct = product;
  document.getElementById('barcodeInput').value = product.barcode;
  switchTab('scan');
  document.getElementById('catalogView').classList.remove('active');
  showProduct(product, false);
  showToast('Öğrenilmiş ürün sayıma seçildi.');
}

window.showProduct = function showProductWithLookupSource(product, manual) {
  originalShowProduct(product, manual);

  const sourceLabels = {
    'a101-live': 'A101 raf kataloğundan canlı bulundu',
    openfoodfacts: 'Genel barkod veritabanında bulundu',
    manual: 'Elle eklendi'
  };

  if (!manual) {
    const details = [product.brand, sourceLabels[product.source], formatProductPrice(product.price)].filter(Boolean);
    els.productBrand.textContent = details.join(' • ') || 'Marka bilgisi yok';
  }

  let link = document.getElementById('a101ProductLink');
  if (!link) {
    link = document.createElement('a');
    link.id = 'a101ProductLink';
    link.className = 'secondary-button a101-product-link';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    els.productCard.querySelector('.product-summary').insertAdjacentElement('afterend', link);
  }
  link.href = product.a101Url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name || product.barcode)}`;
  link.textContent = product.source === 'a101-live' ? 'A101 ürün sayfasını aç' : 'A101’de ara';
  link.classList.toggle('hidden', manual && !product.name);
};

function updateCatalogBadge() {
  const badge = document.getElementById('catalogBadge');
  const total = catalogState.products.length;
  badge.textContent = total ? `${total.toLocaleString('tr-TR')} öğrenilmiş ürün` : 'Barkodla öğrenen katalog';
  badge.classList.toggle('badge-online', total > 0);
  badge.classList.toggle('badge-local', total === 0);
}

function setCatalogStatus(text) {
  const status = document.getElementById('catalogStatus');
  if (status) status.textContent = text;
}

function normalizeBarcodeKey(value) {
  return String(value || '').replace(/\D/g, '');
}

function barcodesEqual(left, right) {
  const a = normalizeBarcodeKey(left).replace(/^0+/, '');
  const b = normalizeBarcodeKey(right).replace(/^0+/, '');
  return Boolean(a && b && a === b);
}

function normalizeSearch(value) {
  return cleanText(value)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/g, ' ')
    .trim();
}

function formatProductPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `${number.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
}

function friendlyCatalogError(error) {
  return cleanText(error?.message || error?.toString() || 'Bilinmeyen hata').slice(0, 160);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
