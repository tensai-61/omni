# Çerez Politikası (Omni / Omni.verse)

> **TASLAK — yayından önce avukat onayı gerekir.**
>
> Tablo, 11 Kasım 2026 itibarıyla `main` dalındaki kodda fiilen bulunan çerez ve `localStorage` anahtarlarını listeler. Analitik veya reklam çerezi yoktur. Köşeli parantezleri doldurunuz.

**Son güncelleme:** [TARİH]  
Veri sorumlusu: **[ŞİRKET UNVANI]** (WTS Studios) — **[ADRES]** — **[KEP/E-POSTA]**

## 1. Çerez ve benzeri teknolojiler

Çerez, tarayıcınıza sunucunun yazdığı küçük bir metindir. `localStorage` ise tarayıcınızın kendi belleğinde tuttuğu kayıtlardır; bunlar sunucuya her istekte kendiliğinden gitmez, uygulama gerektiğinde okur.

Omni’de **tek HTTP çerezi** vardır: oturum çerezi `turnuva_session`. Bunun dışında üç aktif `localStorage` anahtarı vardır. Eski iki anahtar artık yazılmaz; çıkışta temizlenir.

## 2. Kullandığımız kayıtlar

| Ad | Nerede | Amaç | Tür | Süre |
| --- | --- | --- | --- | --- |
| `turnuva_session` | HTTP çerezi (`Set-Cookie`) | Giriş yaptıktan sonra sizi tanımak. Değer rastgele bir oturum belirtecidir; sunucu yalnızca SHA-256 özetini `user_sessions` tablosunda tutar. Özellikler: `HttpOnly`, `SameSite=Strict`, `Path=/`; üretimde `Secure`. | Zorunlu | 30 gün (`Max-Age` = 2.592.000 saniye). Çıkışta silinir (`Max-Age=0`). |
| `turnuva_device_id` | `localStorage` | Cihaz yasağını uygulamak ve aynı tarayıcıyı tanımak için üretilen rastgele kimlik. Kayıt ve girişte sunucuya gönderilir, `users.deviceId` alanına yazılabilir. | Zorunlu (güvenlik) | Siz silene veya tarayıcı verisini temizleyene kadar |
| `omniverse_lang` | `localStorage` | Arayüz dilini hatırlamak (tr, en, es, ru, nl, de, az). | İşlevsel | Siz silene veya tarayıcı verisini temizleyene kadar |
| `omniverse_theme` | `localStorage` | Seçtiğiniz görsel temayı hatırlamak (verse, faroe, sweden, norway, denmark). “Otomatik” seçilirse bu anahtar silinir. | İşlevsel | Siz silene, “otomatik” seçeneğine dönene veya tarayıcı verisini temizleyene kadar |
| `tournaments_data` | `localStorage` (eski) | Eski sürümde turnuva verisi için kullanılmış olabilir. Güncel kod bu anahtara yazmaz; yalnızca çıkışta siler. | İşlevsel (artık kullanılmıyor) | Çıkışta silinir; kalıntı varsa siz temizleyene kadar durabilir |
| `saved_teams_pool` | `localStorage` (eski) | Eski sürümde kayıtlı takımlar için kullanılmış olabilir. Güncel kod yazmaz; yalnızca çıkışta siler. | İşlevsel (artık kullanılmıyor) | Çıkışta silinir; kalıntı varsa siz temizleyene kadar durabilir |

Reklam, ölçüm veya üçüncü taraf analitik çerezi bugün yerleştirilmez. Captcha eklenirse bu tablo ve banner güncellenir; o sağlayıcının çerezleri kural olarak analitik / güvenlik kapsamında ayrıca rızaya bağlanır.

## 3. Zorunlu olmayan kayıtlar ve açık rıza

KVKK m.5/1 uyarınca, **zorunlu olmayan** (işlevsel dil ve tema; ileride eklenebilecek analitik) teknolojiler ancak **açık rızanız** ile kullanılır.

- **Zorunlu:** `turnuva_session` (giriş yapmışsanız) ve güvenlik amaçlı `turnuva_device_id`. Bunlar hesabın çalışması ve cihaz yasağının uygulanması için gerekir; banner’da “Sadece zorunlu”yi seçseniz de kullanılabilir.
- **İşlevsel (rıza gerekir):** `omniverse_lang` ve `omniverse_theme`. Rıza vermezseniz varsayılan dil Türkçe, varsayılan tema “verse” olur; tercihiniz hatırlanmaz.
- **Analitik:** şu an yok.

Rıza, aşağıdaki banner’daki seçiminizle alınır ve tarayıcınızda saklanır. Kodda henüz banner, rıza kaydı ve “Sadece zorunlu” davranışı yoktur; yayından önce eklenmelidir. Rızanızı aynı banner’daki **Ayarlar** ile her zaman değiştirebilir veya tarayıcınızın çerez / site verisi ayarından silebilirsiniz. Zorunlu olmayan işlemlere verdiğiniz rızayı geri almanız, rıza öncesi işlemi hukuka aykırı kılmaz.

## 4. Konum (çerez değildir)

Tema otomatikteyken uygulama, Kuzey ülkeleri temalarından birini önermek için tarayıcınızın konumunu isteyebilir (`navigator.geolocation`, yaklaşık konum, 8 saniye zaman aşımı). Koordinatlar **sunucuya gönderilmez** ve veritabanına yazılmaz; yalnızca cihazınızda ülke tahmini yapılır. Bu, çerez değildir. Konum işlemi zorunlu değildir ve **açık rızanıza** (tarayıcı izni + banner’daki işlevsel / konum seçimi) bağlı olmalıdır. Yayından önce konum isteği, rıza verilmeden otomatik çalışmamalıdır.

## 5. Çerez bildirim metni (banner taslağı)

Uygulamanın ilk ziyarette göstereceği kısa metin:

> **Çerezler ve yerel kayıtlar**
>
> Omni, oturumunuzu açık tutmak ve güvenliği sağlamak için zorunlu kayıtlar kullanır. Dil ve tema tercihlerinizi hatırlamak için işlevsel kayıtlar da kullanabiliriz. Konum yalnızca tema önermek içindir ve sunucuya gönderilmez. Ayrıntılar için [Çerez Politikası](/cerez-politikasi) ve [Aydınlatma Metni](/aydinlatma-metni) metinlerimize bakabilirsiniz.
>
> **[Kabul et]**  **[Sadece zorunlu]**  **[Ayarlar]**

**Ayarlar** kutusunda en az şu seçenekler bulunur:

- Zorunlu (her zaman açık; kapatılamaz)
- İşlevsel (dil ve tema) — açık / kapalı
- Konum ile tema önerisi — açık / kapalı
- Analitik — şu an kapalı ve devre dışı

**Kabul et:** zorunlu + işlevsel (+ konum, Ayarlar’da ayrı kapatılmadıysa).  
**Sadece zorunlu:** yalnızca `turnuva_session` ve `turnuva_device_id`; dil/tema hatırlanmaz, konum istenmez.

## 6. Tarayıcıdan silme

Çoğu tarayıcıda çerez ve site verileri Ayarlar → Gizlilik yolundan silinebilir veya site bazında engellenebilir. Zorunlu çerezi engellerseniz giriş yapamazsınız.

## 7. Değişiklikler

Yeni bir çerez, captcha veya ölçüm aracı eklenirse bu tablo ve banner güncellenir. Güncel metin **[İNTERNET SİTESİ]** adresinde yayımlanır.

Kişisel verilere ilişkin haklarınız için [Aydınlatma Metni](./aydinlatma-metni.md) ve [Gizlilik Politikası](./gizlilik-politikasi.md) geçerlidir.
