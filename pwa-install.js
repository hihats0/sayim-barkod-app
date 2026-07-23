let deferredInstallPrompt = null;

// A101 sayfalarında görünen ürün kodu (SKU) ile gerçek EAN/GTIN barkodu birlikte desteklenir.
// Bu dosya lookup-fix.js sonrasında yüklendiği için katalog davranışını güvenli biçimde genişletir.
window.buildBarcodeIndex = function buildBarcodeAndSkuIndex() {
  catalogState.barcodeIndex.clear();

  catalogState.products.forEach((product) => {
    [product.barcode, product.sku].forEach((value) => {
      const exact = normalizeBarcodeKey(value);
      if (!exact) return;
      const noZeros = exact.replace(/^0+/, '');
      catalogState.barcodeIndex.set(exact, product);
      if (noZeros) catalogState.barcodeIndex.set(noZeros, product);
    });
  });
};

window.mapCatalogProductToCounter = function mapCatalogProductWithA101Code(product) {
  const countCode = normalizeBarcodeKey(product.barcode || product.sku);
  return {
    barcode: countCode,
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    source: 'a101',
    a101Url: product.url || `${A101_SEARCH_BASE}${encodeURIComponent(product.name)}`,
    category: product.category,
    price: product.price,
    a101Sku: product.sku,
    gtin: product.barcode
  };
};

window.renderCatalogProduct = function renderCatalogProductWithSku(product) {
  const key = escapeHtml(product.id || product.barcode || product.sku || product.url);
  const image = product.imageUrl
    ? `<img class="catalog-product-image" src="${escapeAttribute(product.imageUrl)}" alt="" loading="lazy" />`
    : '<div class="catalog-product-placeholder">A101</div>';

  const codeParts = [];
  if (product.barcode) codeParts.push(`Barkod: ${product.barcode}`);
  if (product.sku) codeParts.push(`A101 kodu: ${product.sku}`);
  const price = formatProductPrice(product.price);
  const meta = [product.brand, product.category, price, ...codeParts]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' • ');

  const selectableCode = normalizeBarcodeKey(product.barcode || product.sku);
  const selectButton = selectableCode
    ? `<button class="catalog-select" type="button" data-select-product="${key}">Sayıma seç</button>`
    : '<button class="catalog-select" type="button" disabled>Ürün kodu yok</button>';
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
};

window.selectCatalogProduct = function selectCatalogProductWithSku(id) {
  const product = catalogState.products.find((item) => (item.id || item.barcode || item.sku || item.url) === id);
  const countCode = normalizeBarcodeKey(product?.barcode || product?.sku);
  if (!product || !countCode) {
    showToast('Bu A101 kaydında kullanılabilir ürün kodu bulunmuyor.', true);
    return;
  }

  const mapped = mapCatalogProductToCounter(product);
  state.currentProduct = mapped;
  document.getElementById('barcodeInput').value = mapped.barcode;
  switchTab('scan');
  document.getElementById('catalogView').classList.remove('active');
  showProduct(mapped, false);
  showToast(product.barcode ? 'Barkodlu A101 ürünü seçildi.' : 'A101 ürün kodu sayıma seçildi.');
};

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('installButton');
  if (!button) return;

  if (isStandaloneMode()) {
    button.classList.add('hidden');
    return;
  }

  button.classList.remove('hidden');
  button.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      button.classList.add('hidden');
      return;
    }

    showInstallInstructions();
  });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.getElementById('installButton')?.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.getElementById('installButton')?.classList.add('hidden');
  if (typeof showToast === 'function') showToast('Uygulama telefona yüklendi.');
});

function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function showInstallInstructions() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const text = isIos
    ? 'Safari paylaş menüsünü açıp “Ana Ekrana Ekle” seçeneğine bas. Uygulama adres çubuğu olmadan açılır.'
    : 'Chrome menüsünü açıp “Uygulamayı yükle” veya “Ana ekrana ekle” seçeneğine bas. Kurulduktan sonra adres çubuğu görünmez.';

  if (typeof showToast === 'function') showToast(text);
  else alert(text);
}
