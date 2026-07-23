# Sayım Barkod

Telefondan barkod okutarak ortak stok sayımı yapmaya yarayan, kurulabilir PWA biçiminde MVP.

## Çalışan özellikler

- Telefon kamerasıyla EAN / UPC barkod okuma
- Barkod numarasını elle girme
- Bilinmeyen barkodu A101'in giriş gerektirmeyen public arama servisinde canlı sorgulama
- A101 sonucu yoksa Open Food Facts üzerinden ürün adı, marka ve görsel arama
- Bulunan ürünü yerel hafızaya veya ortak Supabase `products` tablosuna kaydetme
- Aynı barkodu sonraki okutmalarda internete çıkmadan ortak hafızadan bulma
- İlk denemede bulunamayan barkodları tekrar-deneme kuyruğuna alma
- Elle girilen ürünleri uygulama açıkken veya yeniden açıldığında A101'de tekrar arama
- Adet artırma / azaltma ve hızlı sayım kaydı
- Aynı barkoda ait kayıtları toplama
- Sayım adı ve sayımı yapan kişi bilgisi
- Supabase ile herkesin kullandığı ortak veritabanı
- Supabase kurulmadan cihazda çalışan yerel demo modu
- Telefona kurulabilen ve adres çubuğu olmadan açılan PWA

## Barkod öğrenme akışı

Uygulama artık binlerce spot ürünü baştan indirmez.

1. Barkod önce `products` tablosunda veya telefonun yerel ürün hafızasında aranır.
2. Kayıt yoksa A101'in public arama servisine tam barkod sorgusu gönderilir.
3. A101 ürünü bulunursa ad, marka, görsel ve ürün bağlantısı alınır.
4. A101 sonucu yoksa Open Food Facts denenir.
5. Bulunan ürün ortak hafızaya yazılır; aynı barkod bir daha internetten aranmaz.
6. Sonuç bulunamazsa barkod `product_lookup_queue` tablosuna veya yerel kuyruğa eklenir ve daha sonra yeniden denenir.

Bu yöntem özellikle bulaşık deterjanı, içecek, süt ürünü, temel gıda ve temizlik ürünü gibi genel raf ürünlerinin barkod okutuldukça sisteme eklenmesi için tasarlanmıştır.

## 1. Hemen çalıştırma

Statik dosyaları HTTPS üzerinden yayınlayın. Kamera, güvenlik nedeniyle HTTPS veya localhost ister.

Yerelde:

```bash
python -m http.server 8080
```

Ardından `http://localhost:8080` adresini açın. Telefon kamerası için GitHub Pages, Vercel veya benzeri HTTPS yayın kullanın.

## 2. Ortak veritabanını açma veya güncelleme

1. Supabase projesinde SQL Editor bölümünü açın.
2. [`supabase.sql`](./supabase.sql) dosyasının tamamını çalıştırın. Daha önce çalıştırdıysanız yeni `product_lookup_queue` tablosunu eklemek için dosyayı yeniden çalıştırabilirsiniz.
3. Project Settings → API bölümünden proje URL'sini ve **publishable / anon** anahtarını alın.
4. Uygulamayı açın → sağ üstteki Ayarlar → URL ve anahtarı yapıştırın → **Kaydet ve bağlan**.
5. Aynı URL ve anahtarı kullanan tüm telefonlar aynı sayımları, öğrenilmiş ürünleri ve eksik barkod kuyruğunu paylaşır.

Secret veya `service_role` anahtarını tarayıcıya koymayın.

## 3. GitHub Pages

Repo içindeki workflow `main` dalındaki uygulamayı GitHub Pages'a yollar. İlk kullanımda:

1. Repo → Settings → Pages
2. Source olarak **GitHub Actions** seçin.
3. Actions sekmesindeki `Deploy PWA to GitHub Pages` çalışmasını kontrol edin.

Yayın adresi:

`https://hihats0.github.io/sayim-barkod-app/`

## Veri modeli

- `products`: Barkoddan öğrenilen ortak ürün hafızası
- `product_lookup_queue`: İlk denemede bulunamayan ve tekrar aranacak barkodlar
- `count_entries`: Her sayım eklemesini ayrı hareket olarak saklar
- Aynı barkodun toplamı arayüzde hareketlerin toplamından hesaplanır
- `session_name` farklı sayım dönemlerini birbirinden ayırır

## Sınırlar

- A101'in public arama servisi belirli bir barkodu döndürmüyorsa ürün otomatik tanınamayabilir; bu durumda ürün elle kaydedilir ve kuyrukta yeniden denenir.
- A101'in public servis yapısı değişirse canlı sorgu kodunun güncellenmesi gerekebilir.
- Yerel demo modunda öğrenilen ürünler yalnızca ilgili telefonda kalır. Ortak öğrenme için Supabase bağlantısı gerekir.

## Güvenlik notu

Bu MVP, talep edildiği gibi giriş yapmadan ortak erişim sağlar. SQL politikaları anonim kullanıcılara okuma ve yazma izni verir. Hassas veya kişisel veri eklemeyin. Gerçek mağaza kullanımında kullanıcı girişi, mağaza bazlı yetki ve silme/değiştirme kısıtları eklenmelidir.
