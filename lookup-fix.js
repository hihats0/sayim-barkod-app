const A101_SEARCH_BASE = 'https://www.a101.com.tr/arama?k=';
const PARSE_A101_API_BASE = 'https://api.parse.bot/scraper/01e0d684-e029-4758-9eb5-c6214e407387';
const RAF_API_SETTINGS_KEY = 'sayim-barkod-raf-api-settings-v1';
const LOCAL_LOOKUP_QUEUE_KEY = 'sayim-barkod-lookup-queue-v3';
const LEARNED_PAGE_SIZE = 60;

const catalogState = {
  products: [],
  visible: LEARNED_PAGE_SIZE,
  loading: false,
  queueRunning: false
};

const originalShowProduct = window.showProduct;

document.addEventListener('DOMContentLoaded', () => {
  injectRafApiSettings();
  bindLearnedCatalogUi();
  bindManualA101Search();
  bindManualEnrichment();
  loadLearnedProducts();

  setTimeout(() => {
    loadLearnedProducts();
    processLookupQueue();
  }, 1200);

  window.setInterval(() => processLookupQueue(), 75_000);
});

window.addEventListener('online', () => processLookupQueue());

function injectRafApiSettings() {
  const warning = document.querySelector('#settingsForm .warning');
  if (!warning || document.getElementById('parseApiKeyInput')) return;

  const settings = loadRafApiSettings();
  const wrapper = document.createElement('div');
  wrapper.className = 'raf-api-settings';
  wrapper.innerHTML = `
    <label for="parseApiKeyInput">A101 raf ürünleri API anahtarı</label>
    <input id="parseApiKeyInput" type="password" autocomplete="off" placeholder="Parse API key" value="${escapeAttribute(settings.parseApiKey)}" />
    <p class="muted">Bilinmeyen barkodun ürün adı girildiğinde A101 Kapıda raf kataloğunu arar. Ücretsiz planda ayda 100 yeni ürün sorgusu vardır.</p>
    <a class="secondary-button a101-product-link" href="https://parse.bot/marketplace/66397d30-5b86-4b47-a4d4-ddf2a0ac79ef/a101-com-tr-api" target="_blank" rel="noopener noreferrer">Ücretsiz API anahtarı al</a>
    <label for="a101StoreIdInput">A101 mağaza kodu (isteğe bağlı)</label>
    <input id="a101StoreIdInput" autocomplete="off" placeholder="Örn. VS032" value="${escapeAttribute(settings.storeId)}" />
  `;
  warning.insertAdjacentElement('beforebegin', wrapper);

  document.getElementById('saveSettingsButton')?.addEventListener('click', () => {
    saveRafApiSettings({
      parseApiKey: cleanText(document.getElementById('parseApiKeyInput')?.value),
      storeId: cleanText(document.getElementById('a101StoreIdInput')?.value)
    });
    setTimeout(() => processLookupQueue(), 400);
  }, true);
}

function loadRafApiSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RAF_API_SETTINGS_KEY));
    return {
      parseApiKey: cleanText(parsed?.parseApiKey),
      storeId: cleanText(parsed?.storeId)
    };
  } catch (_) {
    return { parseApiKey: '', storeId: '' };
  }
}

function saveRafApiSettings(settings) {
  localStorage.setItem(RAF_API_SETTINGS_KEY, JSON.stringify({
    parseApiKey: cleanText(settings.parseApiKey),
    storeId: cleanText(settings.storeId)
  }));
}

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
    reloadButton.textContent = 'Eksik aranıyor…';
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

function bindManualA101Search() {
  const manualFields = document.getElementById('manualProductFields');
  if (!manualFields || document.getElementById('manualA101SearchButton')) return;

  const button = document.createElement('button');
  button.id = 'manualA101SearchButton';
  button.type = 'button';
  button.className = 'secondary-button full-width';
  button.textContent = 'Yazdığım adla A101 rafında bul';
  button.addEventListener('click', searchManualProductOnA101);
  manualFields.appendChild(button);
}

async function searchManualProductOnA101() {
  const button = document.getElementById('manualA101SearchButton');
  const barcode = normalizeBarcodeKey(state.currentProduct?.barcode || document.getElementById('barcodeInput')?.value);
  const name = cleanText(document.getElementById('manualProductName')?.value);
  const brand = cleanText(document.getElementById('manualProductBrand')?.value);

  if (!barcode || !name) {
    showToast('Önce barkodu ve ürün adını yaz.', true);
    return;
  }

  const settings = loadRafApiSettings();
  if (!settings.parseApiKey) {
    await queueProductLookup({ barcode, name, brand });
    showToast('Ayarlar bölümünden ücretsiz A101 raf API anahtarını ekle.', true);
    return;
  }

  button.disabled = true;
  button.textContent = 'A101 rafında aranıyor…';
  try {
    const match = await searchA101Kapida(name, brand);
    if (!match) {
      await queueProductLookup({ barcode, name, brand });
      showToast('A101 rafında güvenilir eşleşme bulunamadı; tekrar arama kuyruğuna alındı.', true);
      return;
    }

    const product = mapKapidaProductToCounter(match, barcode);
    state.currentProduct = product;
    await persistProduct(product);
    await completeQueuedLookup(barcode);
    showProduct(product, false);
    await loadLearnedProducts();
    showToast('A101 raf ürünü bulundu ve barkoda bağlandı.');
  } catch (error) {
    await queueProductLookup({ barcode, name, brand });
    showToast(`A101 raf araması başarısız: ${friendlyCatalogError(error)}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Yazdığım adla A101 rafında bul';
  }
}

function bindManualEnrichment() {
  const saveButton = document.getElementById('saveCountButton');
  saveButton.addEventListener('click', () => {
    const manualFields = document.getElementById('manualProductFields');
    if (manualFields.classList.contains('hidden')) return;

    const barcode = normalizeBarcodeKey(state.currentProduct?.barcode || document.getElementById('barcodeInput')?.value);
    const name = cleanText(document.getElementById('manualProductName')?.value);
    const brand = cleanText(document.getElementById('manualProductBrand')?.value);
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

  const universalProduct = await fetchUniversalProduct(normalizedBarcode);
  if (!universalProduct) {
    await queueProductLookup({ barcode: normalizedBarcode });
    return null;
  }

  const settings = loadRafApiSettings();
  if (settings.parseApiKey) {
    try {
      const a101Match = await searchA101Kapida(universalProduct.name, universalProduct.brand);
      if (a101Match) {
        await completeQueuedLookup(normalizedBarcode);
        return mapKapidaProductToCounter(a101Match, normalizedBarcode);
      }
    } catch (_) {
      // General product data is still useful; A101 matching can be retried from the queue.
    }
  }

  await queueProductLookup({
    barcode: normalizedBarcode,
    name: universalProduct.name,
    brand: universalProduct.brand
  });

  return {
    ...universalProduct,
    a101Url: `${A101_SEARCH_BASE}${encodeURIComponent(universalProduct.name)}`
  };
};

async function searchA101Kapida(query, brandHint = '') {
  const settings = loadRafApiSettings();
  if (!settings.parseApiKey) throw new Error('A101 raf API anahtarı eksik');

  const url = new URL(`${PARSE_A101_API_BASE}/search_kapida_products`);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', '60');
  url.searchParams.set('query', cleanText(query));
  if (settings.storeId) url.searchParams.set('store_id', settings.storeId);

  const response = await fetchWithTimeout(url.toString(), 25_000, {
    headers: {
      Accept: 'application/json',
      'X-API-Key': settings.parseApiKey
    },
    cache: 'no-store'
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('API anahtarı geçersiz veya yetkisiz');
  }
  if (response.status === 429) throw new Error('Ücretsiz API sorgu limiti doldu');
  if (!response.ok) throw new Error(`Raf API HTTP ${response.status}`);

  const payload = await response.json();
  const products = extractKapidaProducts(payload).map(normalizeKapidaProduct).filter((item) => item.name);
  return chooseBestKapidaMatch(products, query, brandHint);
}

function extractKapidaProducts(payload) {
  const data = payload?.data ?? payload;
  const candidates = [
    data?.products,
    payload?.products,
    data?.page_content,
    data?.pageContent,
    data?.res?.[0]?.page_content,
    data?.res?.[0]?.pageContent,
    payload?.res?.[0]?.page_content,
    payload?.res?.[0]?.pageContent
  ];

  const direct = candidates.find(Array.isArray);
  if (direct) return direct;

  const collected = [];
  walkJson(data, (object) => {
    const name = object?.title || object?.name || object?.product_name;
    const id = object?.id || object?.sku || object?.productId;
    if (name && id && (object?.price != null || object?.image || object?.images || object?.link)) {
      collected.push(object);
    }
  });
  return collected;
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

function normalizeKapidaProduct(raw) {
  const images = raw.image || raw.images || raw.imageUrl || raw.image_url;
  let imageUrl = '';
  if (typeof images === 'string') imageUrl = images;
  else if (Array.isArray(images)) {
    const preferred = images.find((item) => item?.imageType === 'product') || images[0];
    imageUrl = typeof preferred === 'string' ? preferred : (preferred?.url || preferred?.src || '');
  } else if (images && typeof images === 'object') {
    imageUrl = images.url || images.src || '';
  }

  return {
    sku: normalizeBarcodeKey(raw.id || raw.sku || raw.productId),
    name: cleanText(raw.title || raw.name || raw.product_name),
    brand: cleanText(raw.brand || raw.brands || ''),
    category: cleanText(raw.category || raw.category_name || ''),
    imageUrl,
    url: cleanText(raw.link || raw.url || raw.seoUrl || ''),
    price: parseProductPrice(raw.price ?? raw.current_price ?? raw.discounted_price),
    available: raw.available !== false && raw.inStock !== false
  };
}

function chooseBestKapidaMatch(products, query, brandHint) {
  if (!products.length) return null;
  const queryTokens = productTokens(query);
  const brandTokens = productTokens(brandHint);
  const queryQuantities = extractQuantities(query);

  const ranked = products.map((product) => {
    const titleTokens = productTokens(product.name);
    const titleSet = new Set(titleTokens);
    const tokenMatches = queryTokens.filter((token) => titleSet.has(token)).length;
    const coverage = queryTokens.length ? tokenMatches / queryTokens.length : 0;
    const precision = titleTokens.length ? tokenMatches / titleTokens.length : 0;
    const brandMatch = brandTokens.length && brandTokens.some((token) => titleSet.has(token)) ? 0.18 : 0;
    const titleQuantities = extractQuantities(product.name);
    const quantityMatch = queryQuantities.length
      ? (queryQuantities.some((quantity) => titleQuantities.includes(quantity)) ? 0.32 : -0.22)
      : 0;
    const availability = product.available ? 0.03 : -0.08;
    return { product, score: coverage * 0.62 + precision * 0.18 + brandMatch + quantityMatch + availability };
  }).sort((left, right) => right.score - left.score);

  return ranked[0]?.score >= 0.48 ? ranked[0].product : null;
}

function productTokens(value) {
  const ignored = new Set([
    've', 'ile', 'icin', 'için', 'adet', 'paket', 'urun', 'ürün', 'sivi', 'sıvı',
    'deterjani', 'deterjanı', 'aromali', 'aromalı', 'cesitleri', 'çeşitleri'
  ]);
  return normalizeSearch(value).split(/\s+/).filter((token) => token.length > 1 && !ignored.has(token));
}

function extractQuantities(value) {
  const normalized = normalizeSearch(value).replace(/\s+/g, ' ');
  const matches = normalized.match(/\b\d+(?:[.,]\d+)?\s*(?:ml|l|lt|litre|g|gr|kg|li|lu)\b/g) || [];
  return matches.map((item) => item.replace(/\s+/g, '').replace('litre', 'l').replace('lt', 'l').replace('gr', 'g'));
}

function mapKapidaProductToCounter(product, scannedBarcode) {
  return {
    barcode: normalizeBarcodeKey(scannedBarcode),
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    source: 'a101-kapida',
    a101Url: product.url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name)}`,
    category: product.category,
    price: product.price,
    a101Sku: product.sku
  };
}

async function fetchUniversalProduct(barcode) {
  const fields = [
    'code', 'status', 'product_name', 'product_name_tr', 'brands',
    'image_front_small_url', 'image_front_url', 'quantity'
  ].join(',');

  const urls = [
    `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}?product_type=all&fields=${encodeURIComponent(fields)}`,
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${encodeURIComponent(fields)}`
  ];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, 9000, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const raw = payload.product || payload;
      const baseName = cleanText(raw.product_name_tr || raw.product_name || raw.name);
      if (!baseName) continue;
      const quantity = cleanText(raw.quantity);
      const name = quantity && !normalizeSearch(baseName).includes(normalizeSearch(quantity))
        ? `${baseName} ${quantity}`
        : baseName;
      return {
        barcode,
        name,
        brand: cleanText(raw.brands || raw.brand),
        imageUrl: raw.image_front_small_url || raw.image_front_url || raw.image_url || '',
        source: 'openfacts'
      };
    } catch (_) {
      // Try the next open product database endpoint.
    }
  }

  return null;
}

function parseProductPrice(value) {
  if (value && typeof value === 'object') {
    value = value.discounted ?? value.normal ?? value.price ?? value.value;
    if (Number.isInteger(value) && value >= 1000) return value / 100;
  }
  if (value == null || value === '') return null;
  const textValue = String(value).replace(/₺|TL/gi, '').trim();
  const normalized = textValue.includes(',')
    ? textValue.replace(/\./g, '').replace(',', '.')
    : textValue;
  const number = Number.parseFloat(normalized.replace(/[^\d.]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
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
      // Fall back to local queue if the optional queue table is not installed.
    }
  }

  const localQueue = loadLocalQueue();
  const current = localQueue.find((entry) => entry.barcode === barcode);
  if (current) {
    current.name_hint = queued.name_hint || current.name_hint;
    current.brand_hint = queued.brand_hint || current.brand_hint;
    current.status = 'pending';
    current.next_attempt_at = new Date().toISOString();
    current.updated_at = new Date().toISOString();
  } else {
    localQueue.push(queued);
  }
  saveLocalQueue(localQueue);
}

async function processLookupQueue(force = false) {
  if (catalogState.queueRunning || !navigator.onLine) return;
  const settings = loadRafApiSettings();
  if (!settings.parseApiKey) {
    renderLearnedCatalog();
    return;
  }

  catalogState.queueRunning = true;
  try {
    const items = await getQueuedLookups(force);
    const item = items.find((candidate) => cleanText(candidate.name_hint));
    if (!item) return;

    try {
      const match = await searchA101Kapida(item.name_hint, item.brand_hint);
      if (match) {
        const product = mapKapidaProductToCounter(match, item.barcode);
        await persistProduct(product);
        await completeQueuedLookup(item.barcode);
      } else {
        await postponeQueuedLookup(item, 'Eşleşme bulunamadı');
      }
    } catch (error) {
      await postponeQueuedLookup(item, friendlyCatalogError(error));
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
  return loadLocalQueue().filter((item) => item.status === 'pending' && (force || !item.next_attempt_at || item.next_attempt_at <= now));
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

async function postponeQueuedLookup(item, lastError) {
  const attempts = (Number(item.attempts) || 0) + 1;
  const failed = attempts >= 3;
  const delayHours = Math.min(48, 2 ** attempts);
  const nextAttempt = new Date(Date.now() + delayHours * 3_600_000).toISOString();
  const update = {
    attempts,
    status: failed ? 'failed' : 'pending',
    next_attempt_at: nextAttempt,
    updated_at: new Date().toISOString()
  };

  if (state.supabase) {
    try {
      const { error } = await state.supabase.from('product_lookup_queue').update(update).eq('barcode', item.barcode);
      if (!error) return;
    } catch (_) {
      // Update local queue below.
    }
  }

  const queue = loadLocalQueue();
  const current = queue.find((entry) => entry.barcode === item.barcode);
  if (current) {
    Object.assign(current, update, { last_error: lastError });
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
    + (product.source === 'a101-kapida' ? 3 : 0);
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
      : 'Henüz ürün öğrenilmedi. Bir raf ürününün barkodunu okut; ilk sefer ürün adını yazıp A101 rafında bul.';
  }

  moreButton.classList.toggle('hidden', filtered.length <= catalogState.visible);
  moreButton.textContent = `Daha fazla göster (${Math.min(catalogState.visible, filtered.length)}/${filtered.length})`;
  list.querySelectorAll('[data-select-product]').forEach((button) => {
    button.addEventListener('click', () => selectLearnedProduct(button.dataset.selectProduct));
  });

  const localQueue = loadLocalQueue();
  const pending = localQueue.filter((item) => item.status === 'pending').length;
  const apiReady = Boolean(loadRafApiSettings().parseApiKey);
  const parts = [`${catalogState.products.length.toLocaleString('tr-TR')} ürün öğrenildi`];
  if (pending) parts.push(`${pending} barkod sırada`);
  if (!apiReady) parts.push('A101 raf API anahtarı eklenmedi');
  setCatalogStatus(`${parts.join(' • ')}.`);
}

function renderLearnedProduct(product) {
  const key = escapeHtml(product.barcode);
  const image = product.imageUrl
    ? `<img class="catalog-product-image" src="${escapeAttribute(product.imageUrl)}" alt="" loading="lazy" />`
    : '<div class="catalog-product-placeholder">A101</div>';
  const source = product.source === 'a101-kapida'
    ? 'A101 Kapıda rafından bulundu'
    : product.source === 'openfacts'
      ? 'Açık barkod verisi'
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
    'a101-kapida': 'A101 Kapıda raf kataloğunda bulundu',
    openfacts: 'Açık barkod veritabanında bulundu',
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
  link.textContent = product.source === 'a101-kapida' ? 'A101 raf ürününü aç' : 'A101’de ara';
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

function normalizeSearch(value) {
  return cleanText(value)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü.,]+/g, ' ')
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
