# Çerez Politikası (Omni / Omni.verse)

**Son güncelleme:** 19 Kasım 2026  
Veri sorumlusu: **WTS STUDIOS** (WTS Studios) — **Bursa/Yıldırım** — **wts.studios01@gmail.com**

## 1. Çerez ve benzeri teknolojiler

Çerez, tarayıcınıza sunucunun yazdığı küçük bir metindir. `localStorage` ise tarayıcınızın kendi belleğinde tuttuğu kayıtlardır; bunlar sunucuya her istekte kendiliğinden gitmez, uygulama gerektiğinde okur.

Omni yalnızca **zorunlu** birinci taraf kayıtlar kullanır. Analitik, reklam veya üçüncü taraf çerezi yoktur. Tek HTTP çerezi, oturum çerezi `turnuva_session`’dır. Bunun dışında tarayıcınızda tutulan birinci taraf yerel kayıtlar vardır. Bu nedenle bir çerez onay bandı veya rıza seçimi gösterilmez; bunlara ihtiyaç yoktur.

## 2. Kullandığımız kayıtlar

| Ad | Nerede | Amaç | Tür | Süre |
| --- | --- | --- | --- | --- |
| `turnuva_session` | HTTP çerezi (`Set-Cookie`) | Giriş yaptıktan sonra sizi tanımak. Değer rastgele bir oturum belirtecidir; sunucu yalnızca SHA-256 özetini oturum kaydında tutar. Özellikler: `HttpOnly`, `SameSite=Strict`, `Path=/`; üretimde `Secure`. | Zorunlu | 30 gün (`Max-Age` = 2.592.000 saniye). Çıkışta silinir (`Max-Age=0`). |
| `turnuva_device_id` | `localStorage` | Cihaz yasağını uygulamak ve aynı tarayıcıyı tanımak için üretilen rastgele kimlik. Kayıt ve girişte sunucuya gönderilir, hesap kaydınıza yazılabilir. | Zorunlu (güvenlik) | Siz silene veya tarayıcı verisini temizleyene kadar |
| `omniverse_lang` | `localStorage` | Arayüz dilini hatırlamak (tr, en, es, ru, nl, de, az). Reklam veya ölçüm için kullanılmaz. | Zorunlu / tercih | Siz silene veya tarayıcı verisini temizleyene kadar. Silinirse varsayılan dil Türkçe olur. |
| `omniverse_theme` | `localStorage` | Seçtiğiniz görsel temayı hatırlamak (verse, faroe, sweden, norway, denmark). “Otomatik” seçilirse bu anahtar silinir. Reklam veya ölçüm için kullanılmaz. | Zorunlu / tercih | Siz silene, “otomatik” seçeneğine dönene veya tarayıcı verisini temizleyene kadar. Silinirse varsayılan tema “verse” olur. |
| `tournaments_data` | `localStorage` (eski) | Eski sürümde turnuva verisi için kullanılmış olabilir. Güncel uygulama bu anahtara yazmaz; yalnızca çıkışta siler. | Kullanılmıyor | Çıkışta silinir; kalıntı varsa siz temizleyene kadar durabilir |
| `saved_teams_pool` | `localStorage` (eski) | Eski sürümde kayıtlı takımlar için kullanılmış olabilir. Güncel uygulama yazmaz; yalnızca çıkışta siler. | Kullanılmıyor | Çıkışta silinir; kalıntı varsa siz temizleyene kadar durabilir |

Reklam, ölçüm veya üçüncü taraf analitik çerezi yerleştirilmez. İleride bu tür bir araç veya robot doğrulama (captcha) eklenirse bu tablo güncellenir; gerektiğinde ayrıca rıza alınır.

Dil veya tema kaydını istemezseniz tarayıcınızın site verisi ayarından silebilirsiniz. Zorunlu oturum çerezini veya cihaz kimliğini engellerseniz giriş ve cihaz yasağı düzgün çalışmayabilir.

## 3. Konum (çerez değildir)

Tema otomatikteyken uygulama, Kuzey ülkeleri temalarından birini önermek için tarayıcınızın konumunu isteyebilir (yaklaşık konum, 8 saniye zaman aşımı). Koordinatlar **sunucuya gönderilmez** ve veritabanına yazılmaz; yalnızca cihazınızda ülke tahmini yapılır. Bu, çerez değildir. Konum izni tarayıcınızın kendi izin penceresi ile sorulur; reddedebilirsiniz. Reddederseniz varsayılan tema “verse” kullanılır.

## 4. Tarayıcıdan silme

Çoğu tarayıcıda çerez ve site verileri Ayarlar → Gizlilik yolundan silinebilir veya site bazında engellenebilir. Zorunlu oturum çerezini engellerseniz giriş yapamazsınız.

## 5. Değişiklikler

Yeni bir çerez, ölçüm aracı veya benzeri teknoloji eklenirse bu tablo güncellenir. Güncel metin **https://omni-turnuva-lig.onrender.com** adresinde yayımlanır.

Kişisel verilere ilişkin haklarınız için [Aydınlatma Metni](./aydinlatma-metni.md) ve [Gizlilik Politikası](./gizlilik-politikasi.md) geçerlidir.
