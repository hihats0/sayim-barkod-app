const STORAGE_KEYS = {
  settings: 'sayim-barkod-settings-v1',
  entries: 'sayim-barkod-local-entries-v1',
  products: 'sayim-barkod-local-products-v1'
};

const DEFAULT_SETTINGS = {
  staffName: '',
  sessionName: 'Genel Sayım',
  supabaseUrl: '',
  supabaseKey: ''
};

const state = {
  settings: loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
  entries: loadJson(STORAGE_KEYS.entries, []),
  products: loadJson(STORAGE_KEYS.products, {}),
  currentProduct: null,
  supabase: null,
  scanner: null,
  scannerRunning: false,
  realtimeChannel: null
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  cacheElements();
  bindEvents();
  fillSettingsForm();
  updateHeaderStatus();
  registerServiceWorker();
  connectDatabase();
  renderCounts();
}

function cacheElements() {
  [
    'settingsButton', 'databaseBadge', 'sessionBadge', 'scanView', 'listView',
    'toggleScannerButton', 'reader', 'cameraHelp', 'barcodeForm', 'barcodeInput',
    'productCard', 'productImage', 'productBarcode', 'productName', 'productBrand',
    'manualProductFields', 'manualProductName', 'manualProductBrand', 'quantityInput',
    'decreaseButton', 'increaseButton', 'saveCountButton', 'summarySession',
    'uniqueProductCount', 'totalQuantity', 'listSearchInput', 'refreshButton',
    'countList', 'emptyState', 'toast', 'settingsDialog', 'staffNameInput',
    'sessionNameInput', 'supabaseUrlInput', 'supabaseKeyInput', 'useLocalButton',
    'saveSettingsButton'
  ].forEach((id) => { els[id] = document.getElementById(id); });
  els.tabs = [...document.querySelectorAll('.tab')];
}

function bindEvents() {
  els.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  els.settingsButton.addEventListener('click', () => els.settingsDialog.showModal());
  els.toggleScannerButton.addEventListener('click', toggleScanner);
  els.barcodeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    lookupBarcode(els.barcodeInput.value);
  });
  els.decreaseButton.addEventListener('click', () => changeQuantity(-1));
  els.increaseButton.addEventListener('click', () => changeQuantity(1));
  els.saveCountButton.addEventListener('click', saveCount);
  els.refreshButton.addEventListener('click', loadEntries);
  els.listSearchInput.addEventListener('input', renderCounts);
  els.saveSettingsButton.addEventListener('click', saveSettings);
  els.useLocalButton.addEventListener('click', useLocalMode);
  window.addEventListener('beforeunload', stopScanner);
}

function switchTab(name) {
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  els.scanView.classList.toggle('active', name === 'scan');
  els.listView.classList.toggle('active', name === 'list');
  if (name === 'list') loadEntries();
  if (name !== 'scan') stopScanner();
}

async function toggleScanner() {
  if (state.scannerRunning) {
    await stopScanner();
    return;
  }

  if (!window.Html5Qrcode) {
    showToast('Kamera kütüphanesi yüklenemedi. Barkodu elle gir.', true);
    return;
  }

  try {
    els.reader.classList.remove('hidden');
    els.cameraHelp.textContent = 'Kamerayı barkoda yaklaştır.';
    state.scanner = state.scanner || new Html5Qrcode('reader');
    await state.scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 280, height: 150 }, aspectRatio: 1.6 },
      async (decodedText) => {
        await stopScanner();
        els.barcodeInput.value = decodedText;
        lookupBarcode(decodedText);
      },
      () => {}
    );
    state.scannerRunning = true;
    els.toggleScannerButton.textContent = 'Kamerayı kapat';
  } catch (error) {
    els.reader.classList.add('hidden');
    els.cameraHelp.textContent = 'Kamera açılamadı. Tarayıcı kamera iznini kontrol et.';
    showToast('Kamera açılamadı: ' + friendlyError(error), true);
  }
}

async function stopScanner() {
  if (!state.scanner || !state.scannerRunning) return;
  try {
    await state.scanner.stop();
    await state.scanner.clear();
  } catch (_) {
    // Scanner may already be stopped by the browser.
  }
  state.scannerRunning = false;
  state.scanner = null;
  els.reader.classList.add('hidden');
  els.toggleScannerButton.textContent = 'Kamerayı aç';
  els.cameraHelp.textContent = 'Kamerayı aç veya barkod numarasını elle gir.';
}

async function lookupBarcode(rawBarcode) {
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode) {
    showToast('Geçerli bir barkod numarası gir.', true);
    return;
  }

  els.barcodeInput.value = barcode;
  setLookupLoading(true);

  try {
    let product = await findSavedProduct(barcode);
    if (!product) product = await fetchProductFromInternet(barcode);

    if (product) {
      state.currentProduct = product;
      await persistProduct(product);
      showProduct(product, false);
      showToast('Ürün bulundu.');
    } else {
      state.currentProduct = { barcode, name: '', brand: '', imageUrl: '', source: 'manual' };
      showProduct(state.currentProduct, true);
      showToast('Ürün internette bulunamadı. Adını elle gir.', true);
    }
  } catch (error) {
    state.currentProduct = { barcode, name: '', brand: '', imageUrl: '', source: 'manual' };
    showProduct(state.currentProduct, true);
    showToast('İnternet sorgusu başarısız. Ürün adını elle gir.', true);
  } finally {
    setLookupLoading(false);
  }
}

function normalizeBarcode(value) {
  const barcode = String(value || '').replace(/\D/g, '');
  return barcode.length >= 6 && barcode.length <= 18 ? barcode : '';
}

async function findSavedProduct(barcode) {
  if (state.supabase) {
    const { data, error } = await state.supabase
      .from('products')
      .select('barcode,name,brand,image_url,source')
      .eq('barcode', barcode)
      .maybeSingle();
    if (error) throw error;
    return data ? mapDatabaseProduct(data) : null;
  }
  return state.products[barcode] || null;
}

async function fetchProductFromInternet(barcode) {
  const fields = 'code,product_name,product_name_tr,brands,image_front_small_url,image_front_url,quantity';
  const response = await fetch(
    `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json?fields=${fields}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) return null;
  const payload = await response.json();
  const sourceProduct = payload.product;
  if (!sourceProduct) return null;

  const name = cleanText(sourceProduct.product_name_tr || sourceProduct.product_name);
  if (!name) return null;
  const quantity = cleanText(sourceProduct.quantity);

  return {
    barcode,
    name: quantity && !name.toLowerCase().includes(quantity.toLowerCase()) ? `${name} ${quantity}` : name,
    brand: cleanText(sourceProduct.brands),
    imageUrl: sourceProduct.image_front_small_url || sourceProduct.image_front_url || '',
    source: 'openfoodfacts'
  };
}

function showProduct(product, manual) {
  els.productCard.classList.remove('hidden');
  els.productBarcode.textContent = product.barcode;
  els.productName.textContent = product.name || 'Ürün adı gerekli';
  els.productBrand.textContent = product.brand || (manual ? 'İnternet kataloğunda bulunamadı' : 'Marka bilgisi yok');
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

  if (manual) setTimeout(() => els.manualProductName.focus(), 50);
  else setTimeout(() => els.quantityInput.select(), 50);
}

function changeQuantity(delta) {
  const current = Math.max(1, Number.parseInt(els.quantityInput.value, 10) || 1);
  els.quantityInput.value = String(Math.max(1, current + delta));
}

async function saveCount() {
  if (!state.currentProduct) {
    showToast('Önce bir barkod okut.', true);
    return;
  }

  const isManual = !els.manualProductFields.classList.contains('hidden');
  const name = cleanText(isManual ? els.manualProductName.value : state.currentProduct.name);
  const brand = cleanText(isManual ? els.manualProductBrand.value : state.currentProduct.brand);
  const quantity = Number.parseInt(els.quantityInput.value, 10);

  if (!name) {
    showToast('Ürün adını yaz.', true);
    els.manualProductName.focus();
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    showToast('Geçerli bir adet gir.', true);
    return;
  }

  const product = { ...state.currentProduct, name, brand };
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    session_name: state.settings.sessionName,
    barcode: product.barcode,
    product_name: product.name,
    brand: product.brand,
    quantity,
    counted_by: state.settings.staffName || 'İsimsiz',
    created_at: new Date().toISOString()
  };

  setSaveLoading(true);
  try {
    await persistProduct(product);
    if (state.supabase) {
      const { error } = await state.supabase.from('count_entries').insert({
        session_name: entry.session_name,
        barcode: entry.barcode,
        product_name: entry.product_name,
        brand: entry.brand,
        quantity: entry.quantity,
        counted_by: entry.counted_by
      });
      if (error) throw error;
    } else {
      state.entries.unshift(entry);
      saveJson(STORAGE_KEYS.entries, state.entries);
    }

    showToast(`${quantity} adet eklendi.`);
    resetProductForm();
    await loadEntries();
  } catch (error) {
    showToast('Kayıt yapılamadı: ' + friendlyError(error), true);
  } finally {
    setSaveLoading(false);
  }
}

async function persistProduct(product) {
  if (state.supabase) {
    const { error } = await state.supabase.from('products').upsert({
      barcode: product.barcode,
      name: product.name,
      brand: product.brand || '',
      image_url: product.imageUrl || '',
      source: product.source || 'manual',
      updated_at: new Date().toISOString()
    }, { onConflict: 'barcode' });
    if (error) throw error;
  } else {
    state.products[product.barcode] = product;
    saveJson(STORAGE_KEYS.products, state.products);
  }
}

function resetProductForm() {
  state.currentProduct = null;
  els.productCard.classList.add('hidden');
  els.barcodeInput.value = '';
  els.manualProductName.value = '';
  els.manualProductBrand.value = '';
  els.barcodeInput.focus();
}

async function loadEntries() {
  if (state.supabase) {
    const { data, error } = await state.supabase
      .from('count_entries')
      .select('id,session_name,barcode,product_name,brand,quantity,counted_by,created_at')
      .eq('session_name', state.settings.sessionName)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) {
      showToast('Liste alınamadı: ' + friendlyError(error), true);
      return;
    }
    state.entries = data || [];
  }
  renderCounts();
}

function renderCounts() {
  const query = cleanText(els.listSearchInput.value).toLocaleLowerCase('tr-TR');
  const entries = state.entries.filter((entry) => entry.session_name === state.settings.sessionName);
  const grouped = new Map();

  entries.forEach((entry) => {
    const current = grouped.get(entry.barcode) || {
      barcode: entry.barcode,
      productName: entry.product_name,
      brand: entry.brand || '',
      quantity: 0,
      counters: new Set(),
      lastCountedAt: entry.created_at
    };
    current.quantity += Number(entry.quantity) || 0;
    current.counters.add(entry.counted_by || 'İsimsiz');
    if (new Date(entry.created_at) > new Date(current.lastCountedAt)) current.lastCountedAt = entry.created_at;
    grouped.set(entry.barcode, current);
  });

  const rows = [...grouped.values()]
    .filter((row) => !query || `${row.productName} ${row.brand} ${row.barcode}`.toLocaleLowerCase('tr-TR').includes(query))
    .sort((a, b) => a.productName.localeCompare(b.productName, 'tr'));

  els.countList.replaceChildren(...rows.map(createCountRow));
  els.emptyState.classList.toggle('hidden', rows.length > 0);
  els.uniqueProductCount.textContent = String(grouped.size);
  els.totalQuantity.textContent = String([...grouped.values()].reduce((sum, row) => sum + row.quantity, 0));
  els.summarySession.textContent = state.settings.sessionName;
}

function createCountRow(row) {
  const item = document.createElement('article');
  item.className = 'count-item';

  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = row.productName;
  const meta = document.createElement('div');
  meta.className = 'count-meta';
  meta.textContent = `${row.barcode}${row.brand ? ` · ${row.brand}` : ''} · ${[...row.counters].join(', ')}`;
  copy.append(title, meta);

  const total = document.createElement('div');
  total.className = 'count-total';
  const strong = document.createElement('strong');
  strong.textContent = String(row.quantity);
  const label = document.createElement('span');
  label.textContent = 'ADET';
  total.append(strong, label);

  item.append(copy, total);
  return item;
}

function fillSettingsForm() {
  els.staffNameInput.value = state.settings.staffName;
  els.sessionNameInput.value = state.settings.sessionName;
  els.supabaseUrlInput.value = state.settings.supabaseUrl;
  els.supabaseKeyInput.value = state.settings.supabaseKey;
}

async function saveSettings() {
  const next = {
    staffName: cleanText(els.staffNameInput.value),
    sessionName: cleanText(els.sessionNameInput.value) || 'Genel Sayım',
    supabaseUrl: els.supabaseUrlInput.value.trim().replace(/\/$/, ''),
    supabaseKey: els.supabaseKeyInput.value.trim()
  };

  if ((next.supabaseUrl && !next.supabaseKey) || (!next.supabaseUrl && next.supabaseKey)) {
    showToast('Supabase URL ve anahtarını birlikte gir.', true);
    return;
  }

  state.settings = next;
  saveJson(STORAGE_KEYS.settings, state.settings);
  updateHeaderStatus();
  await connectDatabase(true);
}

async function useLocalMode() {
  state.settings = {
    staffName: cleanText(els.staffNameInput.value),
    sessionName: cleanText(els.sessionNameInput.value) || 'Genel Sayım',
    supabaseUrl: '',
    supabaseKey: ''
  };
  saveJson(STORAGE_KEYS.settings, state.settings);
  fillSettingsForm();
  disconnectRealtime();
  state.supabase = null;
  state.entries = loadJson(STORAGE_KEYS.entries, []);
  updateHeaderStatus();
  renderCounts();
  els.settingsDialog.close();
  showToast('Yerel demo moduna geçildi.');
}

async function connectDatabase(showResult = false) {
  disconnectRealtime();
  state.supabase = null;

  if (!state.settings.supabaseUrl || !state.settings.supabaseKey) {
    state.entries = loadJson(STORAGE_KEYS.entries, []);
    updateHeaderStatus();
    if (showResult) els.settingsDialog.close();
    return;
  }

  try {
    if (!window.supabase?.createClient) throw new Error('Supabase kütüphanesi yüklenemedi');
    state.supabase = window.supabase.createClient(state.settings.supabaseUrl, state.settings.supabaseKey);
    const { error } = await state.supabase.from('count_entries').select('id').limit(1);
    if (error) throw error;
    subscribeRealtime();
    updateHeaderStatus();
    await loadEntries();
    if (showResult) {
      els.settingsDialog.close();
      showToast('Ortak veritabanına bağlandı.');
    }
  } catch (error) {
    state.supabase = null;
    updateHeaderStatus();
    showToast('Veritabanına bağlanamadı: ' + friendlyError(error), true);
  }
}

function subscribeRealtime() {
  if (!state.supabase) return;
  state.realtimeChannel = state.supabase
    .channel('count-entries-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'count_entries' }, (payload) => {
      const row = payload.new || payload.old;
      if (!row?.session_name || row.session_name === state.settings.sessionName) loadEntries();
    })
    .subscribe();
}

function disconnectRealtime() {
  if (state.supabase && state.realtimeChannel) state.supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
}

function updateHeaderStatus() {
  const online = Boolean(state.supabase);
  els.databaseBadge.textContent = online ? 'Ortak veritabanı bağlı' : 'Yerel demo';
  els.databaseBadge.className = `badge ${online ? 'badge-online' : 'badge-local'}`;
  els.sessionBadge.textContent = state.settings.sessionName;
  els.summarySession.textContent = state.settings.sessionName;
}

function setLookupLoading(loading) {
  const button = els.barcodeForm.querySelector('button');
  button.disabled = loading;
  button.textContent = loading ? 'Aranıyor…' : 'Ara';
}

function setSaveLoading(loading) {
  els.saveCountButton.disabled = loading;
  els.saveCountButton.textContent = loading ? 'Kaydediliyor…' : 'Sayıma ekle';
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', error);
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3300);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mapDatabaseProduct(row) {
  return {
    barcode: row.barcode,
    name: row.name,
    brand: row.brand || '',
    imageUrl: row.image_url || '',
    source: row.source || 'database'
  };
}

function friendlyError(error) {
  return cleanText(error?.message || error?.toString() || 'Bilinmeyen hata').slice(0, 180);
}

function loadJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return parsed ?? structuredCloneSafe(fallback);
  } catch (_) {
    return structuredCloneSafe(fallback);
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function structuredCloneSafe(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
