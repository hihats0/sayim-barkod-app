const A101_SEARCH_BASE = 'https://www.a101.com.tr/arama?k=';
const A101_CATALOG_URL = './data/a101-products.json';
const CATALOG_PAGE_SIZE = 60;

const catalogState = {
  products: [],
  metadata: null,
  visible: CATALOG_PAGE_SIZE,
  loaded: false,
  loading: false,
  barcodeIndex: new Map()
};

const originalShowProduct = window.showProduct;

document.addEventListener('DOMContentLoaded', () => {
  bindCatalogUi();
  loadA101Catalog();
});

function bindCatalogUi() {
  const catalogView = document.getElementById('catalogView');
  const catalogSearchInput = document.getElementById('catalogSearchInput');
  const reloadCatalogButton = document.getElementById('reloadCatalogButton');
  const loadMoreCatalogButton = document.getElementById('loadMoreCatalogButton');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const isCatalog = tab.dataset.tab === 'catalog';
      catalogView.classList.toggle('active', isCatalog);
      if (isCatalog) {
        document.getElementById('scanView').classList.remove('active');
        document.getElementById('listView').classList.remove('active');
        if (typeof stopScanner === 'function') stopScanner();
        renderCatalog();
      }
    });
  });

  catalogSearchInput.addEventListener('input', () => {
    catalogState.visible = CATALOG_PAGE_SIZE;
    renderCatalog();
  });

  reloadCatalogButton.addEventListener('click', () => loadA101Catalog(true));
  loadMoreCatalogButton.addEventListener('click', () => {
    catalogState.visible += CATALOG_PAGE_SIZE;
    renderCatalog();
  });
}

async function loadA101Catalog(force = false) {
  if (catalogState.loading) return;
  if (catalogState.loaded && !force) return;

  catalogState.loading = true;
  setCatalogStatus('A101 kataloğu yükleniyor…');

  try {
    const suffix = force ? `?t=${Date.now()}` : '';
    const response = await fetch(`${A101_CATALOG_URL}${suffix}`, {
      cache: force ? 'no-store' : 'default',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Katalog HTTP ${response.status}`);

    const payload = await response.json();
    const products = Array.isArray(payload) ? payload : (payload.products || []);

    catalogState.products = products
      .map(normalizeCatalogProduct)
      .filter((product) => product.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));

    catalogState.metadata = Array.isArray(payload) ? null : (payload.metadata || null);
    catalogState.loaded = true;
    catalogState.visible = CATALOG_PAGE_SIZE;
    buildBarcodeIndex();
    updateCatalogBadge();
    renderCatalog();
  } catch (error) {
    catalogState.loaded = true;
    catalogState.products = [];
    catalogState.metadata = { status: 'error', message: friendlyCatalogError(error) };
    updateCatalogBadge();
    renderCatalog();
  } finally {
    catalogState.loading = false;
  }
}

function normalizeCatalogProduct(raw) {
  const barcode = String(raw.barcode || raw.gtin13 || raw.gtin || raw.ean || '')
    .replace(/\D/g, '');
  return {
    id: String(raw.id || raw.sku || barcode || raw.url || ''),
    sku: String(raw.sku || raw.id || ''),
    barcode,
    name: cleanText(raw.name || raw.title || raw.product_name || ''),
    brand: cleanText(raw.brand || raw.brands || ''),
    category: cleanText(raw.category || raw.category_name || ''),
    imageUrl: raw.imageUrl || raw.image || raw.image_url || '',
    url: raw.url || raw.link || '',
    price: raw.price ?? raw.current_price ?? null,
    currency: raw.currency || 'TL',
    available: raw.available !== false,
    source: 'a101'
  };
}

function buildBarcodeIndex() {
  catalogState.barcodeIndex.clear();
  catalogState.products.forEach((product) => {
    if (!product.barcode) return;
    const exact = normalizeBarcodeKey(product.barcode);
    const noZeros = exact.replace(/^0+/, '');
    catalogState.barcodeIndex.set(exact, product);
    if (noZeros) catalogState.barcodeIndex.set(noZeros, product);
  });
}

function normalizeBarcodeKey(value) {
  return String(value || '').replace(/\D/g, '');
}

function findA101ProductByBarcode(barcode) {
  const exact = normalizeBarcodeKey(barcode);
  return catalogState.barcodeIndex.get(exact)
    || catalogState.barcodeIndex.get(exact.replace(/^0+/, ''))
    || null;
}

window.fetchProductFromInternet = async function fetchProductFromInternet(barcode) {
  if (!catalogState.loaded) await loadA101Catalog();

  const a101Product = findA101ProductByBarcode(barcode);
  if (a101Product) return mapCatalogProductToCounter(a101Product);

  const openFoodProduct = await fetchOpenFoodFactsV2(barcode);
  if (openFoodProduct) {
    return {
      ...openFoodProduct,
      a101Url: `${A101_SEARCH_BASE}${encodeURIComponent(openFoodProduct.name)}`
    };
  }

  return null;
};

function mapCatalogProductToCounter(product) {
  return {
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    source: 'a101',
    a101Url: product.url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name)}`,
    category: product.category,
    price: product.price
  };
}

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

  try {
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
  } catch (_) {
    return null;
  }
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

window.showProduct = function showProductWithSource(product, manual) {
  originalShowProduct(product, manual);

  const sourceLabels = {
    a101: 'A101 kataloğunda bulundu',
    openfoodfacts: 'Genel barkod veritabanında bulundu',
    manual: 'Elle eklendi'
  };

  if (!manual) {
    const details = [product.brand, sourceLabels[product.source], formatProductPrice(product.price)]
      .filter(Boolean);
    els.productBrand.textContent = details.join(' • ') || 'Marka bilgisi yok';
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

  const searchTarget = product.name || product.barcode;
  a101Link.href = product.a101Url || `${A101_SEARCH_BASE}${encodeURIComponent(searchTarget)}`;
  a101Link.textContent = product.source === 'a101' ? 'A101 ürün sayfasını aç' : 'A101’de ara';
  a101Link.classList.toggle('hidden', manual && !product.name);
};

function renderCatalog() {
  const list = document.getElementById('catalogList');
  const empty = document.getElementById('catalogEmptyState');
  const moreButton = document.getElementById('loadMoreCatalogButton');
  const query = normalizeSearch(document.getElementById('catalogSearchInput').value);

  if (catalogState.loading) {
    list.innerHTML = '';
    empty.textContent = 'Katalog yükleniyor…';
    empty.classList.remove('hidden');
    moreButton.classList.add('hidden');
    return;
  }

  if (!catalogState.products.length) {
    list.innerHTML = '';
    empty.innerHTML = `<div class="catalog-sync-note">${escapeHtml(catalogState.metadata?.message || 'A101 katalog senkronu henüz ürün üretmedi. GitHub Actions içindeki “Sync A101 Catalog” çalışması tamamlandığında ürünler burada görünür.')}</div>`;
    empty.classList.remove('hidden');
    moreButton.classList.add('hidden');
    setCatalogStatus(catalogState.metadata?.message || 'Katalogda henüz ürün yok.');
    return;
  }

  const filtered = catalogState.products.filter((product) => {
    if (!query) return true;
    const haystack = normalizeSearch([
      product.name,
      product.brand,
      product.category,
      product.barcode,
      product.sku
    ].join(' '));
    return haystack.includes(query);
  });

  const shown = filtered.slice(0, catalogState.visible);
  list.innerHTML = shown.map(renderCatalogProduct).join('');
  empty.classList.toggle('hidden', shown.length > 0);
  if (!shown.length) empty.textContent = 'Aramana uygun A101 ürünü bulunamadı.';

  moreButton.classList.toggle('hidden', filtered.length <= catalogState.visible);
  moreButton.textContent = `Daha fazla göster (${Math.min(catalogState.visible, filtered.length)}/${filtered.length})`;

  list.querySelectorAll('[data-select-product]').forEach((button) => {
    button.addEventListener('click', () => selectCatalogProduct(button.dataset.selectProduct));
  });

  setCatalogStatus(buildCatalogStatusText(filtered.length));
}

function renderCatalogProduct(product) {
  const key = escapeHtml(product.id || product.barcode || product.url);
  const image = product.imageUrl
    ? `<img class="catalog-product-image" src="${escapeAttribute(product.imageUrl)}" alt="" loading="lazy" />`
    : '<div class="catalog-product-placeholder">A101</div>';
  const barcode = product.barcode ? `Barkod: ${escapeHtml(product.barcode)}` : `A101 kodu: ${escapeHtml(product.sku || 'yok')}`;
  const price = formatProductPrice(product.price);
  const meta = [product.brand, product.category, price, barcode].filter(Boolean).map(escapeHtml).join(' • ');
  const selectButton = product.barcode
    ? `<button class="catalog-select" type="button" data-select-product="${key}">Sayıma seç</button>`
    : '<button class="catalog-select" type="button" disabled title="Bu üründe barkod bilgisi bulunamadı">Barkod yok</button>';
  const openLink = product.url
    ? `<a class="catalog-open" href="${escapeAttribute(product.url)}" target="_blank" rel="noopener noreferrer">A101’de aç</a>`
    : '';

  return `
    <article class="catalog-product">
      ${image}
      <div class="catalog-product-copy">
        <h3>${escapeHtml(product.name)}</h3>
        <p class="count-meta">${meta}</p>
      </div>
      <div class="catalog-product-actions">
        ${selectButton}
        ${openLink}
      </div>
    </article>
  `;
}

function selectCatalogProduct(id) {
  const product = catalogState.products.find((item) => (item.id || item.barcode || item.url) === id);
  if (!product || !product.barcode) {
    showToast('Bu A101 kaydında barkod bulunmuyor.', true);
    return;
  }

  const mapped = mapCatalogProductToCounter(product);
  state.currentProduct = mapped;
  document.getElementById('barcodeInput').value = mapped.barcode;
  switchTab('scan');
  document.getElementById('catalogView').classList.remove('active');
  showProduct(mapped, false);
  showToast('A101 ürünü sayıma seçildi.');
}

function updateCatalogBadge() {
  const badge = document.getElementById('catalogBadge');
  const total = catalogState.products.length;
  badge.textContent = total ? `${total.toLocaleString('tr-TR')} A101 ürünü` : 'A101 kataloğu bekleniyor';
  badge.classList.toggle('badge-online', total > 0);
  badge.classList.toggle('badge-local', total === 0);
}

function setCatalogStatus(text) {
  const status = document.getElementById('catalogStatus');
  if (status) status.textContent = text;
}

function buildCatalogStatusText(filteredCount) {
  const total = catalogState.products.length;
  const barcodeCount = catalogState.products.filter((product) => product.barcode).length;
  const generatedAt = catalogState.metadata?.generatedAt
    ? new Date(catalogState.metadata.generatedAt).toLocaleString('tr-TR')
    : null;
  return [
    `${total.toLocaleString('tr-TR')} ürün`,
    `${barcodeCount.toLocaleString('tr-TR')} barkodlu`,
    filteredCount !== total ? `${filteredCount.toLocaleString('tr-TR')} eşleşme` : '',
    generatedAt ? `son senkron ${generatedAt}` : ''
  ].filter(Boolean).join(' • ');
}

function normalizeSearch(value) {
  return cleanText(value)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatProductPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `${number.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function friendlyCatalogError(error) {
  if (error?.name === 'AbortError') return 'Katalog isteği zaman aşımına uğradı.';
  return cleanText(error?.message) || 'Katalog alınamadı.';
}
