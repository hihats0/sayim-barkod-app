# Sayım Barkod

Telefondan barkod okutarak ortak stok sayımı yapmaya yarayan, kurulabilir PWA biçiminde MVP.

## Çalışan özellikler

- Telefon kamerasıyla EAN / UPC barkod okuma
- Barkod numarasını elle girme
- Open Food Facts üzerinden ürün adı, marka ve görsel arama
- İnternette bulunamayan ürünü manuel kaydetme
- Adet artırma / azaltma ve hızlı sayım kaydı
- Aynı barkoda ait kayıtları toplama
- Sayım adı ve sayımı yapan kişi bilgisi
- Supabase ile herkesin kullandığı ortak veritabanı
- Supabase kurulmadan cihazda çalışan yerel demo modu
- Telefona ana ekrana eklenebilen PWA

> Dünyadaki bütün barkodların tek ve eksiksiz açık kataloğu yoktur. MVP önce Open Food Facts'i sorgular; sonuç yoksa ürünü elle ekletir ve sonrasında ortak ürün tablosundan bulur.

## 1. Hemen çalıştırma

Statik dosyaları HTTPS üzerinden yayınlayın. Kamera, güvenlik nedeniyle HTTPS veya localhost ister.

Yerelde:

```bash
python -m http.server 8080
```

Ardından `http://localhost:8080` adresini açın. Telefon kamerası için GitHub Pages, Vercel veya benzeri HTTPS yayın kullanın.

## 2. Ortak veritabanını açma

1. Supabase'de ücretsiz bir proje oluşturun.
2. SQL Editor bölümünü açın.
3. [`supabase.sql`](./supabase.sql) dosyasının tamamını çalıştırın.
4. Project Settings → API bölümünden proje URL'sini ve **publishable / anon** anahtarını alın.
5. Uygulamayı açın → sağ üstteki Ayarlar → URL ve anahtarı yapıştırın → **Kaydet ve bağlan**.
6. Aynı URL ve anahtarı kullanan tüm telefonlar aynı sayımları görür.

Secret veya `service_role` anahtarını tarayıcıya koymayın.

## 3. GitHub Pages

Repo içindeki workflow `main` dalındaki uygulamayı GitHub Pages'a yollar. İlk kullanımda:

1. Repo → Settings → Pages
2. Source olarak **GitHub Actions** seçin.
3. Actions sekmesindeki `Deploy PWA to GitHub Pages` çalışmasını kontrol edin.

Yayın adresi genellikle:

`https://hihats0.github.io/sayim-barkod-app/`

## Veri modeli

- `products`: Barkoddan öğrenilen ürün kataloğu
- `count_entries`: Her sayım eklemesini ayrı hareket olarak saklar
- Aynı barkodun toplamı arayüzde hareketlerin toplamından hesaplanır
- `session_name` farklı sayım dönemlerini birbirinden ayırır

## Güvenlik notu

Bu MVP, talep edildiği gibi giriş yapmadan ortak erişim sağlar. SQL politikaları anonim kullanıcılara okuma ve yazma izni verir. Hassas veya kişisel veri eklemeyin. Gerçek mağaza kullanımında kullanıcı girişi, mağaza bazlı yetki ve silme/değiştirme kısıtları eklenmelidir.
