# Gizlilik Politikası (Omni / Omni.verse)

**Son güncelleme:** 19 Kasım 2026

## 1. Kapsam

Bu politika, WTS Studios’un (**WTS STUDIOS**, **Bursa/Yıldırım**) işlettiği Omni (Omni.verse) web uygulamasında kişisel verilerin nasıl saklandığını, korunduğunu ve çocuklara ilişkin yaklaşımı anlatır. KVKK aydınlatma yükümlülüğünün asıl metni [Aydınlatma Metni](./aydinlatma-metni.md)’dir.

Hizmet, Render üzerinde Frankfurt (Almanya) bölgesinde barındırılan bir web uygulamasıdır. Hesap ve oyun verileri Turso veritabanında, AWS eu-central-1 (Frankfurt, Almanya) bölgesinde tutulur.

Uygulama yedi dilde arayüz sunar (Türkçe, İngilizce, İspanyolca, Rusça, Felemenkçe, Almanca, Azerbaycan Türkçesi). Dil tercihi bir hesap verisi olarak değil, tarayıcınızdaki `omniverse_lang` kaydı olarak tutulur.

## 2. Topladığımız veriler (özet)

Aydınlatma Metni’ndeki tablo esastır. Kısa özet:

- Kayıtta: e-posta, kullanıcı adı (2–32 karakter), parola (yalnızca özet ve tuz saklanır), isteğe bağlı profil fotoğrafı, cihaz kimliği
- Doğrulamada: e-postanıza 10 dakika geçerli 6 haneli kod gönderilir; kodun kendisi değil kriptografik özeti saklanır
- Parola sıfırlamada: e-postanıza 30 dakika geçerli bir bağlantı gönderilir; belirtecin kendisi değil özeti saklanır
- Oturumda: `turnuva_session` çerezi (HttpOnly, SameSite=Strict, üretimde Secure, 30 gün)
- İsteğe bağlı iki adımlı doğrulamada: TOTP sırrı ve yedek kodlar
- Oyunda: kadro, lig, maç, sanal bakiye, paket açımı, kartlar, pazar ilan ve satışları
- Siparişte (havale mağazası kullanılırsa): paket, tutar, referans kodu, durum. Sizin IBAN’ınız istenmez
- Güvenlikte: ban bilgileri, cihaz yasağı, yönetici işlemlerindeki şifre yeniden doğrulama denemeleri
- Konum: tema önerisi için tarayıcı konumu istenebilir; sunucuya yazılmaz
- IP: veritabanına yazılmaz; hız sınırı için bellekte kısa süre tutulur. Barındırma sağlayıcısının erişim günlüklerinde görünebilir

Gerçek para ile **Hiper** paketi satışa açık değildir. Bu satış başlarsa politika güncellenir. Ⓞ Dolar ve Coin oyun bakiyesidir, gerçek paraya çevrilmez.

## 3. Saklama süreleri

| Veri | Süre | Dayanak |
| --- | --- | --- |
| Bekleyen kayıt ve doğrulanmamış hesap | 24 saat, ardından silinir | Kayıt tamamlanmazsa gereksiz veri tutulmaz |
| Doğrulama kodu özeti | 10 dakika | Hesap doğrulama |
| Doğrulama gönderim kaydı (e-posta ve zaman) | 24 saat | Gönderim sıklığını sınırlamak |
| Parola sıfırlama belirteci özeti | 30 dakika | Parola sıfırlama |
| Parola sıfırlama gönderim kaydı | 1 saat | Gönderim sıklığını sınırlamak |
| Oturum çerezi ve oturum kaydı | 30 gün. Çerez `Max-Age` 30 gündür; çıkışta silinir | Sözleşmenin ifası, oturum güvenliği |
| IP / hız sınırı sayaçları | Bellekte yaklaşık 10 saniye–15 dakika; sunucu yeniden başlayınca silinir | Meşru menfaat, güvenlik |
| Doğrulanmış hesap, profil, turnuva / takımlar, kadro, kartlar, lig üyelikleri | Hesap durduğu sürece. Silme talebi KVKK m. 13 uyarınca kural olarak 30 gün içinde yerine getirilir | Sözleşmenin ifası |
| Sanal para defteri ve oynanmış maçlar | Değiştirilemez kayıt olarak tutulur; hesap silinse bile oyun bütünlüğü veya bir hakkın korunması için gereken süre boyunca saklanabilir veya anonimleştirilebilir | Hakkın korunması, oyun bütünlüğü |
| Havale siparişleri | Türk Ticaret Kanunu m. 82 ve vergi mevzuatı uyarınca 10 yıl | Sözleşme ve hukuki yükümlülük |
| Ban ve cihaz yasağı | Yasak kalkana ve meşru menfaat / hak koruma süresi dolana kadar | Güvenlik |
| Yönetici paket şifre denemesi | Kilit süresi ve başarılı doğrulamaya kadar (başarıda kayıt silinir) | Güvenlik |
| Uygulama günlükleri | 90 gün | Meşru menfaat, güvenlik |
| Trafik / erişim kayıtları (barındırma sağlayıcısı günlükleri dâhil) | 5651 sayılı Kanun uyarınca 2 yıl | Hukuki yükümlülük |
| `localStorage` (dil, tema, cihaz kimliği) | Siz silene veya tarayıcı verisini temizleyene kadar cihazınızda | Tercih ve güvenlik |

Hesap silme talebiniz yerine getirilirken, yasal saklama veya bir hakkın korunması için tutulması gereken kayıtlar (örneğin sipariş, ban gerekçesi, değiştirilemeyen maç / defter) anonimleştirilerek veya kanunî süre boyunca ayrı tutularak saklanabilir.

## 4. Güvenlik önlemleri

Başvurulan başlıca tedbirler şunlardır:

- Parolalar scrypt ile özetlenir; doğrulama kodları, parola sıfırlama belirteçleri ve oturum belirteçleri düz metin saklanmaz
- Oturum çerezi HttpOnly ve SameSite=Strict’tir; üretimde Secure bayrağı zorunludur
- Bağlantı HTTPS ile sağlanır; vekil arkasında doğru istemci IP’si kullanılır
- Aynı köken (same-origin) denetimi, istek gövdesi boyut sınırı, hız sınırı (e-posta ve IP) uygulanır
- Yönetici ve moderatör hesaplarında iki adımlı doğrulama gerekir; diğer kullanıcılar da açabilir
- Yönetici paket işlemlerinde parola yeniden doğrulanır; başarısız denemede kilit vardır
- Sanal bakiyenin eksiye düşmesi veritabanı kısıtıyla engellenir; oynanmış maç satırları güncellemeye kapatılır

Hiçbir yöntem yüzde yüz güvenlik vaat etmez. Bir ihlal şüphesinde KVKK m. 12 çerçevesinde gerekli bildirimler yapılır.

## 5. Çocuklar ve yaş

Hizmet **13 yaşını doldurmuş** kullanıcılara yöneliktir.

- 13 yaşından küçükler kayıt olamaz ve hizmeti kullanamaz.
- 13–18 yaş aralığındaki kullanıcılar hizmeti ancak veli veya vasilerinin bilgisiyle kullanmalıdır.
- 13 yaşından küçük bir kullanıcı olduğunu öğrendiğimiz hesabı, yasal olarak saklanması gereken kayıtlar saklı kalmak kaydıyla kapatırız.

## 6. Üçüncü taraflar ve yurt dışı

Aydınlatma Metni m. 6 geçerlidir. Özet: uygulama Render’da (Frankfurt, Almanya), veritabanı Turso’da (AWS eu-central-1, Frankfurt, Almanya) barındırılır. İşlemsel e-postalar Brevo (Sendinblue SAS) HTTPS API’si üzerinden gönderilir; bu işlem Avrupa Birliği’ne aktarım doğurabilir. Bu aktarımlar KVKK m. 9 kapsamındadır.

Konum bilgisi tema önerisi için yalnızca tarayıcınızda işlenir, sunucuya gönderilmez.

## 7. Haklarınız ve başvuru

KVKK m. 11 hakları ve başvuru yolu Aydınlatma Metni’nin 8. ve 9. bölümlerindedir: **wts.studios01@gmail.com**, **Bursa/Yıldırım**.

Hesap silme ve verilerinizi indirme talepleriniz bu kanallardan iletilir ve KVKK m. 13 uyarınca kural olarak 30 gün içinde sonuçlandırılır.

## 8. Politika değişiklikleri

Bu politika, yeni bir işleme (örneğin yeni bir e-posta veya doğrulama sağlayıcısı, Hiper paketinin satışa açılması) veya mevzuat değişikliği olduğunda güncellenir. Güncel sürüm **https://omni-turnuva-lig.onrender.com** ve uygulama içinde yayımlanır. Önemli değişikliklerde e-posta veya uygulama içi duyuru ile haber verilir. Değişikliğin yürürlük tarihi metnin başındaki “Son güncelleme” satırında yazılır.

Çerez ve yerel depolama ayrıntıları için [Çerez Politikası](./cerez-politikasi.md) geçerlidir.
