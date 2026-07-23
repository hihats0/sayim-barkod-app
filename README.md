# Sayım Barkod

Telefondan barkod okutarak ortak stok sayımı yapmaya yarayan, kurulabilir PWA biçiminde MVP.

## Çalışan özellikler

- Telefon kamerasıyla EAN / UPC barkod okuma
- Barkod numarasını elle girme
- Barkodu önce ortak `products` hafızasında arama
- Açık barkod veritabanlarında bulunan ürün adını otomatik alma
- İlk kez tanınmayan raf ürününde ürün adını bir kez girme
- Girilen adla A101 Kapıda market kataloğunda arama ve en yakın ad/gramaj eşleşmesini seçme
- Bulunan A101 ürününü taranan barkoda bağlama
- Aynı barkodu sonraki okutmalarda internete çıkmadan ortak hafızadan bulma
- İlk denemede bulunamayan ürünleri tekrar-deneme kuyruğuna alma
- Uygulama açıkken kuyruğu otomatik işleme
- GitHub Actions ile uygulama kapalıyken kuyruğu 15 dakikada bir işleme
- Adet artırma / azaltma ve hızlı sayım kaydı
- Aynı barkoda ait kayıtları toplama
- Sayım adı ve sayımı yapan kişi bilgisi
- Supabase ile herkesin kullandığı ortak veritabanı
- Supabase kurulmadan cihazda çalışan yerel demo modu
- Telefona kurulabilen ve adres çubuğu olmadan açılan PWA

## Barkod öğrenme akışı

Uygulama artık binlerce spot ürünü baştan indirmez.

1. Barkod önce `products` tablosunda veya telefonun yerel ürün hafızasında aranır.
2. Kayıt yoksa açık barkod veritabanları denenir.
3. Ürün adı bulunduysa A101 Kapıda raf kataloğunda ad, marka ve gramajla eşleştirilir.
4. Barkod açık veritabanlarında yoksa kullanıcı ilk sefer ürün adını yazar ve **Yazdığım adla A101 rafında bul** düğmesine basar.
5. Bulunan A101 ürünü taranan barkoda bağlanıp `products` tablosuna yazılır.
6. Aynı barkod bir daha okutulduğunda doğrudan ortak hafızadan gelir.
7. Arama başarısızsa kayıt `product_lookup_queue` tablosunda bekler ve daha sonra yeniden denenir.

Bu yöntem bulaşık deterjanı, içecek, süt ürünü, temel gıda ve temizlik ürünü gibi genel raf ürünlerinin kullanıldıkça sisteme eklenmesi için tasarlanmıştır.

## 1. A101 raf API anahtarı

A101 resmi bir public geliştirici API'si yayımlamadığı için uygulama, public A101 Kapıda verisini sunan Parse A101 API katmanını kullanır.

1. [Parse A101 API sayfasını](https://parse.bot/marketplace/66397d30-5b86-4b47-a4d4-ddf2a0ac79ef/a101-com-tr-api) açın.
2. Ücretsiz hesap ve API anahtarı oluşturun.
3. Uygulama → Ayarlar → **A101 raf ürünleri API anahtarı** alanına anahtarı yapıştırın.
4. Mağazaya özel fiyat/stok isteniyorsa A101 mağaza kodunu girin; bilmiyorsanız boş bırakın.

Ücretsiz plan ayda 100 çağrı ve dakikada 5 çağrı sağlar. Uygulama yalnızca daha önce öğrenilmemiş yeni ürünlerde çağrı yaptığı için her barkod okutmasında kota tüketmez.

## 2. Ortak veritabanını açma veya güncelleme

1. Supabase projesinde SQL Editor bölümünü açın.
2. [`supabase.sql`](./supabase.sql) dosyasının tamamını çalıştırın. Daha önce çalıştırdıysanız `product_lookup_queue` tablosunu eklemek için dosyayı yeniden çalıştırabilirsiniz.
3. Project Settings → API bölümünden proje URL'sini ve **publishable / anon** anahtarını alın.
4. Uygulamayı açın → sağ üstteki Ayarlar → URL ve anahtarı yapıştırın → **Kaydet ve bağlan**.
5. Aynı URL ve anahtarı kullanan tüm telefonlar aynı sayımları, öğrenilmiş ürünleri ve eksik ürün kuyruğunu paylaşır.

Secret veya `service_role` anahtarını tarayıcıya koymayın.

## 3. Uygulama kapalıyken otomatik öğrenme

`.github/workflows/process-a101-lookup-queue.yml` workflow'u kuyruğu 15 dakikada bir kontrol eder ve her çalışmada bir yeni ürünü işler. Repo → Settings → Secrets and variables → Actions bölümüne şu secret'ları ekleyin:

- `SUPABASE_URL`: Supabase proje URL'si
- `SUPABASE_ANON_KEY`: Supabase publishable / anon anahtarı
- `PARSE_API_KEY`: Parse A101 API anahtarı
- `A101_STORE_ID`: İsteğe bağlı A101 mağaza kodu

Secret'lar eklenmezse workflow hata vermez; yalnızca kuyruk işlemeden çıkar. Uygulamanın telefon üzerindeki anlık öğrenme özelliği yine çalışır.

## 4. GitHub Pages

Repo içindeki workflow `main` dalındaki uygulamayı GitHub Pages'a yollar:

1. Repo → Settings → Pages
2. Source olarak **GitHub Actions** seçin.
3. Actions sekmesindeki `Deploy PWA to GitHub Pages` çalışmasını kontrol edin.

Yayın adresi:

`https://hihats0.github.io/sayim-barkod-app/`

## Veri modeli

- `products`: Barkoddan öğrenilen ortak ürün hafızası
- `product_lookup_queue`: İlk denemede bulunamayan ve tekrar aranacak ürünler
- `count_entries`: Her sayım eklemesini ayrı hareket olarak saklar
- Aynı barkodun toplamı arayüzde hareketlerin toplamından hesaplanır
- `session_name` farklı sayım dönemlerini birbirinden ayırır

## Sınırlar

- Açık barkod veritabanları bütün market ürünlerini kapsamaz. Bu nedenle bazı ürünlerde ilk sefer adın elle girilmesi gerekir.
- A101 eşleştirmesi ürün adı, marka ve gramaja dayanır; çok benzer ürünlerde adı ve gramajı eksiksiz yazmak gerekir.
- Yerel demo modunda öğrenilen ürünler yalnızca ilgili telefonda kalır. Ortak öğrenme için Supabase bağlantısı gerekir.
- Parse ücretsiz plan kotası dolarsa ürün kuyrukta kalır ve kota yenilendiğinde tekrar işlenebilir.

## Güvenlik notu

Bu MVP, talep edildiği gibi giriş yapmadan ortak erişim sağlar. SQL politikaları anonim kullanıcılara okuma ve yazma izni verir. Hassas veya kişisel veri eklemeyin. Gerçek mağaza kullanımında kullanıcı girişi, mağaza bazlı yetki ve silme/değiştirme kısıtları eklenmelidir.
