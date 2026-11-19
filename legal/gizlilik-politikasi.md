# Gizlilik Politikası (Omni / Omni.verse)

> **TASLAK — yayından önce avukat onayı gerekir.**
>
> Bu politika, 11 Kasım 2026 itibarıyla `main` dalındaki koda ve planlanan barındırma / pazar özelliklerine göre hazırlanmıştır. Köşeli parantezleri doldurunuz. KVKK aydınlatma yükümlülüğünün asıl metni [Aydınlatma Metni](./aydinlatma-metni.md)’dir.

**Son güncelleme:** [TARİH]

## 1. Kapsam

Bu politika, WTS Studios’un (**[ŞİRKET UNVANI]**, **[ADRES]**) işlettiği Omni (Omni.verse) web uygulamasında kişisel verilerin nasıl saklandığını, korunduğunu ve çocuklara ilişkin yaklaşımı anlatır. Hizmet bir Node.js uygulamasıdır; bugün veriler sunucudaki SQLite dosyasında (`tournament.db`) durur. Canlıya çıkışta Turso (AWS Frankfurt planlanır) ve Render üzerinde barındırma planlanmaktadır.

Uygulama yedi dilde arayüz sunar (Türkçe, İngilizce, İspanyolca, Rusça, Felemenkçe, Almanca, Azerbaycan Türkçesi). Dil tercihi bir hesap verisi olarak değil, tarayıcınızdaki `omniverse_lang` kaydı olarak tutulur.

## 2. Topladığımız veriler (özet)

Aydınlatma Metni’ndeki tablo esastır. Kısa özet:

- Kayıtta: e-posta, kullanıcı adı (2–32 karakter), parola (yalnızca özet ve tuz saklanır), isteğe bağlı profil fotoğrafı, cihaz kimliği
- Doğrulamada: e-postanıza 10 dakika geçerli 6 haneli kod gönderilir; kodun kendisi değil kriptografik özeti saklanır
- Oturumda: `turnuva_session` çerezi (HttpOnly, SameSite=Strict, üretimde Secure, 30 gün)
- Oyunda: kadro, lig, maç, sanal bakiye, paket açımı ve kartlar; PR #12 birleşince pazar ilan ve satışları
- Siparişte (havale mağazası kullanılırsa): paket, tutar, referans kodu, durum. Sizin IBAN’ınız istenmez
- Güvenlikte: ban bilgileri, cihaz yasağı, yönetici işlemlerindeki şifre yeniden doğrulama denemeleri
- Konum: tema önerisi için tarayıcı konumu istenebilir; sunucuya yazılmaz
- IP: veritabanına yazılmaz; hız sınırı için bellekte kısa süre tutulur

Gerçek para ile **Hiper** paketi henüz satışa açık değildir. Bu satış başlarsa politika güncellenir; bu taslakta fiyat yoktur. Ⓞ Dolar ve Coin oyun bakiyesidir, gerçek paraya çevrilmez.

## 3. Saklama süreleri

Aşağıdaki süreler, kodda fiilen uygulananlar ile yayından önce netleştirilmesi gereken önerilerdir. “[kod]” işareti, sürelerin uygulamada bir temizlik işi ile tutulduğunu gösterir.

| Veri | Süre | Dayanak |
| --- | --- | --- |
| Bekleyen kayıt (`pending_registrations`) ve doğrulanmamış hesap | 24 saat, ardından silinir **[kod]** | `unverifiedAccountLifetime`; saatlik temizlik |
| Doğrulama kodu özeti | 10 dakika **[kod]** | `verificationLifetime` |
| Doğrulama gönderim kaydı (`verification_sends`: e-posta + zaman) | 24 saat **[kod]** | aynı temizlik işi |
| Oturum çerezi ve `user_sessions` kaydı | 30 gün. Çerez `Max-Age` 30 gündür; süresi dolmuş satırlar kullanılamaz ancak düzenli silme işi bugün yoktur | `sessionLifetime` |
| IP / hız sınırı sayaçları | Bellekte yaklaşık 10 saniye–15 dakika; sunucu yeniden başlayınca silinir **[kod]** | `authRateLimits`, `anonymousVerifyFailures`, `scryptIpHits` |
| Doğrulanmış hesap, profil, `user_data` (turnuva / takımlar), kadro, kartlar, lig üyelikleri | Hesap durduğu sürece. Kullanıcının kendi silme uç noktası henüz yoktur | Sözleşmenin ifası |
| Sanal para defteri (`coin_ledger`) ve oynanmış maçlar | Değiştirilemez kayıt olarak tutulur; hesap silinse bile defter / fikstür satırlarının kendiliğinden silinmesi kodda yoktur | Hakkın korunması, oyun bütünlüğü |
| Havale siparişleri (`orders`) | Hesap durduğu sürece; ticari defter yükümlülüğü doğarsa yasal saklama süresi (önerilen çerçeve: ilgili mevzuattaki süre, uygulamada [YASAL SAKLAMA SÜRESİ] olarak netleştirilecektir) | Sözleşme ve hukuki yükümlülük |
| Ban ve cihaz yasağı | Yasak kalkana ve meşru menfaat / hak koruma süresi dolana kadar | Güvenlik |
| Yönetici paket şifre denemesi (`admin_pack_password_attempts`) | Kilit süresi ve başarılı doğrulamaya kadar (başarıda satır silinir) **[kod]** | Güvenlik |
| Barındırma (Render) ve e-posta sağlayıcı günlükleri | Sağlayıcının politikasına göre; canlıya çıkmadan [GÜNLÜK SAKLAMA] olarak yazılacaktır | Meşru menfaat, güvenlik |
| `localStorage` (dil, tema, cihaz kimliği) | Siz silene veya tarayıcı verisini temizleyene kadar cihazınızda | Tercih ve güvenlik |

Hesap silme talebiniz yerine getirilirken, yasal saklama veya bir hakkın korunması için tutulması gereken kayıtlar (örneğin sipariş, ban gerekçesi, değiştirilemeyen maç / defter) anonimleştirilerek veya kanunî süre boyunca ayrı tutularak saklanabilir. Bu ayrım silme uç noktası yazılırken netleştirilmelidir; bugün `coin_ledger` ve bazı lig tablolarında `ON DELETE CASCADE` yoktur.

## 4. Güvenlik önlemleri

Kodda ve planda yer alan başlıca tedbirler:

- Parolalar scrypt ile özetlenir; doğrulama kodları ve oturum belirteçleri düz metin saklanmaz (HMAC / SHA-256 özeti)
- Oturum çerezi HttpOnly ve SameSite=Strict’tir; üretimde Secure bayrağı zorunludur
- Aynı köken (same-origin) denetimi, istek gövdesi boyut sınırı, hız sınırı (e-posta ve IP) uygulanır
- Yönetici paket işlemlerinde parola yeniden doğrulanır; başarısız denemede kilit vardır
- Sanal bakiyenin eksiye düşmesi veritabanı kısıtıyla engellenir; oynanmış maç satırları güncellemeye kapatılır
- Planlanan canlı ortam: HTTPS, `TRUST_PROXY` ile doğru istemci IP’si, günlük yedek, yönetici için iki adımlı doğrulama, robot doğrulama (captcha) ve eski anahtarların yenilenmesi

Hiçbir yöntem yüzde yüz güvenlik vaat etmez. Bir ihlal şüphesinde KVKK m.12 çerçevesinde gerekli bildirimler yapılır.

## 5. Çocuklar ve yaş

Uygulama bir çevrimiçi oyun ve (havale mağazası veya ileride Hiper paketi açılırsa) ödeme özelliği taşıyabilecek bir hizmettir. Doğum tarihi toplanmaz ve kayıtta yaş kontrolü yoktur; bu bir eksiktir ve yayından önce giderilmelidir.

Taslak ilke (avukat onayıyla kesinleştirilecektir):

- Hizmet **18 yaşını doldurmuş** kullanıcılara yöneliktir.
- 18 yaşından küçükler ancak veli veya vasinin bilgisi ve onayı ile hesap açabilir.
- 18 yaşından küçük olduğunu öğrendiğimiz bir hesabı, yasal olarak saklanması gereken kayıtlar saklı kalmak kaydıyla kapatırız.

## 6. Üçüncü taraflar ve yurt dışı

Aydınlatma Metni m.6 geçerlidir. Özet: e-posta bugün sizin yapılandırdığınız SMTP sunucusu üzerinden gider; Resend, Turso (Frankfurt) ve Render planlanır; captcha planlanır. Bu aktarımlar KVKK m.9’daki güvenceler tamamlanmadan canlıya alınmamalıdır.

Konum bilgisi tema önerisi için yalnızca tarayıcınızda işlenir, sunucuya gönderilmez.

## 7. Haklarınız ve başvuru

KVKK m.11 hakları ve başvuru yolu Aydınlatma Metni’nin 8. ve 9. bölümlerindedir: **[KEP/E-POSTA]**, **[ADRES]**.

Bugün kullanıcı kendi kendini silme veya veri indirme düğmesine sahip değildir. Talepler bu kanallardan işlenir.

## 8. Politika değişiklikleri

Bu politika, yeni bir işleme (örneğin captcha, Turso / Render’a geçiş, Hiper paketi, yeni rütbeler) veya mevzuat değişikliği olduğunda güncellenir. Güncel sürüm **[İNTERNET SİTESİ]** ve uygulama içinde yayımlanır. Önemli değişikliklerde e-posta veya uygulama içi duyuru ile haber verilir. Değişikliğin yürürlük tarihi metnin başındaki “Son güncelleme” satırında yazılır.

Çerez ve yerel depolama ayrıntıları için [Çerez Politikası](./cerez-politikasi.md) geçerlidir.
